import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, header, installed } from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { linkModules, mutatorFiles } from './support/mutator.ts';
import { baseEnv } from './support/runner-affected.ts';
import { vitestConfig, vitestHeader } from './support/vitest.ts';

const beating = `${header}import { appendFileSync } from 'node:fs';
test('beat', async () => {
  for (let count = 0; count < 200; count++) {
    appendFileSync(process.env.BEAT_LOG ?? '/dev/null', 'x');
    await Bun.sleep(100);
  }
}, 30000);
`;

const interruptionFiles = {
  ...mutatorFiles,
  'src/rules.ts': 'export function isAdult(age: number) {\n  return age >= 18;\n}\n',
  'test/rules.test.ts': `${header}import { isAdult } from '../src/rules.ts';
test('adult', () => expect(isAdult(30)).toBe(true));
`,
  'test/beat.test.ts': beating,
};

async function cancelDuringMutants(
  f: Fixture,
  command: string[],
  signal: NodeJS.Signals,
  env: NodeJS.ProcessEnv = {},
) {
  const beat = join(f.signals, 'beat.log');
  const [executable = '', ...args] = command;
  const child = spawn(executable, args, {
    cwd: f.repo,
    env: { ...baseEnv(f), ...env, BEAT_LOG: beat },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const closed = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
  try {
    for (let waited = 0; !existsSync(beat) && waited < 60000; waited += 100) {
      await Bun.sleep(100);
    }
    expect(existsSync(beat), stderr).toBe(true);
    const started = statSync(beat).size;
    await Bun.sleep(500);
    expect(statSync(beat).size).toBeGreaterThan(started);
    child.kill(signal);
    expect(await closed).not.toBe(0);
    expect(stdout).toBe('');
    await Bun.sleep(1500);
    const settled = statSync(beat).size;
    await Bun.sleep(1500);
    expect(statSync(beat).size).toBe(settled);
    return { stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await closed;
    }
  }
}

for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
  test(`${signal}で取り消すと、mutatorが起こしたテストのプロセスも止まり、標準出力に何も書かず非ゼロで終わる`, async () => {
    await fixture(interruptionFiles, async (f) => {
      await linkModules(f.repo);
      installed(f);
      const { stderr } = await cancelDuringMutants(
        f,
        [
          process.execPath,
          '--no-env-file',
          'scripts/feedback-loop/runtime.mjs',
          'mutation',
          'src/rules.ts',
        ],
        signal,
      );
      expect(stderr).not.toContain('書き換えられませんでした');
    });
  }, 120000);
}

const vitestInterruptionFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  '.feedback-loop.json': JSON.stringify(vitestConfig(config)),
  'src/flag.ts': 'export function beating() {\n  return false;\n}\n',
  'test/a.test.ts': `${vitestHeader}test('a', () => expect(1).toBe(1));\n`,
  'test/b.test.ts': `${vitestHeader}import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { beating } from '../src/flag.ts';
test('beat', async () => {
  for (let count = 0; beating() && count < 200; count++) {
    appendFileSync(process.env.BEAT_LOG ?? '/dev/null', 'x');
    await setTimeout(100);
  }
  expect(typeof beating()).toBe('boolean');
}, 30000);
`,
};

async function nodeAndGitOnly(f: Fixture) {
  const bin = join(f.signals, 'bin');
  await mkdir(bin);
  for (const command of ['node', 'git']) {
    const found = spawnSync('which', [command], { encoding: 'utf8' }).stdout.trim();
    await symlink(found, join(bin, command));
  }
  expect(spawnSync('ps', [], { env: { PATH: bin } }).error).toBeDefined();
  return bin;
}

for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
  test(`Vitestの導入先で、壊し方の実行中に${signal}で取り消すと、psの無いPATHでもVitestのテストのプロセスが止まり、標準出力に何も書かず非ゼロで終わる`, async () => {
    await fixture(vitestInterruptionFiles, async (f) => {
      await linkModules(f.repo);
      installed(f);
      const bin = await nodeAndGitOnly(f);
      await cancelDuringMutants(
        f,
        [join(bin, 'node'), 'scripts/feedback-loop/runtime.mjs', 'mutation', 'src/flag.ts'],
        signal,
        { PATH: bin },
      );
    });
  }, 120000);
}
