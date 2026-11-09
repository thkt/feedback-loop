import {
  vitestConfig as createVitestConfig,
  vitestModules,
  vitestHeader,
} from './support/vitest.ts';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  config,
  files,
  fixture,
  header,
  installed,
  run,
  seed,
} from './support/feedback-loop-batch.ts';
import { cancelFeedbackCommand } from './support/feedback-loop-cancellation.ts';

for (const { target, expectedCode, outcome } of [
  {
    target: 'host',
    expectedCode: 0,
    outcome: { error: expect.stringContaining('Interrupted execution') as unknown },
  },
  { target: 'runtime', expectedCode: 1, outcome: undefined },
] as const) {
  test(`prepare実行中の${target}取消は処理とpipeを解放し、テスト本体を開始しない`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({
          ...config,
          prepare: [process.execPath, '--no-env-file', 'scripts/prepare.ts'],
        }),
        'scripts/prepare.ts': `import { writeFileSync } from 'node:fs';
if (process.env.CANCEL_TRACE) {
  writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
  setInterval(() => {}, 1000);
} else console.log('PREPARE_COMPLETED');\n`,
        'test/a.test.ts': `${header}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
if (process.env.CANCEL_STARTED) writeFileSync(process.env.CANCEL_STARTED, 'started');
test('a', () => { expect(value).toBeGreaterThan(0); console.log('QUALITY_A_COMPLETED'); });\n`,
      },
      async (f) => {
        installed(f);
        await seed(f);
        const cancelled = await cancelFeedbackCommand(f, target);
        expect(cancelled.aliveBefore).toEqual([true, true]);
        expect(cancelled.code, cancelled.output).toBe(expectedCode);
        expect(cancelled.outcome).toEqual(outcome);
        expect(cancelled.remaining, '取消後も起動した処理が残っています').toEqual([]);
        expect(
          existsSync(join(f.signals, 'test-started')),
          '準備中の取消後にテスト本体が開始しました',
        ).toBe(false);
        const repaired = run(f, ['run', 'test:affected']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output.match(/PREPARE_COMPLETED/g)).toHaveLength(1);
        expect(repaired.output).toContain('QUALITY_A_COMPLETED');
        expect(repaired.output).toContain('quality選択: 1');
        expect(repaired.output).not.toContain('quality全件の理由:');
      },
    );
  }, 20000);

  test(`Vitest実行中の${target}取消はCLI・workerとpipeを解放して成功扱いしない`, async () => {
    const vitestConfig = createVitestConfig(config);
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify(vitestConfig),
        '.gitignore': 'node_modules\n',
        'test/a.test.ts': `${vitestHeader}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
test('a', async () => {
  if (process.env.CANCEL_TRACE) {
    writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
    await new Promise(() => {});
  }
  expect(value).toBeGreaterThan(0);
}, 30000);\n`,
        'test/b.test.ts': `${vitestHeader}test('b', () => expect(1).toBe(1));\n`,
      },
      async (f) => {
        await symlink(vitestModules, join(f.repo, 'node_modules'));
        installed(f);
        await writeFile(join(f.repo, 'scripts/changed.ts'), 'export {};\n');
        const control = run(f, ['run', 'test:affected']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain('quality選択: 2');
        const cancelled = await cancelFeedbackCommand(f, target);
        expect(cancelled.aliveBefore).toEqual([true, true]);
        expect(cancelled.code, cancelled.output).toBe(expectedCode);
        expect(cancelled.outcome).toEqual(outcome);
        expect(cancelled.remaining, '取消後も起動した処理が残っています').toEqual([]);
        const repaired = run(f, ['run', 'test:affected']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output).toContain('quality選択: 2');
      },
    );
  }, 20000);
}
