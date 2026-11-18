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
import type { Mutant, Parser } from './mutants.ts';
import { assertRepoRelativePath, errorMessage } from './values.ts';

/** testsは、壊し方を最初に走らせるテストである。指定がなければ全qualityで走らせる。 */
export type MutationRequest = { module: string; tests: string[] | undefined };

type Item = Omit<Mutant, 'start' | 'end'>;

/** 拾わなかった壊し方の一覧。標準出力へ書くJSONの形である。 */
export type MutationReport = {
  survived: Item[];
  timedOut: Item[];
  errors: (Item & { reason: string })[];
};

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

/**
 * moduleに比較・論理・条件・真偽値の壊し方を1件ずつ当て、既存のテストが拾わないものを返す。
 * request.testsがあれば、まずそのテストで走らせ、すり抜けたものだけを全qualityで確かめ直す。依存記録は書き換えない。
 */
export async function mutation(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: MutationRequest,
): Promise<MutationReport> {
  assert(config.runner === 'bun', 'mutationはBunのテストの導入先だけで使えます');
  const path = repoFile(root, request.module, '対象のモジュール');
  const parser = await loadParser();
  const classes = await classification(root, config, run);
  const tests = request.tests?.map((file) => {
    const local = repoFile(root, file, 'テスト');
    assert(classes.all.includes(local), `testGlobsに当たるテストではありません: ${file}`);
    return local;
  });
  assert(classes.quality.length > 0, '候補0件: qualityがありません');
  const ctx = { root, config, run };
  return guardMutation(root, path, async (target) => {
    await target.assertNotCancelled();
    if (config.prepare.length > 0) {
      await run(config.prepare, { captureStdout: true });
    }
    const found = mutants(parser, path, target.source);
    console.error(`壊し方: ${found.length}件（${path}）`);
    let results = await runEach(
      ctx,
      target,
      found,
      tests ?? classes.quality,
      tests === undefined ? '全quality' : '渡したテスト',
    );
    const survivors = results.filter(({ verdict }) => verdict.kind === 'survived');
    if (tests !== undefined && survivors.length > 0) {
      const rechecked = await runEach(
        ctx,
        target,
        survivors.map(({ mutant }) => mutant),
        classes.quality,
        '全quality',
      );
      const byKey = new Map(rechecked.map((result) => [result.mutant.key, result]));
      results = results.map((result) => byKey.get(result.mutant.key) ?? result);
    }
    const report: MutationReport = { survived: [], timedOut: [], errors: [] };
    for (const { mutant, verdict } of results) {
      if (verdict.kind === 'survived') {
        report.survived.push(item(mutant));
      } else if (verdict.kind === 'timedOut') {
        report.timedOut.push(item(mutant));
      } else if (verdict.kind === 'error') {
        report.errors.push({ ...item(mutant), reason: verdict.reason });
      }
    }
    return report;
  });
}
