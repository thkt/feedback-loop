import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasErrorCode, isRecord } from '../../src/values.ts';
import { baseEnv, setup } from './feedback-loop-batch.ts';
import type { Fixture } from './feedback-loop-batch.ts';

// 導入が生成するtest:affectedの中身。取消は、外側のbun runやnpm runではなく実行部へ送る。
export const bunRuntime = [
  process.execPath,
  '--no-env-file',
  'scripts/feedback-loop/runtime.mjs',
  'affected',
];
export const nodeRuntime = ['node', 'scripts/feedback-loop/runtime.mjs', 'affected'];

export function applyCommand(f: Fixture) {
  return [
    process.execPath,
    setup,
    'apply',
    '--repo',
    f.repo,
    '--feedback-command',
    'bun run test:affected',
  ];
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert(hasErrorCode(error, 'ESRCH'), String(error));
    return false;
  }
}

function forceKill(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    assert(hasErrorCode(error, 'ESRCH'), String(error));
  }
}

export async function waitFor(condition: () => boolean, message: () => string, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    assert(performance.now() < deadline, message());
    await Bun.sleep(10);
  }
}

/**
 * argvを別のプロセスグループで起動し、取消対象の処理へ到達してから取り消す。
 * 取消対象の処理は、CANCEL_TRACEのファイルへ自分と親のPIDを書いて待ち続けるフィクスチャである。
 * howは、実行部へSIGTERMを送るか、ホストがするようにプロセスグループを強制終了するかを表す。
 * 出力のpipeが閉じ、取消対象の処理とその親のPIDが消えるまで待つ。
 */
export async function cancelWhenReached(
  f: Fixture,
  argv: string[],
  how: 'SIGTERM' | 'group SIGKILL',
  env: NodeJS.ProcessEnv = {},
) {
  const [executable, ...args] = argv;
  assert(executable);
  const trace = join(f.signals, 'cancel-trace.json');
  const child = spawn(executable, args, {
    cwd: f.repo,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...baseEnv(f),
      CANCEL_TRACE: trace,
      CANCEL_STARTED: join(f.signals, 'test-started'),
      ...env,
    },
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  let code: number | null | undefined;
  let closed = false;
  const ended = new Promise<void>((done, fail) => {
    child.once('close', (status) => {
      code = status;
      closed = true;
      done();
    });
    child.once('error', fail);
  });
  const traced: number[] = [];
  try {
    // 書込み側はファイルを作ってから内容を書くため、空の間は読みません。
    await waitFor(
      () => existsSync(trace) && statSync(trace).size > 0,
      () => `取消対象の処理へ到達しません: ${output}`,
    );
    const observed: unknown = JSON.parse(readFileSync(trace, 'utf8'));
    assert(
      isRecord(observed) &&
        typeof observed.child === 'number' &&
        typeof observed.parent === 'number',
    );
    traced.push(observed.child, observed.parent);
    const aliveBefore = traced.map(alive);
    assert(child.pid !== undefined);
    if (how === 'SIGTERM') {
      child.kill('SIGTERM');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
    await waitFor(
      () => closed,
      () =>
        `取消後も出力のpipeが閉じません。生存PID: ${JSON.stringify(traced.filter(alive))}: ${output}`,
    );
    // pipeのcloseとPIDの消滅は同時ではありません。追加のkillはせず、
    // 製品の強制終了猶予と同じ1秒を上限に、OSによる終了処理を確認します。
    await waitFor(
      () => traced.every((pid) => !alive(pid)),
      () => `pipe閉鎖後も起動した処理が残っています: ${JSON.stringify(traced.filter(alive))}`,
      1000,
    );
    return { code, output, aliveBefore };
  } finally {
    // 終了を確認できた場合は、消滅中のグループへ再度killを送りません。
    if (!closed || traced.some(alive)) {
      for (const pid of [...traced, ...(child.pid === undefined ? [] : [child.pid])]) {
        forceKill(-pid);
        forceKill(pid);
      }
    }
    await ended;
    await waitFor(
      () => traced.every((pid) => !alive(pid)),
      () => 'テストの後始末で子プロセスが残りました',
    );
  }
}
