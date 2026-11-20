import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import { assertObject, errorMessage, hasErrorCode, stringRecord } from './values.ts';

type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  // コマンドの標準出力の行き先。captureは受け取って返し、ignoreは捨てる。どちらも実行の表示を標準エラーへ書く。
  stdout: 'inherit' | 'capture' | 'ignore';
  allowFailure: boolean;
  // 実行の表示に使う引数。指定がなければ、実行する引数をそのまま表示する。
  display: string[];
  // 実行の時間の上限（ミリ秒）。過ぎたらコマンドのプロセスグループを止め、CommandTimedOutを投げる。
  timeoutMs: number | undefined;
};

type Command = {
  command: string;
  args: string[];
  options: SpawnOptions;
  message?: {
    argv: string[];
    env: NodeJS.ProcessEnv;
    allowFailure: boolean;
    timeoutMs: number | undefined;
    relayStdout: boolean;
  };
  killAfterMs?: number;
  monitorParent: boolean;
  // 起動する子が監視プロセスで、失敗の診断を自分で表示する。
  childReports: boolean;
  relayStdout?: boolean;
  allowFailure?: boolean;
  // 利用者が指定した時間の上限（ミリ秒）。CommandTimedOutのメッセージに使う。
  timeoutMs?: number;
  // afterMsを過ぎたら、noticeを表示し、SIGTERMを子のプロセスグループへ送り、時間切れとする。
  watch?: { afterMs: number; notice: string };
};

type Child = ReturnType<typeof spawn>;
type State =
  | { phase: 'starting' }
  | { phase: 'running'; child: Child }
  // timedOutは、取消の始まりが時間の上限だったことを表す。上限の前に利用者の取消が始まっていれば、falseのままである。
  | {
      phase: 'cancelling';
      child: Child;
      timer: ReturnType<typeof setTimeout> | undefined;
      timedOut: boolean;
    }
  | { phase: 'finished'; cancelled: boolean; timedOut: boolean };

type Event =
  | { type: 'started'; child: Child }
  // noticeは、上限を過ぎたときの取消だけが持つ時間切れの表示である。
  | { type: 'cancel'; signal: NodeJS.Signals; notice?: string }
  | { type: 'close' };

type Result = { error: Error } | { code: number | null; signal: NodeJS.Signals | null };
type Failure = { error: unknown } | undefined;

export type Run = ReturnType<typeof commandRunner>;

/**
 * 監視プロセスが診断を表示して終了した失敗。同じ失敗を、起動した側でもう一度表示しない。
 * 監視プロセスは、コマンドの終了コードやシグナルを知っている。起動した側が知るのは、監視プロセスの終了コードだけである。
 */
export class ReportedFailure extends Error {}

/**
 * 監視プロセスが、診断を表示した後に終了するコード。
 * 実行系は、診断を表示できない異常終了を1で終える。その場合は起動した側が診断を表示するよう、1と区別する。
 */
export const reportedExitCode = 79;

/** 時間の上限を過ぎたため、コマンドを止めた。取消や失敗とは区別する。 */
export class CommandTimedOut extends Error {}

/**
 * 監視プロセスが、上限を過ぎたコマンドを止めた後に終了するコード。
 * 監視プロセスはコマンドの終了コードを外へ渡さず、0・1・reportedExitCodeで終わるため、そのどれとも重ならない値にする。
 */
const timedOutExitCode = 78;

/** 監視プロセスが、コマンドを取り消してからSIGKILLへ切り替えるまでの待ち（ミリ秒）。 */
const killAfterMs = 1000;

/**
 * 子の終了から、出力のpipeが閉じるのを待つ時間（ミリ秒）。
 * 出力のpipeは、別のプロセスグループの孫が開いたままにすることがある。実行部は孫のPIDを知らないため、孫を止めずに待つのをやめる。
 */
export const graceMs = 1000;

/** setTimeoutが受け付ける待ちの最大（ミリ秒）。超えると、すぐに時間切れになる。 */
const maxTimerMs = 2 ** 31 - 1;

