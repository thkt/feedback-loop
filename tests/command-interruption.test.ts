import {
  fakeVitest,
  passedVitestReportSource,
  vitestConfig as createVitestConfig,
} from './support/fake-vitest.ts';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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

// 公開CLI境界の制御用fixture。実Vitestのworker終了は固定版の導入検証でも確認する。
const vitestCLI = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
if (process.env.CANCEL_TRACE) {
  const worker = spawn(process.execPath, ['--input-type=module', '-e', "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid })); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((done, fail) => { worker.once('close', done); worker.once('error', fail); });
  process.exitCode = 1;
} else {
  const report = ${passedVitestReportSource("['a', 'b']")};
  const output = process.argv.find(arg => arg.startsWith('--outputFile='));
  if (!output) throw new Error('JSON report output was not requested');
  writeFileSync(output.slice('--outputFile='.length), JSON.stringify(report));
}
`;

for (const target of ['host', 'runtime'] as const) {
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
        await cancelFeedbackCommand(f, target);
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
        ...fakeVitest({ cli: vitestCLI }),
      },
      async (f) => {
        installed(f);
        await writeFile(join(f.repo, 'scripts/changed.ts'), 'export {};\n');
        const control = run(f, ['run', 'test:affected']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain('quality選択: 2');
        await cancelFeedbackCommand(f, target);
        const repaired = run(f, ['run', 'test:affected']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output).toContain('quality選択: 2');
      },
    );
  }, 20000);
}
