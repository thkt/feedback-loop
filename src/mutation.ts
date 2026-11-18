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
import { keyPath, readEquivalents } from './equivalents.ts';
import type { Equivalent } from './equivalents.ts';
import type { Mutant, Parser } from './mutants.ts';
import { assertRepoRelativePath, errorMessage } from './values.ts';

/** testsは、壊し方を最初に走らせるテストである。指定がなければ全qualityで走らせる。 */
export type MutationRequest = { module: string; tests: string[] | undefined };

/** keyの壊し方1件を、testsで確かめる指定。 */
export type KeyRequest = { key: string; tests: string[] };

type Item = Omit<Mutant, 'start' | 'end'>;

/**
 * 拾わなかった壊し方の一覧。標準出力へ書くJSONの形である。
 * staleは、記録ファイルから外すか見直す記録である。killedは拾われたもの、changedは置き換える前の字が記録と違うもの、
 * not-generatedは、このモジュールで作られなくなったものと、鍵のパスのファイルが無くなったものである。
 */
export type MutationReport = {
  survived: Item[];
  timedOut: Item[];
  errors: (Item & { reason: string })[];
  stale: { key: string; reason: 'killed' | 'changed' | 'not-generated' }[];
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

type Result = { mutant: Mutant; verdict: Verdict };

async function runEach(
  ctx: Context,
  target: MutationTarget,
  found: Mutant[],
  files: string[],
  subject: string,
) {
  await target.assertNotCancelled();
  const limit = await baseline(ctx, files, subject);
  const results: Result[] = [];
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

/** 記録ファイルの記録を、pathのモジュールの今の壊し方と照らす。ほかのモジュールの記録は、鍵のパスのファイルが無いときだけ扱う。 */
function matcher(root: string, path: string, equivalents: Equivalent[]) {
  // 鍵のパスは記録ごとに1回だけ求め、ownの絞り込みとファイルの無い記録の判定を同じ結果から出す。
  const paths = new Map(equivalents.map(({ key }) => [key, keyPath(root, key)]));
  const own = new Map(
    equivalents
      .filter(({ key }) => paths.get(key) === path)
      .map(({ key, original }) => [key, original]),
  );
  return {
    // 鍵と置き換える前の字の両方が記録と一致する壊し方。すり抜けても一覧に入れない。
    isEquivalent: (mutant: Mutant) => own.get(mutant.key) === mutant.original,
    // 鍵は記録にあるが、置き換える前の字が記録と違う壊し方。記録で除かず、一覧に入れる。
    isChanged: (mutant: Mutant) => own.has(mutant.key) && own.get(mutant.key) !== mutant.original,
    /** このモジュールで作られなくなった鍵と、鍵のパスのファイルが無くなった鍵を、記録の順で返す。 */
    notGenerated(found: Mutant[]) {
      const generated = new Set(found.map(({ key }) => key));
      return equivalents
        .filter(({ key }) => (own.has(key) ? !generated.has(key) : paths.get(key) === undefined))
        .map(({ key }) => key);
    },
  };
}

type Matcher = ReturnType<typeof matcher>;

// 1件の結果を一覧へ入れる。記録と一致する壊し方は、すり抜ければ一覧から外し、拾われればstaleへ入れる。
function place(report: MutationReport, match: Matcher, { mutant, verdict }: Result) {
  if (verdict.kind === 'error') {
    report.errors.push({ ...item(mutant), reason: verdict.reason });
  } else if (match.isEquivalent(mutant)) {
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

function summarize(results: Result[], match: Matcher, notGenerated: string[]): MutationReport {
  const report: MutationReport = { survived: [], timedOut: [], errors: [], stale: [] };
  for (const result of results) {
    if (match.isChanged(result.mutant)) {
      report.stale.push({ key: result.mutant.key, reason: 'changed' });
    }
    place(report, match, result);
  }
  report.stale.push(...notGenerated.map((key) => ({ key, reason: 'not-generated' as const })));
  return report;
}

/**
 * moduleに比較・論理・条件・真偽値の壊し方を1件ずつ当て、既存のテストが拾わないものを返す。
 * request.testsがあれば、まずそのテストで走らせ、すり抜けたものだけを全qualityで確かめ直す。依存記録は書き換えない。
 * 記録ファイルにある、このモジュールの壊し方は、鍵と置き換える前の字が一致すれば、すり抜けても一覧に入れず、全qualityで確かめ直さない。
 */
export async function mutation(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: MutationRequest,
): Promise<MutationReport> {
  // 記録ファイルの形が崩れていれば、構文解析器の読み込みと分類の前に止める。
  const equivalents = readEquivalents(root);
  const ctx = { root, config, run };
  const { path, parser, quality, tests } = await prepare(ctx, request.module, request.tests);
  const match = matcher(root, path, equivalents);
  assert(quality.length > 0, '候補0件: qualityがありません');
  return guardMutation(root, path, async (target) => {
    const found = mutants(parser, path, target.source);
    console.error(`壊し方: ${found.length}件（${path}）`);
    const notGenerated = match.notGenerated(found);
    if (found.length === 0) {
      return summarize([], match, notGenerated);
    }
    await runPrepare(ctx, target);
    let results = await runEach(
      ctx,
      target,
      found,
      tests ?? quality,
      tests === undefined ? '全quality' : '渡したテスト',
    );
    // 記録と一致する壊し方は、渡したテストをすり抜けても、全qualityで確かめ直さない。
    const survivors = results.filter(
      ({ mutant, verdict }) => verdict.kind === 'survived' && !match.isEquivalent(mutant),
    );
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
    return summarize(results, match, notGenerated);
  });
}

/**
 * 鍵の壊し方1件だけを、渡したテストで確かめる。モジュールは鍵のパスから決める。
 * 壊していない状態でテストが通らないときと、鍵に当たる壊し方が今のソースから作られないときは、壊し方を当てずに止める。
 * recordedは、鍵が記録ファイルにあるかである。
 */
export async function mutationByKey(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: KeyRequest,
): Promise<{ report: KeyReport; recorded: boolean }> {
  // 記録ファイルの形が崩れていれば、構文解析器の読み込みと分類の前に止める。
  const recorded = readEquivalents(root).some(({ key }) => key === request.key);
  const module = keyPath(root, request.key);
  assert(
    module !== undefined,
    `鍵は、repoにあるファイルのパスと、関数、経路、規則、hashを':'でつなぎます: ${request.key}`,
  );
  const ctx = { root, config, run };
  const { path, parser, tests } = await prepare(ctx, module, request.tests);
  assert(tests !== undefined && tests.length > 0, '--keyで確かめるテストがありません');
  return guardMutation(root, path, async (target) => {
    const mutant = mutants(parser, path, target.source).find(({ key }) => key === request.key);
    assert(
      mutant !== undefined,
      `鍵に当たる壊し方が今の${path}から作られません: ${request.key}。壊し方を当てずに止めます`,
    );
    await runPrepare(ctx, target);
    const [result] = await runEach(ctx, target, [mutant], tests, '渡したテスト');
    assert(result !== undefined);
    const { verdict } = result;
    const report: KeyReport =
      verdict.kind === 'error'
        ? { ...item(mutant), verdict: 'error', reason: verdict.reason }
        : { ...item(mutant), verdict: verdict.kind };
    return { report, recorded };
  });
}
