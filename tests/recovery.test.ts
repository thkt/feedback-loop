import { expect, test } from 'bun:test';
import { mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises';
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
      const updated = run(f, ['run', 'check:affected'], { MODULE: 'second' });
      expect(updated.code, updated.output).toBe(0);
      await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
      await writeFile(join(f.repo, 'src/first.ts'), 'export const value = 2;\n');
      const replaced = run(f, ['run', 'check:affected'], { MODULE: 'second' });
      expect(replaced.code, replaced.output).toBe(0);
      expect(replaced.output).toContain(passedLine('b'));
      expect(replaced.output).not.toContain(passedLine('a'));
      expect(replaced.output).toContain('quality選択: 1');
      expect(replaced.output).not.toContain('quality全件の理由:');
      await writeFile(join(f.repo, 'src/first.ts'), 'export const value = 1;\n');
      await writeFile(join(f.repo, 'src/second.ts'), 'export const value = 2;\n');
      const selected = run(f, ['run', 'check:affected'], { MODULE: 'second' });
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
      const refreshed = run(f, ['run', 'check:affected']);
      expect(refreshed.code, refreshed.output).toBe(0);
      expect(refreshed.output).toContain('quality選択: 2');
      expect(refreshed.output).toContain('UNRELATED_C');

      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      expect(git(f.repo, 'diff', '--name-only', 'main')).toBe('src/input.ts');
      const affected = run(f, ['run', 'check:affected']);
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
    const result = run(f, ['run', 'check:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(passedLine('a'));
    expect(result.output).toContain(passedLine('b'));
    expect(result.output).not.toContain('quality全件の理由:');
    // bとcの記録が欠けていれば、記録のないqualityとして次の実行で選ばれる。
    await writeFile(join(f.repo, 'data/input.json'), '{}\n');
    const retried = run(f, ['run', 'check:affected']);
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
    const result = run(f, ['run', 'check:affected'], { FAIL_FALLBACK: '1' });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(passedLine('a'));
    expect(result.output).toContain(failedLine('b'));
    expect(result.output).not.toContain('quality全件の理由:');
    // aとbは記録がないので選ばれる。cの記録まで欠けていれば、全件の理由が出る。
    await writeFile(join(f.repo, 'data/input.json'), '{}\n');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 1;\n');
    await writeFile(join(f.repo, 'src/other.ts'), 'export const other = 2;\n');
    const retried = run(f, ['run', 'check:affected']);
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
    const result = run(f, ['run', 'check:affected'], { SKIP_A: '1' });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('quality選択: 1');
    expect(result.output).toContain('未実行: 選択したテストがすべてskipされています');
    // aの記録が外れていれば、src/input.tsを戻してもaは記録のないqualityとして選ばれる。
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 1;\n');
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts'] + '\n');
    const retried = run(f, ['run', 'check:affected']);
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
    const result = run(f, ['run', 'check:affected'], { SKIP_A: '1' });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).toContain(passedLine('b'));
    // aの記録が外れていれば、src/input.tsを戻してもaは記録のないqualityとして選ばれる。
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 1;\n');
    const retried = run(f, ['run', 'check:affected']);
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
      const initial = run(other, ['run', 'check:affected'], { MODULE: 'other' });
      expect(initial.code, initial.output).toBe(0);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      const original = run(f, ['run', 'check:affected']);
      expect(original.code, original.output).toBe(0);
      expect(original.output).toContain(passedLine('a'));
      expect(original.output).not.toContain(passedLine('b'));
      expect(original.output).toContain('quality選択: 1');
      expect(original.output).not.toContain('quality全件の理由:');
      await writeFile(join(linked, 'src/other.ts'), 'export const value = 3;\n');
      const selected = run(other, ['run', 'check:affected'], { MODULE: 'other' });
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
    const result = run(f, ['run', 'check:affected']);
    expect(result.output).toContain('を読めないため、記録なしとして扱います');
    expect(result.output).not.toContain('依存記録がありません');
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).toContain(passedLine('a'));
    expect(result.output).toContain(passedLine('b'));
    expect(result.code, result.output).not.toBe(0);
    // fixtureは、実行部のTMPDIRをf.reportsへ向けている。保存に失敗しても、一時ディレクトリを残さない。
    expect(await readdir(f.reports)).toEqual([]);
    await rm(recordFile(f.repo), { recursive: true });
    const repaired = run(f, ['run', 'check:affected']);
    expect(repaired.code, repaired.output).toBe(0);
    expect(repaired.output).not.toContain('を読めないため');
    const partial = run(f, ['run', 'check:affected']);
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
      const seeded = run(f, ['run', 'check:affected']);
      expect(seeded.code, seeded.output).toBe(0);
      await rm(join(f.repo, 'seed.txt'));
      await mkdir(join(f.repo, 'docs'));
      await writeFile(join(f.repo, 'docs/note.md'), 'memo\n');
      const ignored = run(f, ['run', 'check:affected']);
      expect(ignored.code, ignored.output).toBe(0);
      expect(ignored.output).toContain(
        '変更なし: ignoredChangesに当たる変更だけのため、テストを実行していません',
      );
      expect(ignored.output).not.toContain('(pass)');
      expect(ignored.output).not.toContain('選択したqualityが成功しました');
    },
  );
});