/** 時間の上限は、指定しないか、0より大きくmaxTimerMs以下の有限の数である。 */
function assertTimeoutMs(timeoutMs: unknown): asserts timeoutMs is number | undefined {
  assert(
    timeoutMs === undefined ||
      (typeof timeoutMs === 'number' &&
        Number.isFinite(timeoutMs) &&
        timeoutMs > 0 &&
        timeoutMs <= maxTimerMs),
    `時間の上限は、0より大きく${maxTimerMs}ミリ秒以下の有限の数です: ${String(timeoutMs)}`,
  );
}

export function commandRunner(runtime: string, retryCommand: string) {
  return async (argv: string[], options: Partial<CommandOptions> = {}) => {
    assert(argv[0], '実行コマンドがありません');
    const {
      cwd = process.cwd(),
      env = process.env,
      stdout = 'inherit',
      allowFailure = false,
      display = argv,
      timeoutMs,
    } = options;
    // 範囲外の上限では、監視プロセスもコマンドも起動しない。
    assertTimeoutMs(timeoutMs);
    const log = stdout === 'inherit' ? console.log : console.error;
    const operation = stdout === 'capture' ? '収集' : '実行';
    log(`${operation}: ${display.join(' ')}; 再実行: ${retryCommand}`);
    const startupEnv = { ...env };
    // 対象コマンドのpreloadは監視プロセスでは実行せず、IPC経由で元の環境を渡します。
    delete startupEnv.BUN_OPTIONS;
    delete startupEnv.NODE_OPTIONS;
    return superviseCommand({
      command: process.execPath,
      args: [...(process.versions.bun ? ['--no-env-file'] : []), runtime, 'execute-child'],
      options: {
        stdio: ['inherit', stdout === 'capture' ? 'pipe' : stdout, 'pipe', 'ipc'],
        cwd,
        env: startupEnv,
        detached: true,
        serialization: 'json',
      },
      message: {
        argv,
        env,
        allowFailure,
        timeoutMs,
        relayStdout: stdout === 'inherit' && !process.stdout.isTTY,
      },
      monitorParent: false,
      childReports: true,
      // 上限は監視プロセスだけが見張り、時間切れをtimedOutExitCodeで伝える。
      timeoutMs,
    });
  };
}

export async function runMonitor() {
  assert(
    process.connected && typeof process.send === 'function',
    '内部の検査監視には親とのIPC接続が必要です',
  );
  const input: unknown = await new Promise((done, fail) => {
    const disconnected = () => {
      process.off('message', received);
      fail(new Error('検査の開始前に親との接続が切れました'));
    };
    const received = (value: unknown) => {
      process.off('disconnect', disconnected);
      done(value);
    };
    process.once('disconnect', disconnected);
    process.once('message', received);
  });
  assertObject(input);
  const { argv, env, allowFailure = false, timeoutMs, relayStdout } = input;
  assert(typeof allowFailure === 'boolean');
  assert(typeof relayStdout === 'boolean');
  assertTimeoutMs(timeoutMs);
  assert(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === 'string'));
  const environment: NodeJS.ProcessEnv = stringRecord(env);
  // 親の出力pipeが閉じても監視を維持し、取消と強制終了を完了させます。
  process.stderr.on('error', () => {
    process.exitCode = 1;
    if (process.connected) {
      process.disconnect?.();
    }
  });
  const [command, ...args] = argv;
  assert(command, '実行コマンドがありません');
  try {
    await superviseCommand({
      command,
      args,
      options: {
        stdio: ['inherit', relayStdout ? 'pipe' : 'inherit', 'pipe'],
        cwd: process.cwd(),
        env: environment,
        detached: true,
        serialization: 'json',
      },
      killAfterMs,
      monitorParent: true,
      childReports: false,
      relayStdout,
      allowFailure,
      timeoutMs,
      watch:
        timeoutMs === undefined
          ? undefined
          : {
              afterMs: timeoutMs,
              notice: `時間切れ: ${timeoutMs}ミリ秒の上限を過ぎたため、コマンドを止めます`,
            },
    });
  } catch (error) {
    if (!(error instanceof CommandTimedOut)) {
      throw error;
    }
    // 時間切れの表示は済んでいる。起動した側は、この終了コードでCommandTimedOutを投げる。
    process.exitCode = timedOutExitCode;
  }
}

