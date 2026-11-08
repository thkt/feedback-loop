import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isRecord } from '../src/values.ts';
import {
  files,
  fixture,
  header,
  installed,
  recordFile,
  run,
} from './support/feedback-loop-batch.ts';

const dynamicFiles = {
  ...files,
  'test/a.test.ts': `${header}test('dynamic', async () => {
  console.log('DYNAMIC_RAN');
  expect((await import(['..', 'src', 'input.ts'].join('/'))).value).toBeGreaterThan(0);
});\n`,
  'test/b.test.ts': `${header}test('unrelated', () => console.log('UNRELATED_RAN'));\n`,
};

test('シンボリックリンク経由のrepoでも内部の記録を相対パスで照合し、動的importだけから関連選択する', async () => {
  await fixture(dynamicFiles, async (f) => {
    installed(f);
    const linked = join(f.signals, 'linked-repo');
    await symlink(f.repo, linked, 'dir');
    // OSがcwdを実体パスへ解決しても、呼出元が保持する論理パスとの混在を必ず通します。
    const preload = join(f.signals, 'logical-cwd.ts');
    await writeFile(preload, 'process.cwd = () => process.env.LOGICAL_REPO!;\n');
    const env = { BUN_OPTIONS: `--preload=${preload}`, LOGICAL_REPO: linked };
    const logical = { ...f, repo: linked };
    await writeFile(join(linked, 'src/input.ts'), 'export const value = 2;\n');
    const first = run(logical, ['run', 'test:affected'], env);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain('UNRELATED_RAN');
    const saved: unknown = JSON.parse(await readFile(recordFile(linked), 'utf8'));
    expect(saved).toHaveProperty('version', 2);
    expect(saved).toHaveProperty(['tests', 'test/a.test.ts', 'files', 'src/input.ts']);
    assert(isRecord(saved) && isRecord(saved.tests));
    expect(Object.keys(saved.tests).some(isAbsolute)).toBe(false);
    for (const entry of Object.values(saved.tests)) {
      assert(isRecord(entry) && isRecord(entry.files));
      expect(Object.keys(entry.files).some(isAbsolute)).toBe(false);
    }

    await writeFile(join(linked, 'src/input.ts'), 'export const value = 3;\n');
    const partial = run(logical, ['run', 'test:affected'], env);
    expect(partial.code, partial.output).toBe(0);
    expect(partial.output).toMatch(/--changed:.*no test files are affected/);
    expect(partial.output).toContain('DYNAMIC_RAN');
    expect(partial.output).toContain('quality選択: 1件');
    expect(partial.output).not.toContain('UNRELATED_RAN');
    expect(partial.output).not.toContain('quality全件の理由:');
  });
});

test('repo外のモジュールは絶対パスで記録し、未変更なら関連選択を保ち、変更されたら全件へ広げる', async () => {
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
      const saved: unknown = JSON.parse(await readFile(recordFile(f.repo), 'utf8'));
      expect(saved).toHaveProperty('version', 2);
      expect(saved).toHaveProperty(['tests', 'test/b.test.ts', 'files', external]);

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

test('version 1の絶対パスの記録は形が不正として全件実行で作り直す', async () => {
  await fixture(dynamicFiles, async (f) => {
    installed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const first = run(f, ['run', 'test:affected']);
    expect(first.code, first.output).toBe(0);
    const saved: unknown = JSON.parse(await readFile(recordFile(f.repo), 'utf8'));
    assert(isRecord(saved) && isRecord(saved.tests));
    const tests = Object.fromEntries(
      Object.entries(saved.tests).map(([owner, entry]) => {
        assert(isRecord(entry) && isRecord(entry.files));
        return [
          join(f.repo, owner),
          {
            ...entry,
            files: Object.fromEntries(
              Object.entries(entry.files).map(([path, hash]) => [join(f.repo, path), hash]),
            ),
          },
        ];
      }),
    );
    await writeFile(recordFile(f.repo), JSON.stringify({ version: 1, tests }));
    const rebuilt = run(f, ['run', 'test:affected']);
    expect(rebuilt.code, rebuilt.output).toBe(0);
    expect(rebuilt.output).toContain('形が不正なため、記録なしとして扱います');
    expect(rebuilt.output).toContain('UNRELATED_RAN');
    expect(rebuilt.output).toContain('quality選択: 2件');
    const current: unknown = JSON.parse(await readFile(recordFile(f.repo), 'utf8'));
    expect(current).toMatchObject({ version: 2 });
    assert(isRecord(current) && isRecord(current.tests));
    expect(Object.keys(current.tests).sort()).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });
});