test('Bunはassuranceのテストファイルの変更を全qualityへ広げず、届かない他の変更だけを全件の理由にする', async () => {
  const assuranceFile = `${header}test('cleanup', () => { console.log('ASSURANCE_RAN'); expect(1).toBe(1); });\n`;
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放の確認' }],
        ignoredChanges: ['docs/**'],
      }),
      'src/orphan.ts': 'export const orphan = 1;\n',
      'test/assurance.test.ts': assuranceFile,
    },
    async (f) => {
      installed(f);
      const notice =
        'assuranceのテストファイルは、このコマンドの実行対象に選びません。全体checkとCIで実行します: test/assurance.test.ts';

      // 依存記録がないうちは届く先が分からないため、assuranceだけの変更でも全件を実行する。
      await writeFile(join(f.repo, 'test/assurance.test.ts'), `${assuranceFile}\n`);
      const unrecorded = run(f, ['run', 'check:affected']);
      expect(unrecorded.code, unrecorded.output).toBe(0);
      expect(unrecorded.stdout.split('\n')).toContain('quality全件の理由: 依存記録がありません');
      expect(unrecorded.output).toContain('quality選択: 2');
      expect(unrecorded.output).not.toContain('ASSURANCE_RAN');

      const only = run(f, ['run', 'check:affected']);
      expect(only.code, only.output).toBe(0);
      expect(only.stdout.split('\n')).toContain(notice);
      expect(only.output).toContain(
        '変更なし: assuranceのテストファイルの変更だけのため、テストを実行していません',
      );
      expect(only.output).not.toContain('(pass)');
      expect(only.output).not.toContain('quality全件の理由:');

      await mkdir(join(f.repo, 'docs'));
      await writeFile(join(f.repo, 'docs/note.md'), 'memo\n');
      const declared = run(f, ['run', 'check:affected']);
      expect(declared.code, declared.output).toBe(0);
      expect(declared.output).toContain(
        '変更なし: ignoredChangesに当たる変更とassuranceのテストファイルの変更だけのため、テストを実行していません',
      );
      expect(declared.output).not.toContain('(pass)');

      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const reached = run(f, ['run', 'check:affected']);
      expect(reached.code, reached.output).toBe(0);
      expect(reached.stdout.split('\n')).toContain(notice);
      expect(reached.output).toContain(passedLine('a'));
      expect(reached.output).not.toContain(passedLine('b'));
      expect(reached.output).not.toContain('ASSURANCE_RAN');
      expect(reached.output).not.toContain('quality全件の理由:');

      await writeFile(join(f.repo, 'src/orphan.ts'), 'export const orphan = 2;\n');
      const unreached = run(f, ['run', 'check:affected']);
      expect(unreached.code, unreached.output).toBe(0);
      expect(unreached.stdout.split('\n')).toContain('quality全件の理由: src/orphan.ts');
      expect(unreached.output).toContain('quality選択: 2');
      expect(unreached.output).not.toContain('ASSURANCE_RAN');
    },
  );
});

test('導入版の記録器が欠けていれば、一時ディレクトリを残さずに失敗する', async () => {
  await fixture(files, async (f) => {
    installed(f);
    await rm(join(f.repo, 'scripts/feedback-loop/record-modules.ts'));
    const result = run(f, ['run', 'check:affected']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toMatch(
      /^feedback-loop未完了: .*scripts\/feedback-loop\/record-modules\.ts/m,
    );
    // fixtureは、実行部のTMPDIRをf.reportsへ向けている。
    expect(await readdir(f.reports)).toEqual([]);
  });
});