function clearCancellationTimer(state: State) {
  if (state.phase === 'cancelling') {
    clearTimeout(state.timer);
  }
}

function commandResult(
  result: Result,
  failure: Failure,
  state: State,
  output: { stdout: string; stderr: string },
  allowFailure: boolean,
  childReports: boolean,
  timeoutMs: number | undefined,
) {
  if ('error' in result) {
    throw result.error;
  }
  if (failure !== undefined) {
    assert.fail(`子プロセスの終了を確認できません: ${String(failure.error)}`);
  }
  const finished = state.phase === 'finished';
  // 上限より先に始まった取消は、後から上限が来ても取消とする。起動した側は監視プロセスの上限の時刻を知らないため、
  // 監視プロセスが時間切れで終わる前に受けた取消を、上限より先の取消とみなす。
  const userCancelled = finished && state.cancelled && !state.timedOut;
  const timedOut =
    (finished && state.timedOut) ||
    (childReports && result.code === timedOutExitCode && result.signal === null);
  if (timedOut && !userCancelled) {
    throw new CommandTimedOut(`${timeoutMs}ミリ秒の上限を過ぎたため止めました`);
  }
  if (userCancelled || result.signal !== null || (!allowFailure && result.code !== 0)) {
    failRun(result, childReports);
  }
  return output;
}

function failRun(result: Exclude<Result, { error: Error }>, childReports: boolean): never {
  if (childReports && result.code === reportedExitCode) {
    throw new ReportedFailure('監視プロセスが診断を表示しました');
  }
  if (childReports && result.code === timedOutExitCode) {
    assert.fail('取り消しました。時間の上限も過ぎていました');
  }
  assert.fail(`検査失敗または取消: ${result.signal ?? result.code}`);
}

type Kill = (pid: number, signal: NodeJS.Signals) => void;

export function signalProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
  kill: Kill = (pid, sent) => process.kill(pid, sent),
  readProcessList: () => string = listProcesses,
): Failure {
  try {
    kill(-pgid, signal);
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return undefined;
    }
    if (!hasErrorCode(error, 'EPERM')) {
      return { error };
    }
    return deniedGroupFailure(pgid, error, readProcessList);
  }
  return undefined;
}

function deniedGroupFailure(pgid: number, error: unknown, readProcessList: () => string): Failure {
  try {
    return countLiveMembers(readProcessList(), pgid) === 0 ? undefined : { error };
  } catch (listError) {
    return {
      error: new Error(
        `${errorMessage(error)}。プロセスの一覧を読めません: ${errorMessage(listError)}`,
        { cause: error },
      ),
    };
  }
}

function listProcesses() {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  assert(
    result.status === 0,
    `psが${result.signal ?? result.status}で終わりました: ${result.stderr.trim()}`,
  );
  return result.stdout;
}

