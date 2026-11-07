import { hasErrorCode } from '../../shared/values.ts';

// 取消のテストで、コマンドをプロセスグループごと起動して終了させるホストを模します。
// 順に実行する1つのコマンドだけを扱い、同時実行には対応しません。
type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const interruptionMessage =
  'Interrupted execution: reconcile existing process and evidence before continuing';
let interrupted = false;
let activeGroup: { pid: number; killSent: boolean } | undefined;
// 終了を確認できないgroupを残した場合は、新しいコマンドを開始しません。
let cleanupFailure: { group: number; cause: unknown } | undefined;

function killGroup(pid: number | undefined) {
  const group = activeGroup;
  if (!group || pid !== group.pid || group.killSent || cleanupFailure) {
    return;
  }
  try {
    process.kill(-group.pid, 'SIGKILL');
    group.killSent = true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      activeGroup = undefined;
    } else {
      cleanupFailure = { group: group.pid, cause: error };
      interrupted = true;
    }
  }
}

async function waitForGroup(pid: number) {
  const deadline = performance.now() + 1000;
  try {
    while (pid === activeGroup?.pid && !cleanupFailure) {
      let failure: unknown;
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (!hasErrorCode(error, 'EPERM')) {
          throw error;
        }
        failure = error;
      }
      if (performance.now() >= deadline) {
        throw failure ?? Error('SIGKILL送信後もプロセスグループの消滅を1秒以内に確認できません');
      }
      await Bun.sleep(10);
    }
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      activeGroup = undefined;
    } else {
      cleanupFailure = { group: pid, cause: error };
      interrupted = true;
    }
  }
}

function interrupt() {
  interrupted = true;
  killGroup(activeGroup?.pid);
}

function assertRunning() {
  if (interrupted || cleanupFailure) {
    throw Error(interruptionMessage);
  }
}

export async function command(
  argv: string[],
  cwd: string,
  timeoutMs: number | null,
): Promise<CommandResult> {
  assertRunning();
  let stdout = '',
    stderr = '',
    timedOut = false;
  let exitCode: number | null | undefined;
  let openPipes = 2;
  let resolveCode: (code: number | null) => void = () => {};
  const finished = new Promise<number | null>((resolve) => {
    resolveCode = resolve;
  });
  const settle = () => {
    if (exitCode !== undefined && openPipes === 0) {
      resolveCode(exitCode);
    }
  };
  const child = Bun.spawn(argv, {
    cwd,
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    onExit(subprocess, code, signal, error) {
      exitCode = signal === null ? code : null;
      if (error) {
        stderr += `${error.message}\n`;
      }
      killGroup(subprocess.pid);
      settle();
    },
  });
  activeGroup = { pid: child.pid, killSent: false };
  // onExitはspawnが返る前に呼ばれる場合もある。
  if (exitCode !== undefined) {
    killGroup(child.pid);
  }
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  for (const [index, reader] of readers.entries()) {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const append = (text: string) => {
      if (index === 0) {
        stdout += text;
      } else {
        stderr += text;
      }
    };
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          append(decoder.decode(value, { stream: true }));
        }
        append(decoder.decode());
      } catch (error) {
        stderr += `${String(error)}\n`;
        interrupt();
      } finally {
        openPipes--;
        reader.releaseLock();
        settle();
      }
    })().catch((error: unknown) => {
      stderr += `${String(error)}\n`;
      interrupt();
      resolveCode(exitCode ?? null);
    });
  }
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          killGroup(child.pid);
        }, timeoutMs);
  const poll = setInterval(() => {
    if (cleanupFailure) {
      resolveCode(exitCode ?? null);
    }
  }, 50);
  const code = await finished;
  clearTimeout(timer);
  clearInterval(poll);
  killGroup(child.pid);
  await waitForGroup(child.pid);
  if (cleanupFailure) {
    for (const reader of readers) {
      void reader.cancel().catch(() => {});
    }
    child.unref();
    throw new Error(
      `プロセスグループの終了を確認できません (${cleanupFailure.group}, ${argv[0]}, ${cwd}): ${String(cleanupFailure.cause)}`,
      { cause: cleanupFailure.cause },
    );
  }
  assertRunning();
  return { code, stdout, stderr, timedOut };
}

export async function withInterrupts<T>(action: () => Promise<T>): Promise<T> {
  interrupted = false;
  assertRunning();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const result = await action();
    assertRunning();
    return result;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
