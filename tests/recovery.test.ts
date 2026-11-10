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
import { commitFixture, failedLine, git, passedLine } from './support/runner-affected.ts';

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
      expect(replaced.output).toContain(passedLine('b'));
      expect(replaced.output).not.toContain(passedLine('a'));
      expect(replaced.output).toContain('quality選択: 1');
      expect(replaced.output).not.toContain('quality全件の理由:');
      await writeFile(join(f.repo, 'src/first.ts'), 'export const value = 1;\n');
      await writeFile(join(f.repo, 'src/second.ts'), 'export const value = 2;\n');
      const selected = run(f, ['run', 'test:affected'], { MODULE: 'second' });
      expect(selected.code, selected.output).toBe(0);
      expect(selected.output).toContain(passedLine('a'));
      expect(selected.output).not.toContain(passedLine('b'));
      expect(selected.output).toContain('quality選択: 1');
      expect(selected.output).not.toContain('quality全件の理由:');
    },
  );
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

// aはsrc/input.tsを、cはsrc/other.tsをimportする。bはdata/input.jsonへの明示依存だけで選ばれる。
const fallbackFiles = {
  ...files,
  'data/input.json': '{}\n',
  '.feedback-loop.json': JSON.stringify({
    ...config,
    dependencies: [{ inputs: ['data/input.json'], tests: ['test/b.test.ts'] }],
  }),
  'test/b.test.ts': header + "test('b', () => expect(process.env.FAIL_FALLBACK).not.toBe('1'));\n",
  'src/other.ts': 'export const other = 1;\n',
  'test/c.test.ts':
    header +
    "import { other } from '../src/other.ts'; test('c', () => expect(other).toBeGreaterThan(0));\n",
};

test('明示依存だけで選んだqualityが成功したら、そのqualityと実行しなかったqualityの記録を保つ', async () => {
  await fixture(fallbackFiles, async (f) => {
    installed(f);
    await seed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
    await writeFile(join(f.repo, 'data/input.json'), '{"changed":true}\n');
    const result = run(f, ['run', 'test:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(passedLine('a'));
    expect(result.output).toContain(passedLine('b'));
    expect(result.output).not.toContain('quality全件の理由:');
    // bとcの記録が欠けていれば、記録のないqualityとして次の実行で選ばれる。
    await writeFile(join(f.repo, 'data/input.json'), '{}\n');
    const retried = run(f, ['run', 'test:affected']);
    expect(retried.code, retried.output).toBe(0);
    expect(retried.output).toContain(passedLine('a'));
    expect(retried.output).not.toContain(passedLine('b'));
    expect(retried.output).not.toContain(passedLine('c'));
    expect(retried.output).toContain('quality選択: 1');
    expect(retried.output).not.toContain('quality全件の理由:');
  });
});

test('明示依存だけで選んだqualityが失敗したら、先に成功したqualityも記録から外し、実行しなかったqualityの記録を保つ', async () => {
  await fixture(fallbackFiles, async (f) => {
    installed(f);
    await seed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
    await writeFile(join(f.repo, 'data/input.json'), '{"changed":true}\n');
    const result = run(f, ['run', 'test:affected'], { FAIL_FALLBACK: '1' });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(passedLine('a'));
    expect(result.output).toContain(failedLine('b'));
    expect(result.output).not.toContain('quality全件の理由:');
    // aとbは記録がないので選ばれる。cの記録まで欠けていれば、全件の理由が出る。
    await writeFile(join(f.repo, 'data/input.json'), '{}\n');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 1;\n');
    await writeFile(join(f.repo, 'src/other.ts'), 'export const other = 2;\n');
    const retried = run(f, ['run', 'test:affected']);
    expect(retried.code, retried.output).toBe(0);
    expect(retried.output).toContain(passedLine('a'));
    expect(retried.output).toContain(passedLine('b'));
    expect(retried.output).toContain(passedLine('c'));
    expect(retried.output).toContain('quality選択: 3');
    expect(retried.output).not.toContain('quality全件の理由:');
  });
});

// SKIP_Aを設定すると、aのテストがskipになる。
const skippableFiles = {
  ...files,
  'test/a.test.ts':
    header +
    "import { value } from '../src/input.ts'; (process.env.SKIP_A ? test.skip : test)('a', () => expect(value).toBeGreaterThan(0));\n",
};

test('選んだqualityがすべてskipなら失敗にし、skipだったqualityの記録を外す', async () => {
  await fixture(skippableFiles, async (f) => {
    installed(f);
    await seed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 1;\n\n');
    const result = run(f, ['run', 'test:affected'], { SKIP_A: '1' });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('quality選択: 1');
    expect(result.output).toContain('未実行: 選択したテストがすべてskipされています');
    // aの記録が外れていれば、src/input.tsを戻してもaは記録のないqualityとして選ばれる。
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 1;\n');
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts'] + '\n');
    const retried = run(f, ['run', 'test:affected']);
    expect(retried.code, retried.output).toBe(0);
    expect(retried.output).toContain(passedLine('a'));
    expect(retried.output).toContain(passedLine('b'));
    expect(retried.output).toContain('quality選択: 2');
    expect(retried.output).not.toContain('quality全件の理由:');
  });
});

test('他のqualityが成功しても、skipだったqualityの記録を外す', async () => {
  await fixture(skippableFiles, async (f) => {
    installed(f);
    await seed(f);
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts'] + '\n');
    const result = run(f, ['run', 'test:affected'], { SKIP_A: '1' });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).toContain(passedLine('b'));
    // aの記録が外れていれば、src/input.tsを戻してもaは記録のないqualityとして選ばれる。
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 1;\n');
    const retried = run(f, ['run', 'test:affected']);
    expect(retried.code, retried.output).toBe(0);
    expect(retried.output).toContain(passedLine('a'));
    expect(retried.output).toContain(passedLine('b'));
    expect(retried.output).toContain('quality選択: 2');
    expect(retried.output).not.toContain('quality全件の理由:');
  });
});

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
      expect(original.output).toContain(passedLine('a'));
      expect(original.output).not.toContain(passedLine('b'));
      expect(original.output).toContain('quality選択: 1');
      expect(original.output).not.toContain('quality全件の理由:');
      await writeFile(join(linked, 'src/other.ts'), 'export const value = 3;\n');
      const selected = run(other, ['run', 'test:affected'], { MODULE: 'other' });
      expect(selected.code, selected.output).toBe(0);
      expect(selected.output).toContain(passedLine('a'));
      expect(selected.output).not.toContain(passedLine('b'));
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
    expect(result.output).toContain(passedLine('a'));
    expect(result.output).toContain(passedLine('b'));
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
      expect(mixed.output).toContain(passedLine('a'));
      expect(mixed.output).not.toContain(passedLine('b'));
      expect(mixed.output).toContain('quality選択: 1');
      expect(mixed.output).not.toContain('quality全件の理由:');
    },
  );
});
