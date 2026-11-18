import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { classification } from './classification.ts';
import type { Run } from './command.ts';
import { repoPath } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { guardMutation } from './mutation-guard.ts';
import type { MutationTarget } from './mutation-guard.ts';
import { runMutationTests } from './mutation-run.ts';
import type { Verdict } from './mutation-run.ts';
import { mutants } from './mutants.ts';
import { readEquivalents } from './equivalents.ts';
import type { Mutant, Parser } from './mutants.ts';
import { assertRepoRelativePath, errorMessage } from './values.ts';

/** testsは、壊し方を最初に走らせるテストである。指定がなければ全qualityで走らせる。 */
export type MutationRequest = { module: string; tests: string[] | undefined };

/** keyの壊し方1件を、testsで確かめる指定。 */
export type KeyRequest = { key: string; tests: string[] };

type Item = Omit<Mutant, 'start' | 'end'>;

/**
 * 拾わなかった壊し方の一覧。標準出力へ書くJSONの形である。
 * staleは、記録ファイルにある、このモジュールの鍵のうち、拾われたか作られなくなったものである。
 */
export type MutationReport = {
  survived: Item[];
  timedOut: Item[];
  errors: (Item & { reason: string })[];
  stale: { key: string; reason: 'killed' | 'not-generated' }[];
};

/** 壊し方1件を確かめた結果。標準出力へ書くJSONの形である。 */
export type KeyReport = Item &
  ({ verdict: Exclude<Verdict['kind'], 'error'> } | { verdict: 'error'; reason: string });

type Context = { root: string; config: FeedbackConfig; run: Run };

function loadParser(): Promise<Parser> {
  // 生成したruntimeはoxc-parserを同梱しない。導入先のnode_modulesから、この操作を実行したときに読み込む。
  return import('oxc-parser').catch((error: unknown) =>
    assert.fail(
      `oxc-parserを読み込めません。導入先のdevDependenciesに固定版で入れてください: ${errorMessage(error)}`,
    ),
  );
}

/** 渡されたパスを、rootからのパスにそろえる。repoの外と、ファイルでないパスを拒否する。 */
function repoFile(root: string, path: string, subject: string) {
  const local = repoPath(root, path);
  assertRepoRelativePath(local);
  assert(
    statSync(join(root, local), { throwIfNoEntry: false })?.isFile() ?? false,
    `${subject}がファイルではありません: ${path}`,
  );
  return local;
}

// 壊し方1件の時間の上限。StrykerJSのtimeoutFactor（1.5）とtimeoutMS（5000）の既定と同じ式である。
function limitFor(durationMs: number) {
  return Math.ceil(durationMs * 1.5) + 5000;
}

/** 壊していない状態でfilesを走らせ、壊し方1件の時間の上限を返す。通らなければ止める。 */
async function baseline(ctx: Context, files: string[], subject: string) {
  console.error(`基準の実行: ${subject} ${files.length}件`);
  const { verdict, durationMs } = await runMutationTests(ctx, files);
  assert(
    verdict.kind === 'survived',
    `壊していない状態で${subject}が通りません（${verdict.kind === 'error' ? verdict.reason : '失敗したテストがあります'}）。壊し方を当てずに止めます`,
  );
  return limitFor(durationMs);
}

async function runEach(
  ctx: Context,
  target: MutationTarget,
  found: Mutant[],
  files: string[],
  subject: string,
) {
  await target.assertNotCancelled();
  const limit = await baseline(ctx, files, subject);
  const results: { mutant: Mutant; verdict: Verdict }[] = [];
  for (const [index, mutant] of found.entries()) {
    // 壊し方を1件ずつ当てて戻すため、並行に実行しない。
    // oxlint-disable-next-line no-await-in-loop
    await target.assertNotCancelled();
    target.apply(
      target.source.slice(0, mutant.start) + mutant.replacement + target.source.slice(mutant.end),
    );
    let verdict: Verdict;
    try {
      // oxlint-disable-next-line no-await-in-loop
      verdict = (await runMutationTests(ctx, files, limit)).verdict;
    } finally {
      target.restore();
    }
    console.error(
      `壊し方 ${index + 1}/${found.length}（${subject}）: ${verdict.kind} ${mutant.key}`,
    );
    results.push({ mutant, verdict });
  }
  return results;
}

function item({ key, path, line, rule, original, replacement }: Mutant): Item {
  return { key, path, line, rule, original, replacement };
}

type Prepared = {
  path: string;
  parser: Parser;
  quality: string[];
  tests: string[] | undefined;
};

/** 対象のモジュールと渡したテストを確かめ、構文解析器とqualityをそろえる。壊し方は当てない。 */
async function prepare(
  { root, config, run }: Context,
  module: string,
  files: string[] | undefined,
): Promise<Prepared> {
  assert(config.runner === 'bun', 'mutationはBunのテストの導入先だけで使えます');
  const path = repoFile(root, module, '対象のモジュール');
  const parser = await loadParser();
  const classes = await classification(root, config, run);
  const given = files?.map((file) => {
    const local = repoFile(root, file, 'テスト');
    assert(classes.all.includes(local), `testGlobsに当たるテストではありません: ${file}`);
    return local;
  });
  // Bunは、同じファイルを2回渡すと2回走らせ、報告にも2回書く。そろえたパスで重複を除く。
  const tests = given === undefined ? undefined : [...new Set(given)];
  return { path, parser, quality: classes.quality, tests };
}

