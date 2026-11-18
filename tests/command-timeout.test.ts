import { expect, test } from 'bun:test';
import { AssertionError } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandRunner } from '../src/command.ts';
import { cleanRecorderEnv } from './support/runner-affected.ts';

// 監視プロセスは、正本のruntimeをBunで直接起動する。
const run = commandRunner(resolve(import.meta.dir, '../src/runtime.ts'), 'command-timeout.test.ts');

const maxTimerMs = 2 ** 31 - 1;

// 起動したら、STARTEDのパスに印のファイルを作るコマンド。
const script = "require('node:fs').writeFileSync(process.env.STARTED, '')";

/** コマンドが起動したかを、印のファイルで確かめる。 */
async function withStartedMarker(body: (env: NodeJS.ProcessEnv, started: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'command-timeout-')));
  const started = join(dir, 'started');
  try {
    await body(cleanRecorderEnv({ ...process.env, STARTED: started }), started);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('時間の上限が0以下、有限でない、またはsetTimeoutの上限を超えると、コマンドを起動せずに失敗する', async () => {
  await withStartedMarker(async (env, started) => {
    for (const invalid of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, maxTimerMs + 1]) {
      // mutationと同じく失敗を許す実行で確かめる。監視プロセスを起動していれば、監視プロセスが診断を出して終わり、ReportedFailureになる。
      const failed = await run([process.execPath, '-e', script], {
        env,
        stdout: 'ignore',
        allowFailure: true,
        timeoutMs: invalid,
      }).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(AssertionError);
      expect(String(failed)).toContain(
        `時間の上限は、0より大きく${maxTimerMs}ミリ秒以下の有限の数です`,
      );
    }
    expect(existsSync(started)).toBe(false);
  });
});

test('時間の上限がsetTimeoutの上限ちょうどなら、受け付けてコマンドを実行する', async () => {
  await withStartedMarker(async (env, started) => {
    await run([process.execPath, '-e', script], { env, stdout: 'ignore', timeoutMs: maxTimerMs });
    expect(existsSync(started)).toBe(true);
  });
}, 30000);
