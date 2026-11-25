import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReportedFailure, commandRunner, graceMs } from '../src/command.ts';
import { runWithPipedStdout, runnerHeader } from './support/command-runner.ts';
import { alive } from './support/feedback-loop-cancellation.ts';
import { cleanRecorderEnv } from './support/runner-affected.ts';

// 監視プロセスは、正本のruntimeをBunで直接起動する。
const run = commandRunner(resolve(import.meta.dir, '../src/runtime.ts'), 'command.test.ts');

/**
 * 別のプロセスグループで、テストの時間の上限（30秒）より長く眠る孫を起動し、そのPIDをGRANDCHILD_PIDSのファイルへ追記するスクリプト。
 * 孫は、コマンドの標準出力・標準エラーのうち、holdsで挙げたものを開いたままにする。
 * コマンド自身のPIDはCOMMAND_PIDSのファイルへ追記する。
 */
function spawnGrandchild(...holds: ('stdout' | 'stderr')[]) {
  const stdio = JSON.stringify([
    'ignore',
    holds.includes('stdout') ? 'inherit' : 'ignore',
    holds.includes('stderr') ? 'inherit' : 'ignore',
  ]);
  return `const fs = require('node:fs');
fs.appendFileSync(process.env.COMMAND_PIDS, process.pid + '\\n');
const child = require('node:child_process').spawn('sleep', ['60'], { detached: true, stdio: ${stdio} });
child.unref();
fs.appendFileSync(process.env.GRANDCHILD_PIDS, child.pid + '\\n');
process.stderr.write('コマンドの標準エラー\\n');
`;
}

function spawnStdoutWritingGrandchild(totalBytes: number) {
  const writer = `const fs = require('node:fs');
const chunk = Buffer.alloc(64 * 1024, 120);
for (let left = ${totalBytes}; left > 0; ) {
  try {
    left -= fs.writeSync(1, chunk);
  } catch (error) {
    if (error.code !== 'EAGAIN') process.exit(0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}`;
  return `const fs = require('node:fs');
fs.appendFileSync(process.env.COMMAND_PIDS, process.pid + '\\n');
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
child.unref();
fs.appendFileSync(process.env.GRANDCHILD_PIDS, child.pid + '\\n');
`;
}

/** bodyの間に、このプロセスの標準エラーへ書かれた内容。監視プロセスの診断は、実行部がここへ転送する。 */
async function stderrDuring(body: () => Promise<void>) {
  const written = spyOn(process.stderr, 'write');
  try {
    await body();
    return written.mock.calls.map(([chunk]) => String(chunk)).join('');
  } finally {
    written.mockRestore();
  }
}

/** 実行部と監視プロセスが、出力のpipeを待つのをやめたときの診断が示すpipe。診断1行につき1つ返す。 */
function diagnosedPipes(...outputs: string[]) {
  return outputs.flatMap((output) =>
    output
      .split('\n')
      .filter((line) => line.startsWith('出力のpipe:'))
      .map((line) => /(標準出力|標準エラー)のpipe/.exec(line)?.[1]),
  );
}

/**
 * まだ生きているプロセスだけを止める。終わったプロセスのPIDへはシグナルを送らない。
 * 後始末の失敗で、テスト本体の失敗を隠さない。
 */
function killIfAlive(pid: number) {
  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGKILL');
  } catch {
    // ESRCHは、確かめる前か止める前に終わった。EPERMは、PIDがほかの利用者のプロセスに再利用された。どちらも止めない。
  }
}

function readPids(file: string) {
  return existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number)
    : [];
}

const pendingCleanups: { dir: string; pidFiles: string[] }[] = [];

afterEach(async () => {
  for (const { dir, pidFiles } of pendingCleanups.splice(0)) {
    pidFiles.flatMap(readPids).forEach(killIfAlive);
    await rm(dir, { recursive: true, force: true });
  }
});

/** 孫は実行部が止めないため、テストの後で、まだ生きている孫とコマンドを止める。 */
async function withGrandchildren(
  body: (
    env: NodeJS.ProcessEnv,
    pids: { grandchildren: () => number[]; commands: () => number[] },
  ) => Promise<void>,
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'command-')));
  const grandchildFile = join(dir, 'grandchild.pids');
  const commandFile = join(dir, 'command.pids');
  pendingCleanups.push({ dir, pidFiles: [grandchildFile, commandFile] });
  await body(
    cleanRecorderEnv({
      ...process.env,
      GRANDCHILD_PIDS: grandchildFile,
      COMMAND_PIDS: commandFile,
    }),
    {
      grandchildren: () => readPids(grandchildFile),
      commands: () => readPids(commandFile),
    },
  );
}

