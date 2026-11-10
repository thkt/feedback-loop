import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  config,
  files,
  fixture,
  header,
  installed,
  run,
  type Fixture,
} from './support/feedback-loop-batch.ts';

import { commitFixture, git, passedLine } from './support/runner-affected.ts';

const environment = { CLAUDECODE: '1' };

const selectionConfig = {
  ...config,
  dependencies: [{ inputs: ['data/value.json'], tests: ['test/file.test.ts'] }],
};

const selection = {
  ...files,
  '.feedback-loop.json': JSON.stringify(selectionConfig),
  'data/value.json': '{"value":1}\n',
  'src/imported.ts': 'export const value = 1;\n',
  'test/a.test.ts': `${header}import { value } from '../src/imported.ts';
test('imported', () => { console.log('IMPORT_RAN'); expect(value).toBeGreaterThan(0); });\n`,
  'test/b.test.ts': `${header}test('unrelated', () => console.log('UNRELATED_RAN'));\n`,
  // 通常のファイル読込みは実行時の記録に現れず、明示依存だけで選ばれます。
  'test/file.test.ts': `${header}import { readFileSync } from 'node:fs';
test('file', () => { console.log('FILE_RAN'); expect(readFileSync(['data', 'value.json'].join('/'), 'utf8')).toContain('value'); });\n`,
};

async function seeded(f: Fixture, env: NodeJS.ProcessEnv) {
  installed(f);
  // 影響先のない一時ファイルで全件の記録を作り、以降の変更を調べる入力だけにします。
  await writeFile(join(f.repo, 'seed.txt'), 'seed\n');
  const first = run(f, ['run', 'test:affected'], env);
  expect(first.code, first.output).toBe(0);
  expect(first.output).toContain('quality全件の理由: seed.txt');
  await rm(join(f.repo, 'seed.txt'));
}

function expectNoUnrelated(output: string) {
  expect(output).not.toContain('UNRELATED_RAN');
  expect(output).not.toContain('quality全件の理由:');
}

test('CLAUDECODE=1でも、importでつながるqualityだけを実行する', async () => {
  await fixture(selection, async (f) => {
    await seeded(f, environment);
    await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
    const result = run(f, ['run', 'test:affected'], environment);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('IMPORT_RAN');
    expect(result.output).not.toContain('FILE_RAN');
    expect(result.output).toContain('quality選択: 1');
    expectNoUnrelated(result.output);
  });
}, 60000);

for (const [name, env] of [
  ['通常の環境', {}],
  ['CLAUDECODE=1', environment],
] as const) {
  test(`${name}で、importでつながるqualityがなくても、明示依存のqualityだけを実行して成功する`, async () => {
    await fixture(selection, async (f) => {
      await seeded(f, env);
      await writeFile(join(f.repo, 'data/value.json'), '{"value":2}\n');
      const result = run(f, ['run', 'test:affected'], env);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('FILE_RAN');
      expect(result.output).not.toContain('IMPORT_RAN');
      expect(result.output).toContain('quality選択: 1');
      expectNoUnrelated(result.output);
    });
  }, 60000);
}

