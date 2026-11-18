import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CommandTimedOut, ReportedFailure, commandRunner } from '../src/command.ts';
import { alive, forceKill } from './support/feedback-loop-cancellation.ts';
import { cleanRecorderEnv } from './support/runner-affected.ts';

// 監視プロセスは、正本のruntimeをBunで直接起動する。
const run = commandRunner(resolve(import.meta.dir, '../src/runtime.ts'), 'command.test.ts');

/**
 * 別のプロセスグループで30秒眠る孫を起動し、そのPIDをGRANDCHILD_PIDSのファイルへ追記するスクリプト。
 * 孫は、コマンドの標準出力（stdout）か標準エラー（stderr）を開いたままにする。
 */
function spawnGrandchild(holds: 'stdout' | 'stderr') {
  const stdio =
    holds === 'stdout' ? "['ignore', 'inherit', 'ignore']" : "['ignore', 'ignore', 'inherit']";
  return `const child = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: ${stdio} });
child.unref();
require('node:fs').appendFileSync(process.env.GRANDCHILD_PIDS, child.pid + '\\n');
`;
}

/** 標準エラーを開いたままの孫を残し、標準エラーへ1行書いて、codeで終わるスクリプト。 */
function exitWithStderr(code: number) {
  return `${spawnGrandchild('stderr')}process.stderr.write('コマンドの標準エラー\\n');\nprocess.exitCode = ${code};`;
}

/** 孫は実行部が止めないため、テストの後で止める。 */
async function withGrandchildren(
  body: (env: NodeJS.ProcessEnv, pids: () => number[]) => Promise<void>,
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'command-')));
  const file = join(dir, 'grandchild.pids');
  const pids = () =>
    existsSync(file)
      ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number)
      : [];
  try {
    await body(cleanRecorderEnv({ ...process.env, GRANDCHILD_PIDS: file }), pids);
  } finally {
    pids().forEach(forceKill);
    await rm(dir, { recursive: true, force: true });
  }
}

test('終わったコマンドの標準エラーを孫が開いたままでも、孫を待たずにコマンドの終了コードと出力で終える', async () => {
  await withGrandchildren(async (env, pids) => {
    const output = await run([process.execPath, '-e', exitWithStderr(0)], {
      env,
      stdout: 'ignore',
    });
    expect(output.stderr).toContain('コマンドの標準エラー\n');
    expect(output.stderr).toContain('別のプロセスが出力のpipeを開いたままのため');
    // 終了コードが失敗のコマンドは、pipeを待つのをやめた後も失敗になる。
    const failed = await run([process.execPath, '-e', exitWithStderr(3)], {
      env,
      stdout: 'ignore',
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ReportedFailure);
    expect(pids()).toHaveLength(2);
    expect(pids().every(alive)).toBe(true);
  });
}, 30000);

test('上限より前に終わったコマンドは、受け取る標準出力を孫が開いたままでも、孫を待たず、時間切れにもしない', async () => {
  await withGrandchildren(async (env, pids) => {
    // 上限（2000ミリ秒）の500ミリ秒前に終わる。上限は、pipeが閉じるのを待つ間（1000ミリ秒）に来る。
    const script = `${spawnGrandchild('stdout')}process.stdout.write('コマンドの標準出力\\n');
setTimeout(() => {}, Number(process.env.EXIT_AT) - Date.now());`;
    const output = await run([process.execPath, '-e', script], {
      env: { ...env, EXIT_AT: String(Date.now() + 1500) },
      stdout: 'capture',
      timeoutMs: 2000,
    });
    expect(output.stdout).toBe('コマンドの標準出力\n');
    expect(pids()).toHaveLength(1);
    expect(pids().every(alive)).toBe(true);
  });
}, 30000);

test('SIGTERMを無視するコマンドの標準エラーを孫が開いたままでも、上限を過ぎたら孫を待たずに時間切れで終える', async () => {
  await withGrandchildren(async (env, pids) => {
    const script = `process.on('SIGTERM', () => {});
${spawnGrandchild('stderr')}setInterval(() => {}, 1000);`;
    const timedOut = await run([process.execPath, '-e', script], {
      env,
      stdout: 'ignore',
      timeoutMs: 2000,
    }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(CommandTimedOut);
    expect(pids()).toHaveLength(1);
    expect(pids().every(alive)).toBe(true);
  });
}, 30000);
