import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandRunner, countLiveMembers, signalProcessGroup } from '../src/command.ts';
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

function denyWithEperm(): never {
  throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
}

async function reapedGroup() {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await once(child, 'close');
  assert(child.pid !== undefined);
  return child.pid;
}

test('グループへのシグナルがEPERMで拒まれても、グループに生きているプロセスが無ければ、グループはもう無いとして失敗にしない', async () => {
  const pgid = await reapedGroup();
  expect(signalProcessGroup(pgid, 'SIGKILL', denyWithEperm)).toBeUndefined();
});

test('グループへのシグナルがEPERMで拒まれ、グループに生きているプロセスがあれば、そのEPERMを失敗として残す', async () => {
  const sleeper = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    assert(sleeper.pid !== undefined);
    const failure = signalProcessGroup(sleeper.pid, 'SIGTERM', denyWithEperm);
    expect(String(failure?.error)).toBe('Error: kill EPERM');
  } finally {
    sleeper.kill('SIGKILL');
  }
});

test('グループへのシグナルがEPERMで拒まれ、psを起動できないか非ゼロで終われば、psを読めないことを添えて失敗として残す', async () => {
  const pgid = await reapedGroup();
  const dir = await mkdtemp(join(tmpdir(), 'command-timeout-path-'));
  const path = process.env.PATH;
  process.env.PATH = dir;
  try {
    expect(String(signalProcessGroup(pgid, 'SIGKILL', denyWithEperm)?.error)).toMatch(
      /^Error: kill EPERM。プロセスの一覧を読めません: .*\bps\b/,
    );
    await writeFile(join(dir, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(String(signalProcessGroup(pgid, 'SIGKILL', denyWithEperm)?.error)).toMatch(
      /^Error: kill EPERM。プロセスの一覧を読めません: psが1で終わりました/,
    );
  } finally {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});

test('グループへのシグナルがEPERMとESRCHのほかのエラーで拒まれれば、グループに生きているプロセスが無くても失敗として残す', async () => {
  const pgid = await reapedGroup();
  const failure = signalProcessGroup(pgid, 'SIGKILL', () => {
    throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' });
  });
  expect(String(failure?.error)).toBe('Error: kill EINVAL');
});

test('psの出力から、そのグループのzombieでないプロセスだけを数える', () => {
  const processList = [
    '  100   100 Ss  ',
    '  101   100 R+  ',
    '  102   100 Z   ',
    '  103   100 Z+  ',
    '  200   200 S   ',
    '',
  ].join('\n');
  expect(countLiveMembers(processList, 100)).toBe(2);
  expect(countLiveMembers(processList, 200)).toBe(1);
  expect(countLiveMembers('  102   100 Z   \n  103   100 Z+  \n', 100)).toBe(0);
  expect(countLiveMembers(processList, 300)).toBe(0);
});