test('記録のないqualityと変更されたquality自身を選び、無関係qualityを除外する', async () => {
  await fixture(files, async (f) => {
    await seeded(f, {});
    await writeFile(join(f.repo, 'test/b.test.ts'), `${files['test/b.test.ts']}\n`);
    await writeFile(
      join(f.repo, 'test/c.test.ts'),
      `${header}test('c', () => expect(1).toBe(1));\n`,
    );
    const result = run(f, ['run', 'test:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(passedLine('b'));
    expect(result.output).toContain(passedLine('c'));
    expect(result.output).not.toContain(passedLine('a'));
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).not.toContain('quality全件の理由:');
  });
});

// refsは、src/imported.tsを変えたcommitをworkブランチに作った後に実行するgitの操作である。
// HEAD~1は、その変更を含まないcommitを指す。
for (const { name, base, refs } of [
  {
    name: 'origin/HEAD',
    base: undefined,
    refs: [
      ['update-ref', 'refs/remotes/origin/trunk', 'HEAD~1'],
      ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'],
      ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
      ['update-ref', 'refs/remotes/origin/master', 'HEAD'],
      ['branch', '-f', 'main', 'HEAD'],
      ['branch', '-f', 'master', 'HEAD'],
    ],
  },
  {
    name: 'origin/main',
    base: undefined,
    refs: [
      ['update-ref', 'refs/remotes/origin/main', 'HEAD~1'],
      ['branch', '-f', 'main', 'HEAD'],
      ['branch', '-f', 'master', 'HEAD'],
    ],
  },
  {
    name: 'origin/master',
    base: undefined,
    refs: [
      ['update-ref', 'refs/remotes/origin/master', 'HEAD~1'],
      ['branch', '-f', 'main', 'HEAD'],
      ['branch', '-f', 'master', 'HEAD'],
    ],
  },
  { name: 'main', base: undefined, refs: [] },
  { name: 'master', base: undefined, refs: [['branch', '-m', 'main', 'master']] },
  {
    name: '明示したbase',
    base: 'main',
    refs: [['update-ref', 'refs/remotes/origin/main', 'HEAD']],
  },
]) {
  test(`${name}を比較元にコミット済み変更の関連テストを選ぶ`, async () => {
    await fixture(
      { ...selection, '.feedback-loop.json': JSON.stringify({ ...selectionConfig, base }) },
      async (f) => {
        installed(f);
        git(f.repo, 'checkout', '-b', 'work');
        await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
        commitFixture(f.repo, 'input changed');
        for (const args of refs) {
          git(f.repo, ...args);
        }
        // 記録がないため、最初の全件実行で記録を作ります。
        const refreshed = run(f, ['run', 'test:affected']);
        expect(refreshed.code, refreshed.output).toBe(0);
        expect(refreshed.output).toContain('quality選択: 3');
        const result = run(f, ['run', 'test:affected']);
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('IMPORT_RAN');
        expect(result.output).not.toContain('FILE_RAN');
        expect(result.output).toContain('quality選択: 1');
        expectNoUnrelated(result.output);
      },
    );
  }, 60000);
}

test('比較元が作業の変更を取り込むと、変更なしとして止まる', async () => {
  // baseを省略し、origin/HEADの指す先を比較元にする。
  const followingRemote = {
    ...selection,
    '.feedback-loop.json': JSON.stringify({ ...selectionConfig, base: undefined }),
  };
  await fixture(followingRemote, async (f) => {
    installed(f);
    git(f.repo, 'checkout', '-b', 'work');
    await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
    commitFixture(f.repo, 'input changed');
    git(f.repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD~1');
    git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    const before = run(f, ['run', 'test:affected']);
    expect(before.code, before.output).toBe(0);
    expect(before.output).toContain('IMPORT_RAN');

    git(f.repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    const after = run(f, ['run', 'test:affected']);
    expect(after.code, after.output).toBe(1);
    expect(after.output).toContain('変更なし: テストを実行しません');
    expect(after.output).not.toContain('IMPORT_RAN');
  });
}, 60000);

for (const { ambiguous, steps } of [
  { ambiguous: 'local', steps: [['branch', 'master']] },
  {
    ambiguous: 'remote',
    steps: [
      ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
      ['update-ref', 'refs/remotes/origin/master', 'HEAD'],
    ],
  },
  { ambiguous: 'none', steps: [['branch', '-D', 'main']] },
]) {
  test(`比較元の候補が${ambiguous}で決まらなければ診断してテスト前に止まる`, async () => {
    await fixture(
      {
        ...selection,
        '.feedback-loop.json': JSON.stringify({ ...config, base: undefined }),
      },
      async (f) => {
        installed(f);
        git(f.repo, 'checkout', '-b', 'work');
        for (const args of steps) {
          git(f.repo, ...args);
        }
        await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
        const result = run(f, ['run', 'test:affected']);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(
          '比較元を決められません。.feedback-loop.jsonにbaseを指定してください:',
        );
        for (const marker of ['IMPORT_RAN', 'FILE_RAN', 'UNRELATED_RAN']) {
          expect(result.output).not.toContain(marker);
        }
      },
    );
  }, 60000);
}

test('分岐点以降のcommit・未commit・未追跡を選び、mainだけが進んだ変更を除外する', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        dependencies: [{ inputs: ['untracked.json'], tests: ['test/b.test.ts'] }],
      }),
      'src/committed.ts': 'export const value = 1;\n',
      'src/main-only.ts': 'export const value = 1;\n',
      'test/committed.test.ts': `${header}test('committed', async () => expect((await import(['..', 'src', 'committed.ts'].join('/'))).value).toBeGreaterThan(0));\n`,
      'test/main-only.test.ts': `${header}test('main-only', async () => expect((await import(['..', 'src', 'main-only.ts'].join('/'))).value).toBeGreaterThan(0));\n`,
    },
    async (f) => {
      installed(f);
      git(f.repo, 'switch', '-c', 'work');
      await writeFile(join(f.repo, 'src/committed.ts'), 'export const value = 2;\n');
      commitFixture(f.repo, 'work commit');
      git(f.repo, 'switch', 'main');
      await writeFile(join(f.repo, 'src/main-only.ts'), 'export const value = 2;\n');
      commitFixture(f.repo, 'main advances');
      git(f.repo, 'switch', 'work');
      const refreshed = run(f, ['run', 'test:affected']);
      expect(refreshed.code, refreshed.output).toBe(0);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      await writeFile(join(f.repo, 'untracked.json'), '{}\n');
      const selected = run(f, ['run', 'test:affected']);
      expect(selected.code, selected.output).toBe(0);
      expect(selected.output).toContain(passedLine('committed'));
      expect(selected.output).toContain(passedLine('a'));
      expect(selected.output).toContain(passedLine('b'));
      expect(selected.output).not.toContain(passedLine('main-only'));
      expect(selected.output).toContain('quality選択: 3');
      expect(selected.output).not.toContain('quality全件の理由:');
    },
  );
});

test('作業用ディレクトリの変更も未知入力として全qualityを選ぶ', async () => {
  await fixture(files, async (f) => {
    await seeded(f, {});
    for (const path of [
      '.claude/workspace/plan/state.json',
      'docs/issues/draft.md',
      '.issue-drafts/451.md',
    ]) {
      await mkdir(dirname(join(f.repo, path)), { recursive: true });
      await writeFile(join(f.repo, path), 'draft\n');
    }
    const result = run(f, ['run', 'test:affected']);
    expect(result.code, result.output).toBe(0);
    for (const path of [
      '.claude/workspace/plan/state.json',
      'docs/issues/draft.md',
      '.issue-drafts/451.md',
    ]) {
      expect(result.output).toContain(path);
    }
    expect(result.output).toContain('quality全件の理由:');
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).toContain(passedLine('a'));
    expect(result.output).toContain(passedLine('b'));
  });
});
