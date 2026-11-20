import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const runnerScript = `import { commandRunner } from ${JSON.stringify(resolve(import.meta.dir, '../../src/command.ts'))};
const run = commandRunner(${JSON.stringify(resolve(import.meta.dir, '../../src/runtime.ts'))}, 'runner');
await run(JSON.parse(process.env.RUNNER_ARGV), { display: ['command'] });
`;

export const runnerHeader = '実行: command; 再実行: runner\n';

export async function runWithPipedStdout(
  argv: string[],
  env: NodeJS.ProcessEnv,
  { readStdoutAfterMs = 0 } = {},
) {
  const reader = spawn('sh', ['-c', 'sleep "$0"; exec cat', String(readStdoutAfterMs / 1000)], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const runner = spawn(process.execPath, ['-e', runnerScript], {
    env: { ...env, RUNNER_ARGV: JSON.stringify(argv) },
    stdio: ['ignore', reader.stdin, 'pipe'],
  });
  reader.stdin.destroy();
  const stdout: Buffer[] = [];
  let stderr = '';
  reader.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  runner.stderr.setEncoding('utf8');
  runner.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await Promise.all([
    new Promise<number | null>((done) => runner.once('exit', done)),
    new Promise<void>((done) => reader.stdout.once('end', done)),
    new Promise<void>((done) => runner.stderr.once('end', done)),
  ]);
  return { code, stdout: Buffer.concat(stdout), stderr };
}
