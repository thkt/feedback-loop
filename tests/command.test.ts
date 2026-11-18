import { expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AssertionError } from 'node:assert';
import { CommandTimedOut, ReportedFailure, commandRunner, graceMs } from '../src/command.ts';
import { alive, waitFor } from './support/feedback-loop-cancellation.ts';
import { cleanRecorderEnv } from './support/runner-affected.ts';

// 監視プロセスは、正本のruntimeをBunで直接起動する。
const run = commandRunner(resolve(import.meta.dir, '../src/runtime.ts'), 'command.test.ts');

/** 監視プロセスとコマンドの起動の遅れを吸収する上限（ミリ秒）。 */
const timeoutMs = 5000;

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

/**
 * コマンド自身の起動の時刻からafterMsたったら、codeで終わるスクリプト。
 * 起動の時刻はスクリプトの先頭で取るため、監視プロセスの起動の遅れは終わる時刻に入らない。
 */
function exitAfter(afterMs: number, code: number, body: string) {
  return `const startedAt = Date.now();
${body}setTimeout(() => { process.exitCode = ${code}; }, startedAt + ${afterMs} - Date.now());`;
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
  const pids = {
    grandchildren: () => readPids(grandchildFile),
    commands: () => readPids(commandFile),
  };
  try {
    await body(
      cleanRecorderEnv({
        ...process.env,
        GRANDCHILD_PIDS: grandchildFile,
        COMMAND_PIDS: commandFile,
      }),
      pids,
    );
  } finally {
    [...pids.grandchildren(), ...pids.commands()].forEach(killIfAlive);
    await rm(dir, { recursive: true, force: true });
  }
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

test('mutationと同じく出力を捨てて上限を付けた実行では、標準エラーを孫が開いたままでも、上限より前に終わったコマンドを時間切れにしない', async () => {
  await withGrandchildren(async (env, pids) => {
    // 監視プロセスの上限の時計は、コマンドの起動より前に動き出す。コマンドは自身の起動から、上限のgraceMs - 100ミリ秒前に終わる。
    // そのため、コマンドの起動と終了の受け取りの遅れがgraceMs - 100ミリ秒までなら、上限の前に終わる。
    // 標準エラーのpipeを待つgraceMsは、遅れが無くても、上限を100ミリ秒またぐ。
    const script = exitAfter(timeoutMs - graceMs + 100, 0, spawnGrandchild('stderr'));
    const output = await run([process.execPath, '-e', script], {
      env,
      stdout: 'ignore',
      allowFailure: true,
      timeoutMs,
    });
    expect(output.stderr).toContain('コマンドの標準エラー\n');
    expect(diagnosedPipes(output.stderr)).toEqual(['標準エラー']);
    expect(pids.grandchildren()).toHaveLength(1);
    expect(pids.grandchildren().every(alive)).toBe(true);
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

test('SIGTERMを無視するコマンドの標準エラーを孫が開いたままでも、上限を過ぎたらコマンドを止め、孫を待たずに時間切れで終える', async () => {
  await withGrandchildren(async (env, pids) => {
    const script = `process.on('SIGTERM', () => {});
${spawnGrandchild('stderr')}setInterval(() => {}, 1000);`;
    // 失敗を許す実行でも、時間切れを成功として返さない。
    const timedOut = await run([process.execPath, '-e', script], {
      env,
      stdout: 'ignore',
      allowFailure: true,
      timeoutMs,
    }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(CommandTimedOut);
    // 監視プロセスが上限でコマンドを止めたことを、コマンドが残っていないことで確かめる。
    expect(pids.commands()).toHaveLength(1);
    expect(pids.commands().some(alive)).toBe(false);
    expect(pids.grandchildren()).toHaveLength(1);
    expect(pids.grandchildren().every(alive)).toBe(true);
  });
}, 30000);

test('監視プロセスが時間切れで終わる前に実行部が利用者の取消を受けると、時間切れでなく取消として終える', async () => {
  await withGrandchildren(async (env, pids) => {
    // コマンドはSIGTERMを無視するため、監視プロセスは上限からkillAfterMsの間、時間切れの取消を続けてから終わる。
    const script = `process.on('SIGTERM', () => {});
require('node:fs').appendFileSync(process.env.COMMAND_PIDS, process.pid + '\\n');
setInterval(() => {}, 1000);`;
    const written = spyOn(process.stderr, 'write');
    try {
      const running = run([process.execPath, '-e', script], {
        env,
        stdout: 'ignore',
        allowFailure: true,
        timeoutMs,
      }).catch((error: unknown) => error);
      const forwarded = () => written.mock.calls.map(([chunk]) => String(chunk)).join('');
      // 監視プロセスの上限が来た後、監視プロセスが終わる前に、利用者の取消を実行部へ届ける。
      await waitFor(
        () => forwarded().includes('時間切れ:'),
        () => `時間切れの表示が出ません: ${forwarded()}`,
        timeoutMs + 5000,
      );
      process.emit('SIGTERM', 'SIGTERM');
      const cancelled = await running;
      expect(cancelled).toBeInstanceOf(Error);
      expect(cancelled).not.toBeInstanceOf(CommandTimedOut);
    } finally {
      written.mockRestore();
    }
    expect(pids.commands()).toHaveLength(1);
    expect(pids.commands().some(alive)).toBe(false);
  });
}, 30000);

test('時間の上限が0以下、有限でない、またはsetTimeoutの上限を超えると、監視プロセスもコマンドも起動せずに失敗する', async () => {
  await withGrandchildren(async (env, pids) => {
    const script = `require('node:fs').appendFileSync(process.env.COMMAND_PIDS, process.pid + '\\n');`;
    for (const invalid of [0, Number.NaN, 2 ** 31]) {
      const failed = await run([process.execPath, '-e', script], {
        env,
        stdout: 'ignore',
        allowFailure: true,
        timeoutMs: invalid,
      }).catch((error: unknown) => error);
      // mutationと同じく失敗を許す実行で確かめる。監視プロセスを起動していれば、監視プロセスが診断を出して終わり、ReportedFailureになる。
      expect(failed).toBeInstanceOf(AssertionError);
      expect(String(failed)).toContain(
        `時間の上限は、0より大きく${2 ** 31 - 1}ミリ秒以下の有限の数です`,
      );
    }
    expect(pids.commands()).toEqual([]);
  });
});
