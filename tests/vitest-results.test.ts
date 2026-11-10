import {
  vitestConfig as createVitestConfig,
  vitestModules,
  vitestHeader,
} from './support/vitest.ts';
import { expect, test } from 'bun:test';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, installed, run } from './support/feedback-loop-batch.ts';

// DROP_Bを設定すると、Vitestの設定がtest/b.test.tsを除外する。収集のコマンドはbを一覧に含めたままである。
const vitestFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  'vitest.config.ts': `import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ...(process.env.DROP_B ? ['test/b.test.ts'] : [])] },
});
`,
  'test/a.test.ts': `${vitestHeader}import { value } from '../src/input.ts';\ntest('a', () => expect(value).toBeGreaterThan(0));\n`,
  'test/b.test.ts': `${vitestHeader}test('b', () => expect(1).toBe(1));\n`,
  'test/c.test.ts': `${vitestHeader}test('c', () => expect(1).toBe(1));\n`,
};

test('全qualityの実行で、Vitestが実行しなかったqualityがあれば成功にしない', async () => {
  await fixture(
    { ...vitestFiles, '.feedback-loop.json': JSON.stringify(createVitestConfig(config)) },
    async (f) => {
      await symlink(vitestModules, join(f.repo, 'node_modules'));
      installed(f);
      await writeFile(join(f.repo, 'scripts/changed.ts'), 'export const value = 2;\n');
      const control = run(f, ['run', 'test:affected'], {}, 60000);
      expect(control.code, control.output).toBe(0);
      expect(control.output).toContain('quality選択: 3');

      const missing = run(f, ['run', 'test:affected'], { DROP_B: '1' }, 60000);
      expect(missing.code, missing.output).not.toBe(0);
      expect(missing.output).toContain('Vitestの選択したテストの結果が欠落しています');
      expect(missing.output).not.toContain('選択したqualityが成功しました');
    },
  );
});

test('明示依存で選んだqualityをVitestが実行しなければ成功にしない', async () => {
  const vitestConfig = createVitestConfig({
    ...config,
    dependencies: [{ inputs: ['src/input.ts'], tests: ['test/b.test.ts'] }],
  });
  await fixture(
    { ...vitestFiles, '.feedback-loop.json': JSON.stringify(vitestConfig) },
    async (f) => {
      await symlink(vitestModules, join(f.repo, 'node_modules'));
      installed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const control = run(f, ['run', 'test:affected'], {}, 60000);
      expect(control.code, control.output).toBe(0);
      expect(control.output).toContain('quality選択: 2');

      const missing = run(f, ['run', 'test:affected'], { DROP_B: '1' }, 60000);
      expect(missing.code, missing.output).not.toBe(0);
      expect(missing.output).toContain('Vitestの選択したテストの結果が欠落しています');
      expect(missing.output).not.toContain('選択したqualityが成功しました');
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
