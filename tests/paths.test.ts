import { expect, test } from 'bun:test';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { files, fixture, header, installed, run } from './support/feedback-loop-batch.ts';

const dynamicFiles = {
  ...files,
  'test/a.test.ts': `${header}test('dynamic', async () => {
  console.log('DYNAMIC_RAN');
  expect((await import(['..', 'src', 'input.ts'].join('/'))).value).toBeGreaterThan(0);
});\n`,
  'test/b.test.ts': `${header}test('unrelated', () => console.log('UNRELATED_RAN'));\n`,
};

test('repo内のシンボリックリンク経由の動的importから関連選択する', async () => {
  await fixture(dynamicFiles, async (f) => {
    await symlink('src', join(f.repo, 'linked-src'), 'dir');
    await writeFile(
      join(f.repo, 'test/a.test.ts'),
      dynamicFiles['test/a.test.ts'].replace("'src'", "'linked-src'"),
    );
    installed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const first = run(f, ['run', 'test:affected']);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain('UNRELATED_RAN');

    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
    const partial = run(f, ['run', 'test:affected']);
    expect(partial.code, partial.output).toBe(0);
    expect(partial.output).toContain('DYNAMIC_RAN');
    expect(partial.output).toContain('quality選択: 1件');
    expect(partial.output).not.toContain('UNRELATED_RAN');
    expect(partial.output).not.toContain('quality全件の理由:');
  });
});

test('repo外のモジュールが未変更なら関連選択を保ち、変更されたら全件へ広げる', async () => {
  await fixture(
    {
      ...dynamicFiles,
      'test/b.test.ts': `${header}import { value } from '../../external.ts';
test('external', () => { console.log('EXTERNAL_RAN'); expect(value).toBeGreaterThan(0); });\n`,
    },
    async (f) => {
      const external = join(f.repo, '..', 'external.ts');
      await writeFile(external, 'export const value = 1;\n');
      installed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const first = run(f, ['run', 'test:affected']);
      expect(first.code, first.output).toBe(0);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      const partial = run(f, ['run', 'test:affected']);
      expect(partial.code, partial.output).toBe(0);
      expect(partial.output).toContain('DYNAMIC_RAN');
      expect(partial.output).toContain('quality選択: 1件');
      expect(partial.output).not.toContain('EXTERNAL_RAN');
      expect(partial.output).not.toContain('quality全件の理由:');

      await writeFile(external, 'export const value = 2;\n');
      const stale = run(f, ['run', 'test:affected']);
      expect(stale.code, stale.output).toBe(0);
      expect(stale.output).toContain('古い、または基点不明の依存記録');
      expect(stale.output).toContain('EXTERNAL_RAN');
      expect(stale.output).toContain('quality選択: 2件');
    },
  );
});
