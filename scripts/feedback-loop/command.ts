import assert from 'node:assert/strict';
import { spawn, type SpawnOptions } from 'node:child_process';
import { assertObject, hasErrorCode } from '../shared/values.ts';

type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  captureStdout: boolean;
  allowFailure: boolean;
};

type Command = {
  command: string;
  args: string[];
  options: SpawnOptions;
  message?: { argv: string[]; env: NodeJS.ProcessEnv; allowFailure: boolean };
  killAfterMs?: number;
  monitorParent: boolean;
  allowFailure?: boolean;
};

type Child = ReturnType<typeof spawn>;
type State =
  | { phase: 'starting'; pendingSignal?: NodeJS.Signals }
  | { phase: 'running'; child: Child }
  | { phase: 'cancelling'; child: Child; timer: ReturnType<typeof setTimeout> | undefined }
  | { phase: 'finished'; cancelled: boolean };

type Event =
  | { type: 'started'; child: Child }
  | { type: 'cancel'; signal: NodeJS.Signals }
  | { type: 'close' };

type Result = { error: Error } | { code: number | null; signal: NodeJS.Signals | null };
type Failure = { error: unknown } | undefined;

export function commandRunner(runtime: string, retryCommand: string) {
  return async (argv: string[], options: Partial<CommandOptions> = {}) => {
    assert(argv[0], '実行コマンドがありません');
    const {
      cwd = process.cwd(),
      env = process.env,
      captureStdout = false,
      allowFailure = false,
    } = options;
    const log = captureStdout ? console.error : console.log;
    const operation = captureStdout ? '収集' : '実行';
    log(`${operation}: ${argv.join(' ')}; 再実行: ${retryCommand}`);
    const startupEnv = { ...env };
    // 対象コマンドのpreloadは監視プロセスでは実行せず、IPC経由で元の環境を渡します。
    delete startupEnv.BUN_OPTIONS;
    delete startupEnv.NODE_OPTIONS;
    return superviseCommand({
      command: process.execPath,
      args: [...(process.versions.bun ? ['--no-env-file'] : []), runtime, 'execute-child'],
      options: {
        stdio: ['inherit', captureStdout ? 'pipe' : 'inherit', 'pipe', 'ipc'],
        cwd,
        env: startupEnv,
        detached: true,
        serialization: 'json',
      },
      message: { argv, env, allowFailure },
      monitorParent: false,
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
  const { argv, env, allowFailure = false } = input;
  assert(typeof allowFailure === 'boolean');
  assert(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === 'string'));
  assertObject(env);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    assert(typeof value === 'string');
    environment[key] = value;
  }
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
      stdio: ['inherit', 'inherit', 'pipe'],
      cwd: process.cwd(),
      env: environment,
      detached: true,
      serialization: 'json',
    },
    killAfterMs: 1000,
    monitorParent: true,
    allowFailure,
  });
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
) {
  if ('error' in result) {
    throw result.error;
  }
  if (failure !== undefined) {
    assert.fail(`子プロセスの終了を確認できません: ${String(failure.error)}`);
  }
  if (
    (state.phase === 'finished' && state.cancelled) ||
    result.signal !== null ||
    (!allowFailure && result.code !== 0)
  ) {
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
      const pendingSignal = state.phase === 'starting' ? state.pendingSignal : undefined;
      state = { phase: 'running', child: event.child };
      if (pendingSignal === undefined) {
        return;
      }
      event = { type: 'cancel', signal: pendingSignal };
    }
    if (event.type === 'close') {
      clearCancellationTimer(state);
      state = { phase: 'finished', cancelled: state.phase === 'cancelling' };
      return;
    }
    switch (state.phase) {
      case 'starting':
        state = { phase: 'starting', pendingSignal: event.signal };
        return;
      case 'finished':
        return;
      case 'running': {
        const { child } = state;
        state = { phase: 'cancelling', child, timer: undefined };
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
        transition({ type: 'close' });
        done({ code, signal });
      });
      child.once('exit', () => stop(child, 'SIGKILL'));
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
      if (command.message !== undefined) {
        child.send(command.message, sent);
      }
    });
    return commandResult(result, failure, state, { stdout, stderr }, command.allowFailure ?? false);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('disconnect', terminate);
    clearCancellationTimer(state);
    if (command.monitorParent && process.connected) {
      process.disconnect?.();
    }
  }
}
