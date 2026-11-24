import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, header, installed } from './support/feedback-loop-batch.ts';
import { baseEnv } from './support/runner-affected.ts';
import { vitestModules } from './support/vitest.ts';

const beating = `${header}import { appendFileSync } from 'node:fs';
test('beat', async () => {
  for (let count = 0; count < 200; count++) {
    appendFileSync(process.env.BEAT_LOG ?? '/dev/null', 'x');
    await Bun.sleep(100);
  }
}, 30000);
`;

const interruptionFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  '.feedback-loop.json': JSON.stringify({
    ...config,
    bunWorkers: 1,
    testArgs: ['--timeout', '4000'],
  }),
  'src/rules.ts': 'export function isAdult(age: number) {\n  return age >= 18;\n}\n',
  'test/rules.test.ts': `${header}import { isAdult } from '../src/rules.ts';
test('adult', () => expect(isAdult(30)).toBe(true));
`,
  'test/beat.test.ts': beating,
};

for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
  test(`${signal}で取り消すと、mutatorが起こしたテストのプロセスも止まり、標準出力に何も書かず非ゼロで終わる`, async () => {
    await fixture(interruptionFiles, async (f) => {
      await symlink(vitestModules, join(f.repo, 'node_modules'));
      installed(f);
      const beat = join(f.signals, 'beat.log');
      const child = spawn(
        process.execPath,
        ['--no-env-file', 'scripts/feedback-loop/runtime.mjs', 'mutation', 'src/rules.ts'],
        {
          cwd: f.repo,
          env: { ...baseEnv(f), BEAT_LOG: beat },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      const closed = new Promise<number | null>((done) =>
        child.once('close', (code) => done(code)),
      );
      try {
        for (let waited = 0; !existsSync(beat) && waited < 60000; waited += 100) {
          await Bun.sleep(100);
        }
        expect(existsSync(beat)).toBe(true);
        child.kill(signal);
        expect(await closed).not.toBe(0);
        expect(stdout).toBe('');
        expect(stderr).not.toContain('書き換えられませんでした');
        await Bun.sleep(1500);
        const settled = statSync(beat).size;
        await Bun.sleep(1500);
        expect(statSync(beat).size).toBe(settled);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await closed;
        }
      }
    });
  }, 120000);
}
