import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { isRecord } from '../../../shared/values.ts';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  config,
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

test('依存記録がなければ全qualityを実行し、次の実行で関連選択へ戻る', async () => {
  await fixture(files, async (f) => {
    installed(f);
    await seed(f);
    await unlink(recordFile(f.repo));
    const first = run(f, ['run', 'test:affected']);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain('信頼できる依存記録なし');
    expect(first.output).toContain('quality選択: 2');
    const next = run(f, ['run', 'test:affected']);
    expect(next.code, next.output).toBe(0);
    expect(next.output).toContain('quality選択: 1');
    expect(next.output).not.toContain('quality全件の理由:');
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

for (const fail of [false, true]) {
  test(`補完実行の${fail ? '失敗は先行成功も記録から外し' : '成功は記録を更新し'}、対象外の記録を変えない`, async () => {
    await fixture(
      {
        ...files,
        'data/input.json': '{}\n',
        '.feedback-loop.json': JSON.stringify({
          ...config,
          dependencies: [{ inputs: ['data/input.json'], tests: ['test/b.test.ts'] }],
        }),
        'test/b.test.ts':
          header + "test('b', () => expect(process.env.FAIL_FALLBACK).not.toBe('1'));\n",
        'src/other.ts': 'export const other = 1;\n',
        'test/c.test.ts':
          header +
          "import { other } from '../src/other.ts'; test('c', () => expect(other).toBeGreaterThan(0));\n",
      },
      async (f) => {
        installed(f);
        const original: unknown = JSON.parse(await seed(f));
        assert(isRecord(original) && isRecord(original.tests));
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
        await writeFile(join(f.repo, 'data/input.json'), '{"changed":true}\n');
        const result = run(f, ['run', 'test:affected'], { FAIL_FALLBACK: fail ? '1' : '0' });
        expect(result.code, result.output).toBe(fail ? 1 : 0);
        expect(result.output).toContain('(pass) a');
        expect(result.output).toContain(fail ? '(fail) b' : '(pass) b');
        expect(result.output.split('\n').filter((line) => line.startsWith('実行: '))).toHaveLength(
          2,
        );
        expect(result.output).not.toContain('quality全件の理由:');
        const current: unknown = JSON.parse(await readFile(recordFile(f.repo), 'utf8'));
        for (const name of ['a', 'b']) {
          if (fail) {
            expect(current).not.toHaveProperty(['tests', join(f.repo, `test/${name}.test.ts`)]);
          } else {
            expect(current).toHaveProperty(['tests', join(f.repo, `test/${name}.test.ts`)]);
          }
        }
        const excluded = join(f.repo, 'test/c.test.ts');
        expect(current).toHaveProperty(['tests', excluded], original.tests[excluded]);
        if (fail) {
          await writeFile(join(f.repo, 'data/input.json'), '{}\n');
          await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
          await writeFile(join(f.repo, 'src/other.ts'), 'export const other = 2;\n');
          const retried = run(f, ['run', 'test:affected']);
          expect(retried.code, retried.output).toBe(0);
          expect(retried.output).toContain('(pass) a');
          expect(retried.output).toContain('(pass) b');
          expect(retried.output).toContain('(pass) c');
          expect(retried.output).toContain('quality選択: 3');
          expect(retried.output).not.toContain('quality全件の理由:');
        }
      },
    );
  });
}

for (const mixed of [false, true]) {
  test(`${mixed ? '他のテストが成功しても' : '全体が未実行で失敗しても'}全skipの行を記録から外す`, async () => {
    await fixture(
      {
        ...files,
        'test/a.test.ts': files['test/a.test.ts'].replace(
          "test('a'",
          "(process.env.SKIP_A ? test.skip : test)('a'",
        ),
      },
      async (f) => {
        installed(f);
        const original: unknown = JSON.parse(await seed(f));
        assert(isRecord(original) && isRecord(original.tests));
        if (mixed) {
          await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
        }
        const result = run(f, ['run', 'test:affected'], { SKIP_A: '1' });
        expect(result.code, result.output).toBe(mixed ? 0 : 1);
        expect(result.output).toContain(`quality選択: ${mixed ? 2 : 1}`);
        expect(result.output).toContain(
          mixed ? '(pass) b' : '未実行: 選択したテストがすべてskipされています',
        );
        const current: unknown = JSON.parse(await readFile(recordFile(f.repo), 'utf8'));
        expect(current).not.toHaveProperty(['tests', join(f.repo, 'test/a.test.ts')]);
        const untouched = join(f.repo, 'test/b.test.ts');
        expect(current).toHaveProperty(['tests', untouched], original.tests[untouched]);
      },
    );
  });
}
