import { expect, test } from 'bun:test';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  files,
  fixture,
  header,
  installed,
  recordFile,
  run,
  seed,
  type Fixture,
} from '../../support/feedback-loop-batch.ts';
import { git } from '../../support/runner-affected.ts';

// テストの読むモジュールを増やし、次の成功で記録の内容が必ず変わるようにします。
async function importNewModule(f: Fixture, name: string) {
  await writeFile(join(f.repo, `src/${name}.ts`), 'export const extra = 1;\n');
  await writeFile(
    join(f.repo, 'test/a.test.ts'),
    `${header}import '../src/${name}.ts'; import { value } from '../src/input.ts'; test('a', () => expect(value).toBeGreaterThan(0));\n`,
  );
}

test('成功は記録を置き換え、退避ファイルを作らない', async () => {
  await fixture(files, async (f) => {
    installed(f);
    const original = await seed(f);
    for (const name of ['first', 'second']) {
      await importNewModule(f, name);
      const result = run(f, ['run', 'test:affected']);
      expect(result.code, result.output).toBe(0);
      expect(await readFile(recordFile(f.repo), 'utf8')).toContain(`src/${name}.ts`);
    }
    expect(await readFile(recordFile(f.repo), 'utf8')).not.toBe(original);
    expect((await readdir(dirname(recordFile(f.repo)))).sort()).toEqual([
      '.gitignore',
      'records.json',
    ]);
  });
});

test('旧形式の記録と未完了の印は読まず残し、新形式で関連選択へ戻る', async () => {
  await fixture(files, async (f) => {
    installed(f);
    await seed(f);
    const directory = dirname(recordFile(f.repo));
    await unlink(recordFile(f.repo));
    const legacy = [
      'test-deps.json',
      'test-deps.json.basis.json',
      'test-deps.json.pending',
      'test-deps.json.hash.previous',
    ];
    for (const name of legacy) {
      await writeFile(join(directory, name), 'legacy');
    }
    const first = run(f, ['run', 'test:affected']);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain('信頼できる依存記録なし');
    expect(first.output).toContain('quality選択: 2');
    const next = run(f, ['run', 'test:affected']);
    expect(next.code, next.output).toBe(0);
    expect(next.output).toContain('quality選択: 1');
    expect(next.output).not.toContain('quality全件の理由:');
    for (const name of legacy) {
      expect(await readFile(join(directory, name), 'utf8')).toBe('legacy');
    }
  });
});

test('quality削除を比較元へ取り込んだ後も、現行全件の成功記録から関連選択へ戻る', async () => {
  await fixture(
    {
      ...files,
      'test/c.test.ts':
        header + "test('c', () => { console.log('UNRELATED_C'); expect(1).toBe(1); });\n",
    },
    async (f) => {
      installed(f);
      await seed(f);
      await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
      await unlink(join(f.repo, 'test/b.test.ts'));
      git(f.repo, 'add', '-A');
      git(f.repo, 'commit', '-m', 'remove quality b');
      expect(git(f.repo, 'diff', '--name-only', 'main')).toBe('');

      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const refreshed = run(f, ['run', 'test:affected']);
      expect(refreshed.code, refreshed.output).toBe(0);
      expect(refreshed.output).toContain('quality選択: 2');
      expect(refreshed.output).toContain('UNRELATED_C');
      expect(await readFile(recordFile(f.repo), 'utf8')).toContain(join(f.repo, 'test/b.test.ts'));

      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      expect(git(f.repo, 'diff', '--name-only', 'main')).toBe('src/input.ts');
      const affected = run(f, ['run', 'test:affected']);
      expect(affected.code, affected.output).toBe(0);
      expect(affected.output).toContain('quality候補: 2');
      expect(affected.output).toContain('quality選択: 1');
      expect(affected.output).not.toContain('UNRELATED_C');
      expect(affected.output).not.toContain('quality全件の理由:');
      expect(await readFile(recordFile(f.repo), 'utf8')).toContain(join(f.repo, 'test/b.test.ts'));
    },
  );
});
