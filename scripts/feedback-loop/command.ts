import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hasErrorCode } from '../shared/values.ts';

// 監視側は起動ログを出さないため、再実行方法を受け取りません。
type ExecutionOptions = {
  runtime: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  captureStdout?: boolean;
} & (
  | { monitorParent: true; retryCommand?: never }
  | { monitorParent?: false; retryCommand: string }
);

type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  captureStdout: boolean;
};

function launchCommand(
  argv: string[],
  runtime: string,
  retryCommand: string,
  options: CommandOptions,
) {
  const log = options.captureStdout ? console.error : console.log;
  const operation = options.captureStdout ? '収集' : '実行';
  log(`${operation}: ${argv.join(' ')}; 再実行: ${retryCommand}`);
  const startupEnv = { ...options.env };
  // 対象コマンドのpreloadは監視プロセスでは実行せず、IPC経由で元の環境を渡します。
  delete startupEnv.BUN_OPTIONS;
  delete startupEnv.NODE_OPTIONS;
  const child = spawn(
    process.execPath,
    [...(process.versions.bun ? ['--no-env-file'] : []), runtime, 'execute-child'],
    {
      stdio: ['inherit', options.captureStdout ? 'pipe' : 'inherit', 'pipe', 'ipc'],
      cwd: options.cwd,
      env: startupEnv,
      detached: true,
      serialization: 'json',
    },
  );
  return superviseCommand(child, (forward, stop, fail) => {
    child.send({ argv, env: options.env }, (error) => {
      if (error) {
        fail(error);
        stop('SIGKILL');
      }
    });
    return { cancel: forward, cleanup() {} };
  });
}

function monitorCommand(argv: string[], options: CommandOptions) {
  assert(process.connected, '検査の開始前に親との接続が切れました');
  const [command, ...args] = argv;
  assert(command, '実行コマンドがありません');
  const child = spawn(command, args, {
    stdio: ['inherit', 'inherit', 'pipe'],
    cwd: options.cwd,
    env: options.env,
    detached: true,
    serialization: 'json',
  });
  return superviseCommand(child, (forward, stop) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (signal: NodeJS.Signals) => {
      forward(signal);
      timer ??= setTimeout(() => stop('SIGKILL'), 1000);
      timer.unref();
    };
    const disconnect = () => cancel('SIGTERM');
    process.on('disconnect', disconnect);
    return {
      cancel,
      cleanup() {
        clearTimeout(timer);
        process.off('disconnect', disconnect);
        if (process.connected) {
          process.disconnect?.();
        }
      },
    };
  });
}

export async function execute(argv: string[], options: ExecutionOptions) {
  assert(argv[0], '実行コマンドがありません');
  const commandOptions = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    captureStdout: options.captureStdout ?? false,
  };
  return options.monitorParent
    ? monitorCommand(argv, commandOptions)
    : launchCommand(argv, options.runtime, options.retryCommand, commandOptions);
}

async function superviseCommand(
  child: ReturnType<typeof spawn>,
  setup: (
    forward: (signal: NodeJS.Signals) => void,
    stop: (signal: NodeJS.Signals) => void,
    fail: (error: unknown) => void,
  ) => { cancel: (signal: NodeJS.Signals) => void; cleanup: () => void },
) {
  assert(child.stderr);
  // Bunの選択診断は先頭に出ます。テスト本体の大量ログは保持しません。
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (!process.stderr.destroyed) {
      process.stderr.write(chunk);
    }
    stderr += chunk.slice(0, Math.max(0, 4096 - stderr.length));
  });
  let cancelled = false;
  let cleanupError: unknown;
  const stop = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) {
      return;
    }
    try {
      // 取消をコマンドへ渡し、Bunの別グループのworkerはBun自身が終了するまで待ちます。
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!hasErrorCode(error, 'ESRCH')) {
        cleanupError = error;
      }
    }
  };
  const forward = (signal: NodeJS.Signals) => {
    cancelled = true;
    stop(signal);
  };
  const lifecycle = setup(forward, stop, (error) => {
    cleanupError = error;
  });
  let stdout = '';
  let stdoutBytes = 0;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 64 * 1024 * 1024) {
      cleanupError ??= new Error('テスト収集の出力が64MiBを超えました');
      lifecycle.cancel('SIGTERM');
    } else {
      stdout += chunk;
    }
  });
  const interrupt = () => lifecycle.cancel('SIGINT');
  const terminate = () => lifecycle.cancel('SIGTERM');
  child.once('exit', () => stop('SIGKILL'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, fail) => {
        child.once('error', fail);
        child.once('close', (code, signal) => done({ code, signal }));
      },
    );
    assert(cleanupError === undefined, `子プロセスの終了を確認できません: ${String(cleanupError)}`);
    assert(!cancelled && result.code === 0, `検査失敗または取消: ${result.signal ?? result.code}`);
    return { stdout, stderr };
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    lifecycle.cleanup();
  }
}
