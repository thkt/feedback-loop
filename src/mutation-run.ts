import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elements, junitCount, readBunSuites, testcases } from './bun-report.ts';
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

type Summary = {
  files: Set<string>;
  unloaded: string[];
  incomplete: string[];
  executed: number;
  failed: number;
};

function isWorkerCrash(test: Bun.XML.Node) {
  return (
    test.attributes.name === '(worker crashed)' &&
    elements(test, 'failure').some(
      (failure) => failure.attributes.message === 'worker process crashed before reporting results',
    )
  );
}

/**
 * JUnitの報告を読む。件数が欠けているか数字でなければ投げる。
 * Bunは、読み込みに失敗したテストファイルを報告に載せない。テストの外で起きた未処理のエラーは、失敗として載せる。
 */
function bunSummary(root: string, text: string): Summary {
  const { report, suites } = readBunSuites(text, root);
  const incomplete: string[] = [];
  let crashes = 0;
  for (const [path, suite] of suites) {
    const crashed = testcases(suite).filter(isWorkerCrash).length;
    if (crashed > 0) {
      incomplete.push(path);
      crashes += crashed;
    }
  }
  return {
    files: new Set(suites.keys()),
    unloaded: [],
    incomplete,
    executed: junitCount(report, 'tests') - junitCount(report, 'skipped'),
    // Bunは、全体のerrorsを書かない。
    failed: junitCount(report, 'failures') + junitCount(report, 'errors', '0') - crashes,
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
  const incomplete: string[] = [];
  let hookFailed = 0;
  for (const item of result.testResults) {
    assertObject(item);
    assert(typeof item.name === 'string', 'Vitest結果のファイル名が不正です');
    assert(Array.isArray(item.assertionResults), 'Vitest結果のテストの一覧がありません');
    const path = repoPath(root, item.name);
    files.add(path);
    const tests = item.assertionResults;
    if (tests.length === 0) {
      unloaded.push(path);
      continue;
    }
    if (tests.some((test) => isRecord(test) && test.status === 'pending')) {
      incomplete.push(path);
    }
    if (
      item.status === 'failed' &&
      !tests.some((test) => isRecord(test) && test.status === 'failed')
    ) {
      hookFailed++;
    }
  }
  const failed = vitestCount(result, 'numFailedTests') + hookFailed;
  return {
    files,
    unloaded,
    incomplete,
    executed: vitestCount(result, 'numPassedTests') + failed,
    failed,
  };
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
  allowNoTests: boolean,
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
  if (summary.failed > 0) {
    return { kind: 'killed' };
  }
  const reason = unfinishedReason(files, summary);
  if (reason !== undefined) {
    return error(reason);
  }
  if (!(summary.executed > 0) && !allowNoTests) {
    return error('実行したテストが0件です');
  }
  return { kind: 'survived' };
}

function unfinishedReason(files: string[], summary: Summary) {
  if (summary.unloaded.length > 0) {
    return `読み込みに失敗したテストファイルがあります: ${summary.unloaded.join(', ')}`;
  }
  const missing = files.filter((file) => !summary.files.has(file));
  if (missing.length > 0) {
    return `報告にないテストファイルがあります（読み込みの失敗など）: ${missing.join(', ')}`;
  }
  if (summary.incomplete.length > 0) {
    return `最後まで走らなかったテストか、workerの終わりがあるテストファイルがあります: ${summary.incomplete.join(', ')}`;
  }
  return undefined;
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
  {
    timeoutMs,
    assertNotCancelled,
    allowNoTests = false,
  }: { timeoutMs?: number; assertNotCancelled: () => Promise<void>; allowNoTests?: boolean },
): Promise<{ verdict: Verdict; durationMs: number }> {
  const { root, config, run } = ctx;
  // 前の実行の報告を読まないよう、実行ごとに報告の置き場を作る。
  const dir = await mkdtemp(join(tmpdir(), 'feedback-loop-mutation-'));
  try {
    const runner = runners[config.runner];
    const report = join(dir, runner.report);
    const argv = runner.argv(ctx, files, report);
    await assertNotCancelled();
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
      verdict: verdict(root, files, await readReport(report), runner.summarize, allowNoTests),
      durationMs,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
