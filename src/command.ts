import assert from 'node:assert/strict';
import { spawn, type SpawnOptions } from 'node:child_process';
import { assertObject, hasErrorCode, stringRecord } from './values.ts';

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
  };
  killAfterMs?: number;
  monitorParent: boolean;
  // 起動する子が監視プロセスで、失敗の診断を自分で表示する。
  childReports: boolean;
  allowFailure?: boolean;
  // 利用者が指定した時間の上限（ミリ秒）。時間切れの表示とCommandTimedOutに使う。
  timeoutMs?: number;
  // afterMsを過ぎたら、signalを子のプロセスグループへ送り、時間切れとする。
  watch?: { afterMs: number; signal: NodeJS.Signals; notice: string };
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
  | { type: 'cancel'; signal: NodeJS.Signals; expired?: true }
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

/**
 * 監視プロセスが上限の後も終わらないときに、起動した側が監視プロセスを止めるまでの余裕（ミリ秒）。
 * 監視プロセスは、上限からSIGKILLまでの1秒と、2段のpipeを待つ2秒で終わる。残りの2秒は起動と終了の遅れを吸収する。
 */
const monitorMarginMs = 5000;

/**
 * 待つのをやめるまでの時間（ミリ秒）。取消でSIGKILLへ切り替えるまでと、コマンドの終了後に出力のpipeが閉じるまでの両方に使う。
 * 出力のpipeは、別のプロセスグループの孫が開いたままにすることがある。実行部は孫のPIDを知らないため、孫を止めずに待つのをやめる。
 */
const graceMs = 1000;

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
      message: { argv, env, allowFailure, timeoutMs },
      monitorParent: false,
      childReports: true,
      timeoutMs,
      // 上限は監視プロセスが見張る。こちらは、監視プロセスが詰まったときに止める予備である。
      watch:
        timeoutMs === undefined
          ? undefined
          : {
              afterMs: timeoutMs + monitorMarginMs,
              signal: 'SIGKILL',
              notice: `時間切れ: ${timeoutMs}ミリ秒の上限から${monitorMarginMs}ミリ秒たっても監視プロセスが終わらないため、監視プロセスを止めます`,
            },
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
  const { argv, env, allowFailure = false, timeoutMs } = input;
  assert(typeof allowFailure === 'boolean');
  assert(timeoutMs === undefined || typeof timeoutMs === 'number');
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
        stdio: ['inherit', 'inherit', 'pipe'],
        cwd: process.cwd(),
        env: environment,
        detached: true,
        serialization: 'json',
      },
      killAfterMs: graceMs,
      monitorParent: true,
      childReports: false,
      allowFailure,
      timeoutMs,
      watch:
        timeoutMs === undefined
          ? undefined
          : {
              afterMs: timeoutMs,
              signal: 'SIGTERM',
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

function endedByTimeout(state: State) {
  return state.phase === 'finished' && state.timedOut;
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
  // allowFailureでも成功として返さないよう、終了コードの判定より前に見る。
  if (childReports && result.code === timedOutExitCode && result.signal === null) {
    throw new CommandTimedOut(`${timeoutMs}ミリ秒の上限を過ぎたため止めました`);
  }
  if (
    (state.phase === 'finished' && state.cancelled) ||
    result.signal !== null ||
    (!allowFailure && result.code !== 0)
  ) {
    if (childReports && result.code === reportedExitCode) {
      throw new ReportedFailure('監視プロセスが診断を表示しました');
    }
    assert.fail(`検査失敗または取消: ${result.signal ?? result.code}`);
  }
  return output;
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
    try {
      // 取消をコマンドへ渡し、Bunの別グループのworkerはBun自身が終了するまで待ちます。
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!hasErrorCode(error, 'ESRCH')) {
        failure ??= { error };
      }
    }
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
        const timedOut = event.expired === true;
        if (timedOut && command.watch !== undefined) {
          console.error(command.watch.notice);
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
      child.once('error', (error) => done({ error }));
      child.once('close', (code, signal) => {
        clearTimeout(pipeWait);
        transition({ type: 'close' });
        done({ code, signal });
      });
      child.once('exit', () => {
        // 子が上限より前に終われば、出力のpipeが閉じるのを待つ間に上限が来ても、時間切れにしない。
        clearTimeout(deadline);
        stop(child, 'SIGKILL');
        // pipeを閉じると、closeが子の終了コードとシグナルで届きます。
        pipeWait = setTimeout(() => {
          for (const [name, pipe] of [
            ['標準出力', child.stdout],
            ['標準エラー', child.stderr],
          ] as const) {
            if (pipe !== null && !pipe.readableEnded) {
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
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', collect);
      transition({ type: 'started', child });
      const { watch } = command;
      if (watch !== undefined) {
        deadline = setTimeout(
          () => transition({ type: 'cancel', signal: watch.signal, expired: true }),
          watch.afterMs,
        );
      }
      if (command.message !== undefined) {
        child.send(command.message, sent);
      }
    });
    if (endedByTimeout(state) && !('error' in result)) {
      throw new CommandTimedOut(`${command.timeoutMs}ミリ秒の上限を過ぎたため止めました`);
    }
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
