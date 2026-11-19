import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { junitCount, readBunSuites } from './bun-report.ts';
import { bunTestArgv } from './bun.ts';
import { CommandTimedOut } from './command.ts';
import type { Run } from './command.ts';
import { repoPath } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { assertObject, errorMessage, hasErrorCode, isRecord } from './values.ts';
import { excludePattern, vitestCli } from './vitest.ts';

/** 壊し方1件の結果。killedは、渡したテストのどれかが期待値の不一致などで落ちたことを表す。 */
export type Verdict =
  | { kind: 'killed' }
  | { kind: 'survived' }
  | { kind: 'timedOut' }
  | { kind: 'error'; reason: string };

export type MutationContext = { root: string; config: FeedbackConfig; run: Run; all: string[] };

function error(reason: string): Verdict {
  return { kind: 'error', reason };
}

type Summary = { files: Set<string>; unloaded: string[]; executed: number; failed: number };

/**
 * JUnitの報告を読む。件数が欠けているか数字でなければ投げる。
 * Bunは、読み込みに失敗したテストファイルを報告に載せない。テストの外で起きた未処理のエラーは、失敗として載せる。
 */
function bunSummary(root: string, text: string): Summary {
  const { report, suites } = readBunSuites(text, root);
  return {
    files: new Set(suites.keys()),
    unloaded: [],
    executed: junitCount(report, 'tests') - junitCount(report, 'skipped'),
    // Bunは、全体のerrorsを書かない。
    failed: junitCount(report, 'failures') + junitCount(report, 'errors', '0'),
  };
}

function vitestCount(result: Record<string, unknown>, name: string) {
  const value = result[name];
  assert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    `Vitestの${name}が不正です`,
  );
  return value;
}

function vitestSummary(root: string, text: string): Summary {
  const result: unknown = JSON.parse(text);
  assertObject(result);
  assert(Array.isArray(result.testResults), 'Vitestのファイル結果がありません');
  const files = new Set<string>();
  const unloaded: string[] = [];
  let hookFailed = 0;
  for (const item of result.testResults) {
    assertObject(item);
    assert(typeof item.name === 'string', 'Vitest結果のファイル名が不正です');
    assert(Array.isArray(item.assertionResults), 'Vitest結果のテストの一覧がありません');
    const path = repoPath(root, item.name);
    files.add(path);
    const message = typeof item.message === 'string' ? item.message : '';
    if (message !== '' && item.assertionResults.length === 0) {
      unloaded.push(path);
    } else if (
      item.status === 'failed' &&
      !item.assertionResults.some((test) => isRecord(test) && test.status === 'failed')
    ) {
      hookFailed++;
    }
  }
  const failed = vitestCount(result, 'numFailedTests') + hookFailed;
  return { files, unloaded, executed: vitestCount(result, 'numPassedTests') + failed, failed };
}

function excludeUngivenTests(root: string, all: string[], files: string[]) {
  return all.flatMap((file) =>
    files.includes(file) ? [] : ['--exclude', excludePattern(root, file)],
  );
}

const runners = {
  bun: {
    report: 'results.xml',
    argv: ({ config }: MutationContext, files: string[], report: string) =>
      bunTestArgv(config, files, report),
    summarize: bunSummary,
  },
  vitest: {
    report: 'results.json',
    argv: ({ root, config, all }: MutationContext, files: string[], report: string) => [
      process.execPath,
      vitestCli(root),
      'run',
      ...files,
      ...config.testArgs,
      ...excludeUngivenTests(root, all, files),
      '--no-cache',
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    summarize: vitestSummary,
  },
} satisfies Record<FeedbackConfig['runner'], unknown>;

function verdict(
  root: string,
  files: string[],
  text: string | undefined,
  summarize: (root: string, text: string) => Summary,
): Verdict {
  if (text === undefined) {
    return error('テストの結果の報告がありません');
  }
  let summary: Summary;
  try {
    summary = summarize(root, text);
  } catch (reason) {
    return error(`テストの結果の報告を読めません: ${errorMessage(reason)}`);
  }
  const extra = [...summary.files].filter((file) => !files.includes(file));
  if (extra.length > 0) {
    return error(`渡していないテストファイルが結果にあります: ${extra.join(', ')}`);
  }
  if (summary.unloaded.length > 0) {
    return error(`読み込みに失敗したテストファイルがあります: ${summary.unloaded.join(', ')}`);
  }
  const missing = files.filter((file) => !summary.files.has(file));
  if (missing.length > 0) {
    return error(`報告にないテストファイルがあります（読み込みの失敗など）: ${missing.join(', ')}`);
  }
  if (!(summary.executed > 0)) {
    return error('実行したテストが0件です');
  }
  return summary.failed > 0 ? { kind: 'killed' } : { kind: 'survived' };
}

async function readReport(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (reason) {
    if (hasErrorCode(reason, 'ENOENT')) {
      return undefined;
    }
    throw reason;
  }
}

/**
 * filesのテストを1回実行し、結果とかかった時間を返す。依存記録は読まず、書かない。
 * timeoutMsを過ぎたら止めて時間切れとする。取消など、ほかの理由で止まった実行は、そのまま投げる。
 */
export async function runMutationTests(
  ctx: MutationContext,
  files: string[],
  timeoutMs?: number,
): Promise<{ verdict: Verdict; durationMs: number }> {
  const { root, config, run } = ctx;
  // 前の実行の報告を読まないよう、実行ごとに報告の置き場を作る。
  const dir = await mkdtemp(join(tmpdir(), 'feedback-loop-mutation-'));
  try {
    const runner = runners[config.runner];
    const report = join(dir, runner.report);
    const argv = runner.argv(ctx, files, report);
    const started = performance.now();
    try {
      // 標準出力には一覧のJSONだけを書くため、テストの標準出力は捨てる。ため込まないので、量が多くても実行を止めない。
      await run(argv, { cwd: root, stdout: 'ignore', allowFailure: true, timeoutMs });
    } catch (reason) {
      if (reason instanceof CommandTimedOut) {
        return { verdict: { kind: 'timedOut' }, durationMs: performance.now() - started };
      }
      throw reason;
    }
    const durationMs = performance.now() - started;
    return {
      verdict: verdict(root, files, await readReport(report), runner.summarize),
      durationMs,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
