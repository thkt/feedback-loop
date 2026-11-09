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

import { commitFixture, git } from './support/runner-affected.ts';

const environment = { CLAUDECODE: '1' };

const selection = {
  ...files,
  '.feedback-loop.json': JSON.stringify({
    ...config,
    dependencies: [{ inputs: ['data/value.json'], tests: ['test/file.test.ts'] }],
  }),
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

test('CLAUDECODE=1でも--changedの部分実行を標準選択として実行する', async () => {
  await fixture(selection, async (f) => {
    await seeded(f, environment);
    await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
    const result = run(f, ['run', 'test:affected'], environment);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/--changed:.*running 1\/3 test file/);
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
  test(`${name}で--changedが0件でも、補完の明示依存だけで成功する`, async () => {
    await fixture(selection, async (f) => {
      await seeded(f, env);
      await writeFile(join(f.repo, 'data/value.json'), '{"value":2}\n');
      const result = run(f, ['run', 'test:affected'], env);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toMatch(/--changed:.*no test files are affected/);
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
    expect(result.output).toContain('(pass) b');
    expect(result.output).toContain('(pass) c');
    expect(result.output).not.toContain('(pass) a');
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).not.toContain('quality全件の理由:');
  });
});

for (const scenario of [
  { name: 'origin/HEAD', refs: ['refs/remotes/origin/trunk'], head: true },
  { name: 'origin/main', refs: ['refs/remotes/origin/main'] },
  { name: 'origin/master', refs: ['refs/remotes/origin/master'] },
  { name: 'main', refs: [] },
  { name: 'master', refs: [], localMaster: true },
  { name: '明示したbase', refs: [], base: 'main' },
]) {
  test(`${scenario.name}を比較元にコミット済み変更の関連テストを選ぶ`, async () => {
    await fixture(
      {
        ...selection,
        '.feedback-loop.json': JSON.stringify({
          ...JSON.parse(selection['.feedback-loop.json']),
          base: scenario.base,
        }),
      },
      async (f) => {
        await seeded(f, {});
        if (scenario.localMaster) {
          git(f.repo, 'branch', '-m', 'main', 'master');
        }
        const baseline = git(f.repo, 'rev-parse', 'HEAD');
        git(f.repo, 'checkout', '-b', 'work');
        await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
        commitFixture(f.repo, 'input changed');
        for (const ref of scenario.refs) {
          git(f.repo, 'update-ref', ref, baseline);
        }
        if (scenario.head) {
          git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
          git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
          git(f.repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
        }
        if (scenario.base) {
          git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
        }
        if (scenario.refs.length > 0) {
          git(f.repo, 'branch', '-f', 'main', 'HEAD');
          git(f.repo, 'branch', '-f', 'master', 'HEAD');
        }
        // commitで基点が変わるため、最初の全件実行で記録を更新します。
        const refreshed = run(f, ['run', 'test:affected']);
        expect(refreshed.code, refreshed.output).toBe(0);
        expect(refreshed.output).toContain('quality選択: 3');
        const result = run(f, ['run', 'test:affected']);
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('IMPORT_RAN');
        expect(result.output).not.toContain('FILE_RAN');
        expect(result.output).toContain('quality選択: 1');
        expectNoUnrelated(result.output);
        if (scenario.head) {
          git(f.repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
          const next = run(f, ['run', 'test:affected']);
          expect(next.code, next.output).not.toBe(0);
          expect(next.output).toContain('変更なし: テストを実行しません');
          expect(next.output).not.toContain('IMPORT_RAN');
        }
      },
    );
  }, 60000);
}

for (const ambiguous of ['local', 'remote', 'none']) {
  test(`比較元の候補が${ambiguous}で決まらなければ診断してテスト前に止まる`, async () => {
    await fixture(
      {
        ...selection,
        '.feedback-loop.json': JSON.stringify({ ...config, base: undefined }),
      },
      async (f) => {
        await seeded(f, {});
        git(f.repo, 'checkout', '-b', 'work');
        if (ambiguous === 'none') {
          git(f.repo, 'branch', '-D', 'main');
        } else if (ambiguous === 'local') {
          git(f.repo, 'branch', 'master');
        } else {
          git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
          git(f.repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
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
      expect(selected.output).toContain('(pass) committed');
      expect(selected.output).toContain('(pass) a');
      expect(selected.output).toContain('(pass) b');
      expect(selected.output).not.toContain('(pass) main-only');
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
    expect(result.output).toContain('(pass) a');
    expect(result.output).toContain('(pass) b');
  });
});