test('終わったコマンドの標準エラーを孫が開いたままでも、孫を待たずにコマンドの失敗の終了コードで終える', async () => {
  await withGrandchildren(async (env, pids) => {
    let failed: unknown;
    const written = await stderrDuring(async () => {
      failed = await run(
        [process.execPath, '-e', `${spawnGrandchild('stderr')}process.exitCode = 3;`],
        { env, stdout: 'ignore' },
      ).catch((error: unknown) => error);
    });
    expect(failed).toBeInstanceOf(ReportedFailure);
    // 監視プロセスの診断が、コマンドの終了コードを示す。
    expect(written).toContain('検査失敗または取消: 3\n');
    expect(pids.grandchildren()).toHaveLength(1);
    expect(pids.grandchildren().every(alive)).toBe(true);
  });
}, 30000);

test('既定の標準出力の行き先が端末でないとき、終わったコマンドの標準出力を孫が開いたままでも、出力を読む側は孫を待たずにコマンドの出力と終わりを受け取り、標準出力のpipeを示す診断が1行出る', async () => {
  await withGrandchildren(async (env, pids) => {
    const output = await runWithPipedStdout(
      [
        process.execPath,
        '-e',
        `${spawnGrandchild('stdout')}process.stdout.write('コマンドの標準出力\\n');`,
      ],
      env,
    );
    expect(pids.grandchildren()).toHaveLength(1);
    expect(pids.grandchildren().every(alive)).toBe(true);
    expect(output.code).toBe(0);
    expect(output.stdout.toString()).toBe(`${runnerHeader}コマンドの標準出力\n`);
    expect(diagnosedPipes(output.stderr)).toEqual(['標準出力']);
  });
}, 30000);

test('既定の標準出力の行き先が端末でないとき、終わったコマンドの標準出力へ孫が書き続けても、監視プロセスは孫の出力を際限なく読みためずに標準出力のpipeを閉じ、診断を1行出す', async () => {
  await withGrandchildren(async (env) => {
    const grandchildBytes = 64 * 1024 * 1024;
    const output = await runWithPipedStdout(
      [process.execPath, '-e', spawnStdoutWritingGrandchild(grandchildBytes)],
      env,
      { readStdoutAfterMs: 3 * graceMs },
    );
    expect(output.code).toBe(0);
    expect(diagnosedPipes(output.stderr)).toEqual(['標準出力']);
    expect(output.stdout.length).toBeLessThan(grandchildBytes / 8);
  });
}, 30000);

test('captureで標準出力と標準エラーの両方を孫が開いたままでも、孫を待たずにコマンドの出力で終え、待つのをやめたpipeごとに1行の診断を出す', async () => {
  await withGrandchildren(async (env, pids) => {
    // 標準エラーのpipeは監視プロセスが待ち、受け取る標準出力のpipeは実行部が待つ。実行部の診断は、このプロセスの標準エラーへ出る。
    const logged = spyOn(console, 'error');
    try {
      const output = await run(
        [
          process.execPath,
          '-e',
          `${spawnGrandchild('stdout', 'stderr')}process.stdout.write('コマンドの標準出力\\n');`,
        ],
        { env, stdout: 'capture' },
      );
      expect(output.stdout).toBe('コマンドの標準出力\n');
      expect(output.stderr).toContain('コマンドの標準エラー\n');
      const runnerOutput = logged.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      // 標準エラーは監視プロセスが、受け取る標準出力は実行部が、それぞれ1行だけ示す。
      expect(diagnosedPipes(output.stderr)).toEqual(['標準エラー']);
      expect(diagnosedPipes(runnerOutput)).toEqual(['標準出力']);
    } finally {
      logged.mockRestore();
    }
    expect(pids.grandchildren()).toHaveLength(1);
    expect(pids.grandchildren().every(alive)).toBe(true);
  });
}, 30000);

test('実行部がSIGHUPで取り消されると、コマンドにはSIGTERMを送って止め、診断には受けたSIGHUPを示す', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'command-hangup-')));
  try {
    const log = join(dir, 'signal.log');
    const script = `const { appendFileSync } = require('node:fs');
for (const signal of ['SIGHUP', 'SIGTERM']) {
  process.on(signal, () => {
    appendFileSync(process.env.SIGNAL_LOG, signal + '\\n');
    process.exit(1);
  });
}
appendFileSync(process.env.SIGNAL_LOG, 'ready\\n');
setInterval(() => {}, 1000);`;
    let outcome: unknown;
    const stderr = await stderrDuring(async () => {
      const cancelled = run([process.execPath, '-e', script], {
        env: cleanRecorderEnv({ ...process.env, SIGNAL_LOG: log }),
        stdout: 'ignore',
        allowFailure: true,
      }).catch((failure: unknown) => failure);
      for (let waited = 0; !existsSync(log) && waited < 10000; waited += 50) {
        await Bun.sleep(50);
      }
      process.emit('SIGHUP', 'SIGHUP');
      outcome = await cancelled;
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(stderr).toContain('検査失敗または取消: SIGHUP');
    expect(stderr).not.toContain('検査失敗または取消: SIGTERM');
    expect(readFileSync(log, 'utf8')).toBe('ready\nSIGTERM\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
