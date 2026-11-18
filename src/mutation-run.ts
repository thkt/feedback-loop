import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { junitCount, readBunSuites } from './bun-report.ts';
import { bunTestArgv } from './bun.ts';
import { CommandTimedOut } from './command.ts';
import type { Run } from './command.ts';
import type { FeedbackConfig } from './config.ts';
import { errorMessage, hasErrorCode } from './values.ts';

/** 壊し方1件の結果。killedは、渡したテストのどれかが期待値の不一致などで落ちたことを表す。 */
export type Verdict =
  | { kind: 'killed' }
  | { kind: 'survived' }
  | { kind: 'timedOut' }
  | { kind: 'error'; reason: string };

type MutationContext = { root: string; config: FeedbackConfig; run: Run };

function error(reason: string): Verdict {
  return { kind: 'error', reason };
}

/** 報告を読み、テストファイルの一覧と全体の件数を返す。件数が欠けているか数字でなければ投げる。 */
function readReportCounts(root: string, text: string) {
  const { report, suites } = readBunSuites(text, root);
  return {
    suites,
    tests: junitCount(report, 'tests'),
    skipped: junitCount(report, 'skipped'),
    failures: junitCount(report, 'failures'),
    // Bunは、全体のerrorsを書かない。
    errors: junitCount(report, 'errors', '0'),
  };
}

/**
 * JUnitの報告から結果を判定する。
 * Bunは、読み込みに失敗したテストファイルを報告に載せない。テストの外で起きた未処理のエラーは、失敗として載せる。
 */
function verdict(root: string, files: string[], text: string | undefined): Verdict {
  if (text === undefined) {
    return error('テストの結果の報告がありません');
  }
  let parsed: ReturnType<typeof readReportCounts>;
  try {
    parsed = readReportCounts(root, text);
  } catch (reason) {
    return error(`テストの結果の報告を読めません: ${errorMessage(reason)}`);
  }
  const missing = files.filter((file) => !parsed.suites.has(file));
  if (missing.length > 0) {
    return error(`報告にないテストファイルがあります（読み込みの失敗など）: ${missing.join(', ')}`);
  }
  const { tests, skipped, failures, errors } = parsed;
  if (!(tests - skipped > 0)) {
    return error('実行したテストが0件です');
  }
  return failures + errors > 0 ? { kind: 'killed' } : { kind: 'survived' };
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
  { root, config, run }: MutationContext,
  files: string[],
  timeoutMs?: number,
): Promise<{ verdict: Verdict; durationMs: number }> {
  // 前の実行の報告を読まないよう、実行ごとに報告の置き場を作る。
  const dir = await mkdtemp(join(tmpdir(), 'feedback-loop-mutation-'));
  try {
    const report = join(dir, 'results.xml');
    const argv = bunTestArgv(config, files, report);
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
    return { verdict: verdict(root, files, await readReport(report)), durationMs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