async function runPrepare({ config, run }: Context, target: MutationTarget) {
  await target.assertNotCancelled();
  if (config.prepare.length > 0) {
    await run(config.prepare, { stdout: 'ignore' });
  }
}

/** 結果を一覧へ分ける。記録した壊し方は、すり抜ければ一覧から外し、拾われればstaleへ入れる。 */
function summarize(
  results: { mutant: Mutant; verdict: Verdict }[],
  recorded: Set<string>,
  notGenerated: string[],
): MutationReport {
  const report: MutationReport = { survived: [], timedOut: [], errors: [], stale: [] };
  for (const { mutant, verdict } of results) {
    const isRecorded = recorded.has(mutant.key);
    if (verdict.kind === 'error') {
      report.errors.push({ ...item(mutant), reason: verdict.reason });
    } else if (isRecorded) {
      // 時間切れは、一覧と同じく拾ったに数える。
      if (verdict.kind !== 'survived') {
        report.stale.push({ key: mutant.key, reason: 'killed' });
      }
    } else if (verdict.kind === 'survived') {
      report.survived.push(item(mutant));
    } else if (verdict.kind === 'timedOut') {
      report.timedOut.push(item(mutant));
    }
  }
  report.stale.push(...notGenerated.map((key) => ({ key, reason: 'not-generated' as const })));
  return report;
}

/**
 * moduleに比較・論理・条件・真偽値の壊し方を1件ずつ当て、既存のテストが拾わないものを返す。
 * request.testsがあれば、まずそのテストで走らせ、すり抜けたものだけを全qualityで確かめ直す。依存記録は書き換えない。
 * 記録ファイルにある、このモジュールの壊し方は、すり抜けても一覧に入れない。拾われたものと作られなくなったものはstaleへ入れる。
 */
export async function mutation(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: MutationRequest,
): Promise<MutationReport> {
  const ctx = { root, config, run };
  const { path, parser, quality, tests } = await prepare(ctx, request.module, request.tests);
  // 記録ファイルの形が崩れていれば、壊し方を当てる前に止める。ほかのモジュールの鍵は照合しない。
  const recorded = new Set(
    readEquivalents(root)
      .map(({ key }) => key)
      .filter((key) => key.startsWith(`${path}:`)),
  );
  assert(quality.length > 0, '候補0件: qualityがありません');
  return guardMutation(root, path, async (target) => {
    const found = mutants(parser, path, target.source);
    console.error(`壊し方: ${found.length}件（${path}）`);
    const generated = new Set(found.map(({ key }) => key));
    const notGenerated = [...recorded].filter((key) => !generated.has(key));
    if (found.length === 0) {
      return summarize([], recorded, notGenerated);
    }
    await runPrepare(ctx, target);
    let results = await runEach(
      ctx,
      target,
      found,
      tests ?? quality,
      tests === undefined ? '全quality' : '渡したテスト',
    );
    const survivors = results.filter(({ verdict }) => verdict.kind === 'survived');
    if (tests !== undefined && survivors.length > 0) {
      const rechecked = await runEach(
        ctx,
        target,
        survivors.map(({ mutant }) => mutant),
        quality,
        '全quality',
      );
      const byKey = new Map(rechecked.map((result) => [result.mutant.key, result]));
      results = results.map((result) => byKey.get(result.mutant.key) ?? result);
    }
    return summarize(results, recorded, notGenerated);
  });
}

/**
 * 鍵の壊し方1件だけを、渡したテストで確かめる。モジュールは鍵の先頭のパスから決める。
 * 壊していない状態でテストが通らないときと、鍵に当たる壊し方が今のソースから作られないときは、壊し方を当てずに止める。
 */
export async function mutationByKey(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: KeyRequest,
): Promise<KeyReport> {
  const separator = request.key.indexOf(':');
  assert(separator > 0, `鍵の先頭にモジュールのパスがありません: ${request.key}`);
  const ctx = { root, config, run };
  const { path, parser, tests } = await prepare(
    ctx,
    request.key.slice(0, separator),
    request.tests,
  );
  return guardMutation(root, path, async (target) => {
    const mutant = mutants(parser, path, target.source).find(({ key }) => key === request.key);
    assert(
      mutant !== undefined,
      `鍵に当たる壊し方が今の${path}から作られません: ${request.key}。壊し方を当てずに止めます`,
    );
    await runPrepare(ctx, target);
    const [result] = await runEach(ctx, target, [mutant], tests ?? [], '渡したテスト');
    assert(result !== undefined);
    const { verdict } = result;
    return verdict.kind === 'error'
      ? { ...item(mutant), verdict: 'error', reason: verdict.reason }
      : { ...item(mutant), verdict: verdict.kind };
  });
}
