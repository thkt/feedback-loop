import {
  fakeVitest,
  passedVitestReportSource,
  vitestConfig as createVitestConfig,
} from './support/fake-vitest.ts';
import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, installed, run } from './support/feedback-loop-batch.ts';

// CLI境界の制御テスト。実Vitestとの互換性は固定版を使う導入検証で別に確認する。
const cli = `import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const selected = process.argv.includes('related') ? ['a', 'b'] : ['a', 'b', 'c'];
const report = ${passedVitestReportSource('selected')};
writeFileSync(process.env.VITEST_REPORT_BEFORE, JSON.stringify(report));
if (process.env.VITEST_RESULT_FAULT === 'missing') report.testResults.splice(1, 1);
if (process.env.VITEST_RESULT_FAULT === 'missing-imported') report.testResults.splice(0, 1);
const argument = process.argv.find(value => value.startsWith('--outputFile='));
if (!argument) throw new Error('JSON report output was not requested');
writeFileSync(argument.slice('--outputFile='.length), JSON.stringify(report));
writeFileSync(process.env.VITEST_REPORT_AFTER, JSON.stringify(report));
`;

for (const selection of ['full', 'related']) {
  test(`Vitestの${selection}実行は選択ファイルの結果欠落を成功にしない`, async () => {
    const vitestConfig = createVitestConfig(config);
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify(vitestConfig),
        'test/c.test.ts': 'export {};\n',
        ...fakeVitest({ cli: cli, relevant: ['test/a.test.ts', 'test/b.test.ts'] }),
      },
      async (f) => {
        installed(f);
        const input = selection === 'full' ? 'scripts/changed.ts' : 'src/input.ts';
        await writeFile(join(f.repo, input), 'export const value = 2;\n');
        const env = {
          VITEST_REPORT_BEFORE: join(f.signals, 'before.json'),
          VITEST_REPORT_AFTER: join(f.signals, 'after.json'),
        };
        const control = run(f, ['run', 'test:affected'], env);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain(`quality選択: ${selection === 'full' ? 3 : 2}`);
        expect(await readFile(env.VITEST_REPORT_AFTER, 'utf8')).toBe(
          await readFile(env.VITEST_REPORT_BEFORE, 'utf8'),
        );

        const missing = run(f, ['run', 'test:affected'], {
          ...env,
          VITEST_RESULT_FAULT: 'missing',
        });
        expect(await readFile(env.VITEST_REPORT_BEFORE, 'utf8')).toContain('/test/b.test.ts');
        expect(await readFile(env.VITEST_REPORT_AFTER, 'utf8')).not.toContain('/test/b.test.ts');
        expect(missing.code, missing.output).not.toBe(0);
        expect(missing.output).toContain('Vitestの選択したテストの結果が欠落しています');
        expect(missing.output).not.toContain('選択したqualityが成功しました');
      },
    );
  });
}

test('Vitestは明示依存のある入力でも、importの到達先の結果欠落を成功にしない', async () => {
  const vitestConfig = createVitestConfig({
    ...config,
    dependencies: [{ inputs: ['src/input.ts'], tests: ['test/b.test.ts'] }],
  });
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify(vitestConfig),
      ...fakeVitest({ cli: cli, relevant: ['test/a.test.ts'] }),
    },
    async (f) => {
      installed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const missing = run(f, ['run', 'test:affected'], {
        VITEST_REPORT_BEFORE: join(f.signals, 'before.json'),
        VITEST_REPORT_AFTER: join(f.signals, 'after.json'),
        VITEST_RESULT_FAULT: 'missing-imported',
      });
      expect(missing.code, missing.output).not.toBe(0);
      expect(missing.output).toContain('Vitestの選択したテストの結果が欠落しています');
    },
  );
});

for (const kind of ['pending', 'todo']) {
  for (const allowSkipped of [true, false]) {
    test(`Vitestで${kind}が混在すると許可=${allowSkipped}に従い、全件未実行なら失敗する`, async () => {
      const vitestConfig = createVitestConfig({ ...config, allowSkipped });
      const skippedCLI = cli.replace(
        'writeFileSync(process.env.VITEST_REPORT_BEFORE, JSON.stringify(report));',
        `
const count = process.env.VITEST_ALL_SKIPPED === '1' ? selected.length : 1;
report.numPassedTests -= count;
report.numPendingTests = ${kind === 'pending' ? 'count' : '0'};
report.numTodoTests = ${kind === 'todo' ? 'count' : '0'};
for (const item of report.testResults.slice(0, count)) item.assertionResults[0].status = '${kind}';
writeFileSync(process.env.VITEST_REPORT_BEFORE, JSON.stringify(report));`,
      );
      await fixture(
        {
          ...files,
          '.feedback-loop.json': JSON.stringify(vitestConfig),
          'test/c.test.ts': 'export {};\n',
          ...fakeVitest({ cli: skippedCLI, relevant: [] }),
        },
        async (f) => {
          installed(f);
          await writeFile(join(f.repo, 'scripts/changed.ts'), 'export {};\n');
          const env = {
            VITEST_REPORT_BEFORE: join(f.signals, 'before.json'),
            VITEST_REPORT_AFTER: join(f.signals, 'after.json'),
          };
          const mixed = run(f, ['run', 'test:affected'], env);
          if (allowSkipped) {
            expect(mixed.code, mixed.output).toBe(0);
            expect(mixed.output).toContain('quality選択: 3');
          } else {
            expect(mixed.code, mixed.output).not.toBe(0);
            expect(mixed.output).toContain('未実行: Vitestにskipまたはtodoがあります');
          }
          const none = run(f, ['run', 'test:affected'], { ...env, VITEST_ALL_SKIPPED: '1' });
          expect(none.code, none.output).not.toBe(0);
          expect(none.output).toContain('未実行: Vitestで成功したテストがありません');
        },
      );
    });
  }
}
