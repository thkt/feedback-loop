import { expect, test } from 'bun:test';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  config,
  files,
  fixture,
  header,
  installed,
  recordFile,
  run,
  seed,
} from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/runner-affected.ts';
import { commitFixture, git } from './support/runner-affected.ts';

test('成功したqualityは依存先を更新し、実行対象外のqualityの記録を残す', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        dependencies: [{ inputs: ['src/first.ts'], tests: ['test/b.test.ts'] }],
      }),
      'src/first.ts': 'export const value = 1;\n',
      'src/second.ts': 'export const value = 1;\n',
      'test/a.test.ts': `${header}test('a', async () => {
      expect((await import('../src/' + (process.env.MODULE ?? 'first') + '.ts')).value).toBeGreaterThan(0);
    });\n`,
    },
    async (f) => {
      installed(f);
      await seed(f);
      const updated = run(f, ['run', 'test:affected'], { MODULE: 'second' });
      expect(updated.code, updated.output).toBe(0);
      await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
      await writeFile(join(f.repo, 'src/first.ts'), 'export const value = 2;\n');
      const replaced = run(f, ['run', 'test:affected'], { MODULE: 'second' });
      expect(replaced.code, replaced.output).toBe(0);
      expect(replaced.output).toContain('(pass) b');
      expect(replaced.output).not.toContain('(pass) a');
      expect(replaced.output).toContain('quality選択: 1');
      expect(replaced.output).not.toContain('quality全件の理由:');
      await writeFile(join(f.repo, 'src/first.ts'), 'export const value = 1;\n');
      await writeFile(join(f.repo, 'src/second.ts'), 'export const value = 2;\n');
      const selected = run(f, ['run', 'test:affected'], { MODULE: 'second' });
      expect(selected.code, selected.output).toBe(0);
      expect(selected.output).toContain('(pass) a');
      expect(selected.output).not.toContain('(pass) b');
      expect(selected.output).toContain('quality選択: 1');
      expect(selected.output).not.toContain('quality全件の理由:');
    },
  );
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
      commitFixture(f.repo, 'remove quality b');
      expect(git(f.repo, 'diff', '--name-only', 'main')).toBe('');

      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const refreshed = run(f, ['run', 'test:affected']);
      expect(refreshed.code, refreshed.output).toBe(0);
      expect(refreshed.output).toContain('quality選択: 2');
      expect(refreshed.output).toContain('UNRELATED_C');

      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      expect(git(f.repo, 'diff', '--name-only', 'main')).toBe('src/input.ts');
      const affected = run(f, ['run', 'test:affected']);
      expect(affected.code, affected.output).toBe(0);
      expect(affected.output).toContain('quality候補: 2');
      expect(affected.output).toContain('quality選択: 1');
      expect(affected.output).not.toContain('UNRELATED_C');
      expect(affected.output).not.toContain('quality全件の理由:');
    },
  );
});

for (const {
  name,
  failFallback,
  code,
  bResult,
  retryInput,
  retryOther,
  retryIncludes,
  retryExcludes,
} of [
  {
    // bとcの記録が欠けると、未記録のqualityとして選ばれる。
    name: '成功は補完したテストと対象外の記録を保つ',
    failFallback: '0',
    code: 0,
    bResult: '(pass) b',
    retryInput: 'export const value = 3;\n',
    retryOther: 'export const other = 1;\n',
    retryIncludes: ['quality選択: 1'],
    retryExcludes: ['(pass) b', '(pass) c'],
  },
  {
    // cの記録まで欠けると、信頼できる依存記録なしとして全件の理由が出る。
    name: '失敗は先行成功も記録から外し、対象外の記録を保つ',
    failFallback: '1',
    code: 1,
    bResult: '(fail) b',
    retryInput: 'export const value = 1;\n',
    retryOther: 'export const other = 2;\n',
    retryIncludes: ['(pass) b', '(pass) c', 'quality選択: 3'],
    retryExcludes: [],
  },
]) {
  test(`補完実行の${name}`, async () => {
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
        await seed(f);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
        await writeFile(join(f.repo, 'data/input.json'), '{"changed":true}\n');
        const result = run(f, ['run', 'test:affected'], { FAIL_FALLBACK: failFallback });
        expect(result.code, result.output).toBe(code);
        expect(result.output).toContain('(pass) a');
        expect(result.output).toContain(bResult);
        expect(result.output).not.toContain('quality全件の理由:');
        await writeFile(join(f.repo, 'data/input.json'), '{}\n');
        await writeFile(join(f.repo, 'src/input.ts'), retryInput);
        await writeFile(join(f.repo, 'src/other.ts'), retryOther);
        const retried = run(f, ['run', 'test:affected']);
        expect(retried.code, retried.output).toBe(0);
        expect(retried.output).toContain('(pass) a');
        for (const marker of retryIncludes) {
          expect(retried.output).toContain(marker);
        }
        for (const marker of retryExcludes) {
          expect(retried.output).not.toContain(marker);
        }
        expect(retried.output).not.toContain('quality全件の理由:');
      },
    );
  });
}

