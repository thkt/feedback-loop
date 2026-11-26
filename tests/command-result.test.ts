import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ReportedFailure,
  commandRunner,
  countLiveMembers,
  graceMs,
  signalProcessGroup,
} from '../src/command.ts';
import { runWithPipedStdout, runnerHeader } from './support/command-runner.ts';
import { cleanRecorderEnv } from './support/runner-affected.ts';

// 監視プロセスは、正本のruntimeをBunで直接起動する。
const run = commandRunner(resolve(import.meta.dir, '../src/runtime.ts'), 'command-result.test.ts');

test('コマンドが0以外の終了コードで終わると、その終了コードを示して失敗する', async () => {
  const written = spyOn(process.stderr, 'write');
  try {
    const failed = await run([process.execPath, '-e', 'process.exitCode = 3'], {
      env: cleanRecorderEnv(process.env),
      stdout: 'ignore',
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ReportedFailure);
    expect(written.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      '検査失敗または取消: 3\n',
    );
  } finally {
    written.mockRestore();
  }
});

async function runKilledBy(signal: NodeJS.Signals, allowFailure: boolean) {
  const written = spyOn(process.stderr, 'write');
  try {
    const failed = await run([process.execPath, '-e', `process.kill(process.pid, '${signal}')`], {
      env: cleanRecorderEnv(process.env),
      stdout: 'ignore',
      allowFailure,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    return { failed, stderr: written.mock.calls.map(([chunk]) => String(chunk)).join('') };
  } finally {
    written.mockRestore();
  }
}

test('失敗を許さない実行でコマンドがシグナルで終わるときと、失敗を許す実行でコマンドがSIGTERMで終わるときは、そのシグナルを示して失敗する', async () => {
  for (const { signal, allowFailure } of [
    { signal: 'SIGKILL', allowFailure: false },
    { signal: 'SIGTERM', allowFailure: true },
  ] as const) {
    const killed = await runKilledBy(signal, allowFailure);
    expect(killed.failed).toBeInstanceOf(ReportedFailure);
    expect(killed.stderr).toContain(`検査失敗または取消: ${signal}\n`);
    expect(killed.stderr).not.toContain(`コマンドが${signal}で終わりました`);
  }
});

test('失敗を許す実行でコマンドが取消のシグナルでないシグナルで終わると、失敗にせず、シグナルを示す行を1行表示する', async () => {
  const killed = await runKilledBy('SIGKILL', true);
  expect(killed.failed).toBeUndefined();
  expect(killed.stderr.match(/コマンドがSIGKILLで終わりました\n/g)).toHaveLength(1);
  expect(killed.stderr).not.toContain('検査失敗または取消');
});

test('収集した出力が64MiBを超えたら、コマンドの終了を待たずに止めて失敗する', async () => {
  const startedAt = Date.now();
  const failed = await run(
    [
      process.execPath,
      '-e',
      "process.stdout.write('x'.repeat(65 * 1024 * 1024), () => setTimeout(() => {}, 30000))",
    ],
    { env: cleanRecorderEnv(process.env), stdout: 'capture' },
  ).catch((error: unknown) => error);
  expect(String(failed)).toContain('テスト収集の出力が64MiBを超えました');
  expect(Date.now() - startedAt).toBeLessThan(20000);
}, 60000);

test('既定の標準出力の行き先が端末でないとき、コマンドが書いた64MiBを超える標準出力を上限に数えず、すべて渡して成功する', async () => {
  const outputBytes = 70 * 1024 * 1024;
  const output = await runWithPipedStdout(
    [process.execPath, '-e', `process.stdout.write('x'.repeat(${outputBytes}))`],
    cleanRecorderEnv(process.env),
  );
  expect(output.stderr).not.toContain('テスト収集の出力が64MiBを超えました');
  expect(output.code).toBe(0);
  expect(output.stdout.length).toBe(Buffer.byteLength(runnerHeader) + outputBytes);
}, 60000);

const writtenChunkBytes = 512;
const pipeCapacityBytes = 64 * 1024;

const writeUntilBlocked = `const fs = require('node:fs');
const chunk = Buffer.alloc(${writtenChunkBytes}, 120);
const writeWhenWritable = (fd, data) => {
  for (;;) {
    try {
      return fs.writeSync(fd, data);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
};
for (;;) {
  writeWhenWritable(1, chunk);
  writeWhenWritable(2, '.');
}`;

const exitWhenStdoutBlocked = `const { spawn } = require('node:child_process');
const writer = spawn(process.execPath, ['-e', ${JSON.stringify(writeUntilBlocked)}], { stdio: ['ignore', 'inherit', 'pipe'] });
let chunks = 0;
let blocked;
writer.stderr.on('data', (marks) => {
  chunks += marks.length;
  clearTimeout(blocked);
  blocked = setTimeout(() => {
    require('node:fs').writeSync(2, 'written: ' + chunks * ${writtenChunkBytes} + '\\n');
    process.exit(0);
  }, 500);
});`;

test('既定の標準出力の行き先が端末でなく、読む側が詰まったままコマンドが終わり、出力のpipeを待つ猶予を過ぎて読み始めても、コマンドが終わるまでに書いた標準出力をすべて渡し、pipeの診断を出さない', async () => {
  const output = await runWithPipedStdout(
    [process.execPath, '-e', exitWhenStdoutBlocked],
    cleanRecorderEnv(process.env),
    { readStdoutAfterMs: 3 * graceMs },
  );
  const writtenBytes = Number(/written: (\d+)\n/.exec(output.stderr)?.[1]);
  expect(writtenBytes).toBeGreaterThan(0);
  expect(output.stderr).not.toContain('出力のpipe');
  expect(output.code).toBe(0);
  expect(output.stdout.length).toBeGreaterThanOrEqual(
    Buffer.byteLength(runnerHeader) + writtenBytes,
  );
  expect(output.stdout.length).toBeLessThanOrEqual(
    Buffer.byteLength(runnerHeader) + writtenBytes + pipeCapacityBytes,
  );
}, 30000);

function denyWithEperm(): never {
  throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
}

const group = 100;

function zombieOnlyGroup() {
  return '  101   100 Z   \n  200   200 S   \n';
}

test('グループへのシグナルがEPERMで拒まれても、グループに生きているプロセスが無ければ、グループはもう無いとして失敗にしない', () => {
  expect(signalProcessGroup(group, 'SIGKILL', denyWithEperm, zombieOnlyGroup)).toBeUndefined();
});

test('グループへのシグナルがEPERMで拒まれ、グループに生きているプロセスがあれば、そのEPERMを失敗として残す', () => {
  const failure = signalProcessGroup(
    group,
    'SIGTERM',
    denyWithEperm,
    () => '  101   100 Z   \n  102   100 S   \n',
  );
  expect(String(failure?.error)).toBe('Error: kill EPERM');
});

test('グループへのシグナルがEPERMで拒まれ、psを起動できないか非ゼロで終われば、psを読めないことを添えて失敗として残す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'command-result-path-'));
  const path = process.env.PATH;
  process.env.PATH = dir;
  try {
    expect(String(signalProcessGroup(group, 'SIGKILL', denyWithEperm)?.error)).toMatch(
      /^Error: kill EPERM。プロセスの一覧を読めません: .*\bps\b/,
    );
    await writeFile(join(dir, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(String(signalProcessGroup(group, 'SIGKILL', denyWithEperm)?.error)).toMatch(
      /^Error: kill EPERM。プロセスの一覧を読めません: psが1で終わりました/,
    );
  } finally {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});

function failProcessListWith(code: string) {
  return (): never => {
    throw Object.assign(new Error(`posix_spawn 'ps' ${code}`), { code });
  };
}

test('グループへのシグナルがEPERMで拒まれ、プロセスの一覧の読み取りがEPERMで拒まれれば、失敗にせず、グループの番号とpsの起動のエラーを含む警告を標準エラーに出す', () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(
      signalProcessGroup(group, 'SIGKILL', denyWithEperm, failProcessListWith('EPERM')),
    ).toBeUndefined();
    expect(logged.mock.calls).toHaveLength(1);
    const warning = logged.mock.calls[0]?.map(String).join(' ');
    expect(warning).toContain(`プロセスグループ${group}`);
    expect(warning).toContain("posix_spawn 'ps' EPERM");
  } finally {
    logged.mockRestore();
  }
});

test('グループへのシグナルがEPERMで拒まれ、プロセスの一覧の読み取りがEPERM以外のエラーで失敗すれば、psを読めないことを添えて失敗として残す', () => {
  expect(
    String(
      signalProcessGroup(group, 'SIGKILL', denyWithEperm, failProcessListWith('EACCES'))?.error,
    ),
  ).toBe("Error: kill EPERM。プロセスの一覧を読めません: posix_spawn 'ps' EACCES");
});

test('グループへのシグナルがEPERMとESRCHのほかのエラーで拒まれれば、グループに生きているプロセスが無くても失敗として残す', () => {
  const failure = signalProcessGroup(
    group,
    'SIGKILL',
    () => {
      throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' });
    },
    zombieOnlyGroup,
  );
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
