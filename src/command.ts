import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:os';
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
};

type Command = {
  command: string;
  args: string[];
  options: SpawnOptions;
  message?: {
    argv: string[];
    env: NodeJS.ProcessEnv;
    allowFailure: boolean;
    relayStdout: boolean;
  };
  killAfterMs?: number;
  monitorParent: boolean;
  // 起動する子が監視プロセスで、失敗の診断を自分で表示する。
  childReports: boolean;
  relayStdout?: boolean;
  allowFailure?: boolean;
  beforeDisconnect?: (status: ExitStatus) => Promise<void>;
};

type Child = ReturnType<typeof spawn>;
type State =
  | { phase: 'starting' }
  | { phase: 'running' }
  | { phase: 'cancelling'; signal: NodeJS.Signals }
  | { phase: 'finished'; cancelled: boolean; signal: NodeJS.Signals | undefined };

type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === 'string' && Object.hasOwn(constants.signals, value);
}

function exitStatus(value: unknown): ExitStatus {
  assertObject(value);
  const { code, signal } = value;
  const invalid = '監視プロセスから届いたコマンドの終わり方が不正です';
  assert(code === null || (typeof code === 'number' && Number.isSafeInteger(code)), invalid);
  assert(signal === null || isSignal(signal), invalid);
  return { code, signal };
}

function sendToParent(message: ExitStatus) {
  return new Promise<void>((done, fail) => {
    const sending = process.send?.(message, undefined, {}, (error: Error | null) =>
      error ? fail(error) : done(),
    );
    if (sending === undefined) {
      fail(new Error('内部の検査監視には親とのIPC接続が必要です'));
    }
  });
}

type Event = { type: 'started' } | { type: 'cancel'; signal: NodeJS.Signals } | { type: 'close' };

type Effect =
  | { type: 'signal'; signal: NodeJS.Signals }
  | { type: 'armKill'; afterMs: number }
  | { type: 'clearKill' };

type Outcome = { kind: 'success' } | { kind: 'reported' } | { kind: 'failed'; message: string };

type Result = { error: Error } | ExitStatus;
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

export const cancellationSignals = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
] as const satisfies readonly NodeJS.Signals[];

/** 監視プロセスが、コマンドを取り消してからSIGKILLへ切り替えるまでの待ち（ミリ秒）。 */
const killAfterMs = 1000;

/**
 * 子の終了から、出力のpipeが閉じるのを待つ時間（ミリ秒）。
 * 出力のpipeは、別のプロセスグループの孫が開いたままにすることがある。実行部は孫のPIDを知らないため、孫を止めずに待つのをやめる。
 */
export const graceMs = 1000;

export function commandRunner(runtime: string, retryCommand: string) {
  return async (argv: string[], options: Partial<CommandOptions> = {}) => {
    assert(argv[0], '実行コマンドがありません');
    const {
      cwd = process.cwd(),
      env = process.env,
      stdout = 'inherit',
      allowFailure = false,
      display = argv,
    } = options;
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
        relayStdout: stdout === 'inherit' && !process.stdout.isTTY,
      },
      monitorParent: false,
      childReports: true,
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
  const { argv, env, allowFailure = false, relayStdout } = input;
  assert(typeof allowFailure === 'boolean');
  assert(typeof relayStdout === 'boolean');
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
    beforeDisconnect: async (status) => {
      if (process.connected) {
        await sendToParent(status);
      }
    },
  });
}

type Transition = { state: State; effects: Effect[] };

function nextState(state: State, event: Event, killAfter: number | undefined): Transition {
  if (event.type === 'started') {
    return { state: { phase: 'running' }, effects: [] };
  }
  if (event.type === 'close') {
    return closeState(state);
  }
  return cancelState(state, event, killAfter);
}

function closeState(state: State): Transition {
  return state.phase === 'cancelling'
    ? {
        state: { phase: 'finished', cancelled: true, signal: state.signal },
        effects: [{ type: 'clearKill' }],
      }
    : { state: { phase: 'finished', cancelled: false, signal: undefined }, effects: [] };
}

function cancelState(
  state: State,
  event: Extract<Event, { type: 'cancel' }>,
  killAfter: number | undefined,
): Transition {
  if (state.phase === 'cancelling') {
    return { state, effects: [{ type: 'signal', signal: event.signal }] };
  }
  if (state.phase !== 'running') {
    return { state, effects: [] };
  }
  const effects: Effect[] = [{ type: 'signal', signal: event.signal }];
  if (killAfter !== undefined) {
    effects.push({ type: 'armKill', afterMs: killAfter });
  }
  return { state: { phase: 'cancelling', signal: event.signal }, effects };
}

