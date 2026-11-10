import {
  vitestConfig as createVitestConfig,
  vitestModules,
  vitestHeader,
} from './support/vitest.ts';
import { fakeVitest } from './support/fake-vitest.ts';
import { expect, test } from 'bun:test';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, installed, run } from './support/feedback-loop-batch.ts';

for (const { selection, input, selected } of [
  { selection: 'full', input: 'scripts/changed.ts', selected: 'quality選択: 3' },
  { selection: 'related', input: 'src/input.ts', selected: 'quality選択: 2' },
]) {
  test(`Vitestの${selection}実行は選択ファイルの結果欠落を成功にしない`, async () => {
    const vitestConfig = createVitestConfig(config);
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify(vitestConfig),
        'test/c.test.ts': 'export {};\n',
        ...fakeVitest({ relevant: ['test/a.test.ts', 'test/b.test.ts'] }),
      },
      async (f) => {
        installed(f);
        await writeFile(join(f.repo, input), 'export const value = 2;\n');
        const control = run(f, ['run', 'test:affected']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain(selected);

        const missing = run(f, ['run', 'test:affected'], { VITEST_RESULT_FAULT: 'missing' });
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
      ...fakeVitest({ relevant: ['test/a.test.ts'] }),
    },
    async (f) => {
      installed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const missing = run(f, ['run', 'test:affected'], {
        VITEST_RESULT_FAULT: 'missing-imported',
      });
      expect(missing.code, missing.output).not.toBe(0);
      expect(missing.output).toContain('Vitestの選択したテストの結果が欠落しています');
    },
  );
});

for (const { kind, unexecuted } of [
  { kind: 'skip', unexecuted: "test.skip('unexecuted', () => expect(1).toBe(2));\n" },
  { kind: 'todo', unexecuted: "test.todo('unexecuted');\n" },
]) {
  for (const { allowSkipped, code, diagnostic } of [
    { allowSkipped: true, code: 0, diagnostic: 'quality選択: 3' },
    { allowSkipped: false, code: 1, diagnostic: '未実行: Vitestにskipまたはtodoがあります' },
  ]) {
    test(`Vitestで${kind}が混在すると許可=${allowSkipped}に従い、全件未実行なら失敗する`, async () => {
      await fixture(
        {
          ...files,
          '.gitignore': 'node_modules\n',
          '.feedback-loop.json': JSON.stringify(createVitestConfig({ ...config, allowSkipped })),
          'test/a.test.ts': vitestHeader + unexecuted,
          'test/b.test.ts': `${vitestHeader}test('b', () => expect(1).toBe(1));\n`,
          'test/c.test.ts': `${vitestHeader}test('c', () => expect(1).toBe(1));\n`,
        },
        async (f) => {
          await symlink(vitestModules, join(f.repo, 'node_modules'));
          installed(f);
          await writeFile(join(f.repo, 'scripts/changed.ts'), 'export {};\n');
          const mixed = run(f, ['run', 'test:affected']);
          expect(mixed.code, mixed.output).toBe(code);
          expect(mixed.output).toContain(diagnostic);
          await writeFile(join(f.repo, 'test/b.test.ts'), vitestHeader + unexecuted);
          await writeFile(join(f.repo, 'test/c.test.ts'), vitestHeader + unexecuted);
          const none = run(f, ['run', 'test:affected']);
          expect(none.code, none.output).not.toBe(0);
          expect(none.output).toContain('未実行: Vitestで成功したテストがありません');
        },
      );
    });
  }
}
