import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './support/values.ts';
import { alive, waitFor } from './support/feedback-loop-cancellation.ts';
import {
  baseEnv,
  config,
  files,
  fixture,
  header,
  installed,
  seed,
  run,
} from './support/feedback-loop-batch.ts';

function workerPids(directory: string) {
  return ['b', 'c']
    .map((name) => join(directory, `${name}.pid`))
    .filter(existsSync)
    .map((path) => Number(readFileSync(path, 'utf8')));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`生成入口の${signal}取消は起動済みworkerを終了し、一括候補の成功記録を採用しない`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({ ...config, bunWorkers: 2 }),
        'test/a.test.ts':
          header +
          "import { writeFileSync } from 'node:fs'; test('a', () => { expect(1).toBe(1); if (process.env.BATCH_SIGNALS) writeFileSync(process.env.BATCH_SIGNALS + '/a.done', 'done'); });\n",
        ...Object.fromEntries(
          ['b', 'c'].map((name) => [
            `test/${name}.test.ts`,
            `${header}import { writeFileSync } from 'node:fs';
test('${name}', async () => {
  if (process.env.BATCH_SIGNALS) {
    writeFileSync(process.env.BATCH_SIGNALS + '/${name}.pid', String(process.pid));
    await new Promise(() => {});
  }
  expect(1).toBe(1);
}, 30000);\n`,
          ]),
        ),
      },
      async (f) => {
        installed(f);
        await seed(f);
        await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
        const pkg: unknown = JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'));
        assert(isRecord(pkg) && isRecord(pkg.scripts));
        const script = pkg.scripts['test:affected'];
        assert(typeof script === 'string');
        const argv = script.split(' ');
        expect(argv.shift()).toBe('bun');
        const command = spawn(process.execPath, argv, {
          cwd: f.repo,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...baseEnv(f), BATCH_SIGNALS: f.signals },
        });
        let output = '';
        command.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
        command.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
        let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        const ended = new Promise<void>((done, fail) => {
          command.once('close', (code, signal) => {
            result = { code, signal };
            done();
          });
          command.once('error', fail);
        });
        try {
          await waitFor(
            () => existsSync(join(f.signals, 'a.done')) && existsSync(join(f.signals, 'b.pid')),
            () => `取消前の成功対照と実行中テストが揃いません: ${output}`,
          );
          const pids = workerPids(f.signals);
          expect(pids.length).toBeGreaterThan(0);
          expect(pids.every(alive)).toBe(true);
          command.kill(signal);
          await waitFor(
            () => result !== undefined,
            () => `取消が完了しません: ${output}`,
          );
          expect(result?.code, output).not.toBe(0);
          await waitFor(
            () => workerPids(f.signals).every((pid) => !alive(pid)),
            () => '生成入口の終了後もworkerが残っています',
            1000,
          );
          await unlink(join(f.repo, 'new-input.txt'));
          await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
          await writeFile(
            join(f.repo, 'test/d.test.ts'),
            `${header}test('d', () => expect(1).toBe(1));\n`,
          );
          const retried = run(f, ['run', 'test:affected']);
          expect(retried.code, retried.output).toBe(0);
          expect(retried.output).toContain('quality選択: 4');
          expect(retried.output).toContain('信頼できる依存記録なし');
        } finally {
          if (command.pid !== undefined) {
            try {
              process.kill(-command.pid, 'SIGKILL');
            } catch (error) {
              assert(isRecord(error) && error.code === 'ESRCH', String(error));
            }
          }
          await ended;
        }
      },
    );
  }, 20000);
}