function commandResult(
  result: Result,
  failure: Failure,
  state: State,
  output: { stdout: string; stderr: string },
  allowFailure: boolean,
  childReports: boolean,
  reported: ExitStatus | undefined,
) {
  if ('error' in result) {
    throw result.error;
  }
  if (failure !== undefined) {
    assert.fail(`子プロセスの終了を確認できません: ${String(failure.error)}`);
  }
  const outcome = judgeResult(state, result, { allowFailure, childReports });
  if (outcome.kind === 'reported') {
    throw new ReportedFailure('監視プロセスが診断を表示しました');
  }
  if (outcome.kind === 'failed') {
    assert.fail(outcome.message);
  }
  if (result.signal !== null) {
    console.error(`コマンドが${result.signal}で終わりました`);
  }
  if (!childReports) {
    return { ...output, code: result.code, signal: result.signal };
  }
  assert(reported, '監視プロセスからコマンドの終わり方が届きません');
  return { ...output, ...reported };
}

function judgeResult(
  state: State,
  exit: ExitStatus,
  settings: { allowFailure: boolean; childReports: boolean },
): Outcome {
  const userCancelled = state.phase === 'finished' && state.cancelled;
  const failed = settings.allowFailure ? isCancellationSignal(exit.signal) : exit.code !== 0;
  if (userCancelled || failed) {
    return failedOutcome(exit, settings.childReports, userCancelled ? state.signal : undefined);
  }
  return { kind: 'success' };
}

function isCancellationSignal(signal: NodeJS.Signals | null) {
  return cancellationSignals.some((cancellation) => cancellation === signal);
}

function failedOutcome(
  exit: ExitStatus,
  childReports: boolean,
  cancelledBy: NodeJS.Signals | undefined,
): Outcome {
  if (childReports && exit.code === reportedExitCode) {
    return { kind: 'reported' };
  }
  return {
    kind: 'failed',
    message: `検査失敗または取消: ${cancelledBy ?? exit.signal ?? exit.code}`,
  };
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
    if (hasErrorCode(listError, 'EPERM')) {
      console.error(
        `プロセスグループ${pgid}の終了を確かめられません。psの起動が拒否されました: ${errorMessage(listError)}`,
      );
      return undefined;
    }
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

const relayDrainLimitBytes = 1024 * 1024;

function drainRelay(output: Readable) {
  output.unpipe(process.stdout);
  let drainedBytes = 0;
  output.on('data', (chunk: Buffer) => {
    drainedBytes += chunk.length;
    if (drainedBytes > relayDrainLimitBytes) {
      console.error(
        `出力のpipe: 終了したプロセスの標準出力のpipeへ、別のプロセスが${relayDrainLimitBytes}バイトを超えて書き続けるため、閉じるのを待たずに終えます`,
      );
      output.destroy();
      return;
    }
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
    const sent = signal === 'SIGHUP' && command.monitorParent ? 'SIGTERM' : signal;
    const signalFailure = signalProcessGroup(child.pid, sent);
    failure ??= signalFailure;
  };
  let active: Child | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const perform = (effect: Effect) => {
    switch (effect.type) {
      case 'clearKill':
        clearTimeout(killTimer);
        return;
      case 'signal':
        if (active !== undefined) {
          stop(active, effect.signal);
        }
        return;
      case 'armKill': {
        const target = active;
        if (target !== undefined) {
          killTimer = setTimeout(() => stop(target, 'SIGKILL'), effect.afterMs);
          killTimer.unref();
        }
      }
    }
  };
  const transition = (event: Event): void => {
    const next = nextState(state, event, command.killAfterMs);
    state = next.state;
    for (const effect of next.effects) {
      perform(effect);
    }
  };

  let pipeWait: ReturnType<typeof setTimeout> | undefined;
  let stdout = '';
  let stdoutBytes = 0;
  let stderr = '';
  let reported: ExitStatus | undefined;
  let reportFailure: Failure;
  const cancel = (signal: NodeJS.Signals) => transition({ type: 'cancel', signal });
  const terminate = () => cancel('SIGTERM');
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
  for (const signal of cancellationSignals) {
    process.on(signal, cancel);
  }
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
      if (command.childReports) {
        child.on('message', (message: unknown) => {
          try {
            reported = exitStatus(message);
          } catch (error) {
            reportFailure ??= { error };
          }
        });
      }
      active = child;
      transition({ type: 'started' });
      if (command.message !== undefined) {
        child.send(command.message, sent);
      }
    });
    const output = commandResult(
      result,
      failure ?? reportFailure,
      state,
      { stdout, stderr },
      command.allowFailure ?? false,
      command.childReports,
      reported,
    );
    await command.beforeDisconnect?.({ code: output.code, signal: output.signal });
    return output;
  } finally {
    for (const signal of cancellationSignals) {
      process.off(signal, cancel);
    }
    process.off('disconnect', terminate);
    clearTimeout(pipeWait);
    clearTimeout(killTimer);
    if (command.monitorParent && process.connected) {
      process.disconnect?.();
    }
  }
}