export function countLiveMembers(processList: string, pgid: number) {
  return processList.split('\n').filter((line) => {
    const [, group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && stat !== undefined && !stat.startsWith('Z');
  }).length;
}

function relay(output: Readable) {
  process.stdout.on('error', () => output.destroy());
  output.pipe(process.stdout, { end: false });
}

function drainRelay(output: Readable) {
  output.unpipe(process.stdout);
  output.on('data', (chunk: Buffer) => {
    if (!process.stdout.destroyed) {
      process.stdout.write(chunk);
    }
  });
  output.resume();
}

async function superviseCommand(command: Command) {
  assert(!command.monitorParent || process.connected, '検査の開始前に親との接続が切れました');
  let state: State = { phase: 'starting' };
  // 失敗は状態を変えないため、取消の状態とは別に最初の原因だけを保持します。
  let failure: Failure;
  const stop = (child: Child, signal: NodeJS.Signals) => {
    if (child.pid === undefined) {
      return;
    }
    // 取消をコマンドへ渡し、Bunの別グループのworkerはBun自身が終了するまで待ちます。
    const signalFailure = signalProcessGroup(child.pid, signal);
    failure ??= signalFailure;
  };
  const transition = (event: Event): void => {
    if (event.type === 'started') {
      state = { phase: 'running', child: event.child };
      return;
    }
    if (event.type === 'close') {
      clearCancellationTimer(state);
      state =
        state.phase === 'cancelling'
          ? { phase: 'finished', cancelled: true, timedOut: state.timedOut }
          : { phase: 'finished', cancelled: false, timedOut: false };
      return;
    }
    switch (state.phase) {
      // spawnと起動済みへの遷移は同じ同期処理の中にあり、取消はその間に届きません。
      case 'starting':
      case 'finished':
        return;
      case 'running': {
        const { child } = state;
        const timedOut = event.notice !== undefined;
        if (timedOut) {
          console.error(event.notice);
        }
        state = { phase: 'cancelling', child, timer: undefined, timedOut };
        stop(child, event.signal);
        if (command.killAfterMs !== undefined) {
          state.timer = setTimeout(() => stop(child, 'SIGKILL'), command.killAfterMs);
          state.timer.unref();
        }
        return;
      }
      case 'cancelling':
        stop(state.child, event.signal);
    }
  };

  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pipeWait: ReturnType<typeof setTimeout> | undefined;
  let stdout = '';
  let stdoutBytes = 0;
  let stderr = '';
  const interrupt = () => transition({ type: 'cancel', signal: 'SIGINT' });
  const terminate = () => transition({ type: 'cancel', signal: 'SIGTERM' });
  const collect = (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 64 * 1024 * 1024) {
      failure ??= { error: new Error('テスト収集の出力が64MiBを超えました') };
      transition({ type: 'cancel', signal: 'SIGTERM' });
    } else {
      stdout += chunk;
    }
  };
  const sent = (error: Error | null) => {
    if (error) {
      failure ??= { error };
      transition({ type: 'cancel', signal: 'SIGKILL' });
    }
  };
  // detachedな子だけが残らないよう、取消の受け口は起動前に登録します。
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  if (command.monitorParent) {
    process.on('disconnect', terminate);
  }
  try {
    const result = await new Promise<Result>((done) => {
      const child = spawn(command.command, command.args, command.options);
      const relayed = command.relayStdout === true ? child.stdout : null;
      child.once('error', (error) => done({ error }));
      child.once('close', (code, signal) => {
        transition({ type: 'close' });
        done({ code, signal });
      });
      child.once('exit', () => {
        // 子が上限より前に終われば、出力のpipeが閉じるのを待つ間に上限が来ても、時間切れにしない。
        clearTimeout(deadline);
        stop(child, 'SIGKILL');
        if (relayed !== null) {
          drainRelay(relayed);
        }
        // pipeを閉じると、closeが子の終了コードとシグナルで届きます。
        pipeWait = setTimeout(() => {
          for (const [name, pipe] of [
            ['標準出力', child.stdout],
            ['標準エラー', child.stderr],
          ] as const) {
            if (pipe !== null && !pipe.readableEnded && !pipe.destroyed) {
              console.error(
                `出力のpipe: 終了したプロセスの${name}のpipeを、別のプロセスが${graceMs}ミリ秒たっても開いたままのため、閉じるのを待たずに終えます`,
              );
            }
            pipe?.destroy();
          }
        }, graceMs);
      });
      assert(child.stderr);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (!process.stderr.destroyed) {
          process.stderr.write(chunk);
        }
        // Bunの選択診断は先頭に出ます。テスト本体の大量ログは保持しません。
        stderr += chunk.slice(0, Math.max(0, 4096 - stderr.length));
      });
      if (relayed !== null) {
        relay(relayed);
      } else {
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', collect);
      }
      transition({ type: 'started', child });
      const { watch } = command;
      if (watch !== undefined) {
        deadline = setTimeout(
          () => transition({ type: 'cancel', signal: 'SIGTERM', notice: watch.notice }),
          watch.afterMs,
        );
      }
      if (command.message !== undefined) {
        child.send(command.message, sent);
      }
    });
    return commandResult(
      result,
      failure,
      state,
      { stdout, stderr },
      command.allowFailure ?? false,
      command.childReports,
      command.timeoutMs,
    );
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('disconnect', terminate);
    clearTimeout(deadline);
    clearTimeout(pipeWait);
    clearCancellationTimer(state);
    if (command.monitorParent && process.connected) {
      process.disconnect?.();
    }
  }
}