for (const { name, changeInput, code, selection, diagnostic } of [
  {
    name: '全体が未実行で失敗して',
    changeInput: (f: Fixture) =>
      writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts'] + '\n'),
    code: 1,
    selection: 'quality選択: 1',
    diagnostic: '未実行: 選択したテストがすべてskipされています',
  },
  {
    name: '他のテストが成功して',
    changeInput: (f: Fixture) =>
      writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts'] + '\n'),
    code: 0,
    selection: 'quality選択: 2',
    diagnostic: '(pass) b',
  },
]) {
  test(`${name}も全skipの行を記録から外す`, async () => {
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
        await seed(f);
        await changeInput(f);
        const result = run(f, ['run', 'test:affected'], { SKIP_A: '1' });
        expect(result.code, result.output).toBe(code);
        expect(result.output).toContain(selection);
        expect(result.output).toContain(diagnostic);
        await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
        await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts'] + '\n');
        const retried = run(f, ['run', 'test:affected']);
        expect(retried.code, retried.output).toBe(0);
        expect(retried.output).toContain('(pass) a');
        expect(retried.output).toContain('(pass) b');
        expect(retried.output).toContain('quality選択: 2');
        expect(retried.output).not.toContain('quality全件の理由:');
      },
    );
  });
}

test('worktreeごとに依存記録を分離し、それぞれの動的importから部分選択する', async () => {
  await fixture(
    {
      ...files,
      'src/other.ts': 'export const value = 1;\n',
      'test/a.test.ts': `${header}test('a', async () => {
      expect((await import('../src/' + (process.env.MODULE ?? 'input') + '.ts')).value).toBeGreaterThan(0);
    });\n`,
    },
    async (f) => {
      installed(f);
      const linked = join(f.signals, 'worktree');
      git(f.repo, 'worktree', 'add', '-b', 'linked', linked);
      const other = { ...f, repo: linked };
      await seed(f);
      await writeFile(join(linked, 'src/other.ts'), 'export const value = 2;\n');
      const initial = run(other, ['run', 'test:affected'], { MODULE: 'other' });
      expect(initial.code, initial.output).toBe(0);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      const original = run(f, ['run', 'test:affected']);
      expect(original.code, original.output).toBe(0);
      expect(original.output).toContain('(pass) a');
      expect(original.output).not.toContain('(pass) b');
      expect(original.output).toContain('quality選択: 1');
      expect(original.output).not.toContain('quality全件の理由:');
      await writeFile(join(linked, 'src/other.ts'), 'export const value = 3;\n');
      const selected = run(other, ['run', 'test:affected'], { MODULE: 'other' });
      expect(selected.code, selected.output).toBe(0);
      expect(selected.output).toContain('(pass) a');
      expect(selected.output).not.toContain('(pass) b');
      expect(selected.output).toContain('quality選択: 1');
      expect(selected.output).not.toContain('quality全件の理由:');
    },
  );
});

test('記録ファイルが読めなければ診断して全qualityを実行し、保存できなければ非ゼロ終了する', async () => {
  await fixture(files, async (f) => {
    installed(f);
    await seed(f);
    await unlink(recordFile(f.repo));
    await mkdir(recordFile(f.repo));
    const result = run(f, ['run', 'test:affected']);
    expect(result.output).toContain('を読めないため、記録なしとして扱います');
    expect(result.output).toContain('信頼できる依存記録なし');
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).toContain('(pass) a');
    expect(result.output).toContain('(pass) b');
    expect(result.code, result.output).not.toBe(0);
    await rm(recordFile(f.repo), { recursive: true });
    const repaired = run(f, ['run', 'test:affected']);
    expect(repaired.code, repaired.output).toBe(0);
    expect(repaired.output).not.toContain('を読めないため');
    const partial = run(f, ['run', 'test:affected']);
    expect(partial.code, partial.output).toBe(0);
    expect(partial.output).toContain('quality選択: 1');
    expect(partial.output).not.toContain('quality全件の理由:');
  });
});

test('BunはignoredChangesに当たる届かない変更を全件の理由にせず、それだけなら終了0で終える', async () => {
  await fixture(
    { ...files, '.feedback-loop.json': JSON.stringify({ ...config, ignoredChanges: ['docs/**'] }) },
    async (f) => {
      installed(f);
      // 影響先のない一時ファイルで全件の記録を作り、変更のない状態へ戻す。
      await writeFile(join(f.repo, 'seed.txt'), 'seed\n');
      const seeded = run(f, ['run', 'test:affected']);
      expect(seeded.code, seeded.output).toBe(0);
      await rm(join(f.repo, 'seed.txt'));
      await mkdir(join(f.repo, 'docs'));
      await writeFile(join(f.repo, 'docs/note.md'), 'memo\n');
      const ignored = run(f, ['run', 'test:affected']);
      expect(ignored.code, ignored.output).toBe(0);
      expect(ignored.output).toContain(
        '変更なし: ignoredChangesに当たる変更だけのため、テストを実行していません',
      );
      expect(ignored.output).not.toContain('(pass)');
      expect(ignored.output).not.toContain('選択したqualityが成功しました');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const mixed = run(f, ['run', 'test:affected']);
      expect(mixed.code, mixed.output).toBe(0);
      expect(mixed.output).toContain('(pass) a');
      expect(mixed.output).not.toContain('(pass) b');
      expect(mixed.output).toContain('quality選択: 1');
      expect(mixed.output).not.toContain('quality全件の理由:');
    },
  );
});
