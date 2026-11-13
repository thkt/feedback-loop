import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  const first = run(f, ['run', 'check:affected'], env);
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
    const result = run(f, ['run', 'check:affected'], environment);
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
      const result = run(f, ['run', 'check:affected'], env);
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
    const result = run(f, ['run', 'check:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(passedLine('b'));
    expect(result.output).toContain(passedLine('c'));
    expect(result.output).not.toContain(passedLine('a'));
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).not.toContain('quality全件の理由:');
  });
});

// 既定の比較元の選び方は、standalone.test.tsのinspectの表が確かめる。
// refsは、src/imported.tsを変えたcommitをworkブランチに作った後に実行するgitの操作である。
// HEAD~1は、その変更を含まないcommitを指す。
for (const { name, base, refs } of [
  {
    name: 'origin/main',
    base: undefined,
    refs: [
      ['update-ref', 'refs/remotes/origin/main', 'HEAD~1'],
      ['branch', '-f', 'main', 'HEAD'],
      ['branch', '-f', 'master', 'HEAD'],
    ],
  },
  { name: 'main', base: undefined, refs: [] },
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
        const refreshed = run(f, ['run', 'check:affected']);
        expect(refreshed.code, refreshed.output).toBe(0);
        expect(refreshed.output).toContain('quality選択: 3');
        const result = run(f, ['run', 'check:affected']);
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
    const before = run(f, ['run', 'check:affected']);
    expect(before.code, before.output).toBe(0);
    expect(before.output).toContain('IMPORT_RAN');

    git(f.repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    const after = run(f, ['run', 'check:affected']);
    expect(after.code, after.output).toBe(1);
    expect(after.output).toContain('変更なし: テストを実行しません');
    expect(after.output).not.toContain('IMPORT_RAN');
  });
}, 60000);

// 決められない理由ごとの文は、standalone.test.tsのinspectの表が確かめる。
// stepsは、workブランチを作った後に実行するgitの操作である。
for (const { name, base, steps, diagnostic } of [
  {
    name: 'originのないrepoで比較元を決められなければ、baseの指定を示す',
    base: undefined,
    steps: [['branch', '-D', 'main']],
    diagnostic:
      '比較元を決められません（origin/HEADがなく、mainもmasterもありません）。差分を取る比較元を、.feedback-loop.jsonのbase（例: "main"）で決めてください',
  },
  {
    name: 'originのあるrepoで比較元を決められなければ、baseの指定とorigin/HEADの設定を示す',
    base: undefined,
    steps: [
      ['branch', '-D', 'main'],
      ['remote', 'add', 'origin', 'https://example.invalid/repo.git'],
    ],
    diagnostic:
      '比較元を決められません（origin/HEADがなく、mainもmasterもありません）。差分を取る比較元を、.feedback-loop.jsonのbase（例: "origin/main"）か、git remote set-head origin --autoで決めてください',
  },
  {
    name: 'baseに指定した参照がなければ、読めない参照を示す',
    base: 'origin/main',
    steps: [],
    diagnostic: '.feedback-loop.jsonのbaseをGitのcommitとして読めません: origin/main',
  },
  {
    // リモートで既定のブランチを改名した後にfetch --pruneすると、origin/HEADの指す先が消える。
    name: 'origin/HEADの指す先がなければ、origin/HEADの設定を示す',
    base: undefined,
    steps: [
      ['remote', 'add', 'origin', 'https://example.invalid/repo.git'],
      ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone'],
    ],
    diagnostic:
      '比較元を決められません（origin/HEADの指す先のorigin/goneがありません）。差分を取る比較元を、.feedback-loop.jsonのbase（例: "origin/main"）か、git remote set-head origin --autoで決めてください',
  },
]) {
  test(`${name}。収集の前に止まる`, async () => {
    await fixture(
      { ...selection, '.feedback-loop.json': JSON.stringify({ ...config, base }) },
      async (f) => {
        installed(f);
        git(f.repo, 'checkout', '-b', 'work');
        for (const args of steps) {
          git(f.repo, ...args);
        }
        await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
        const result = run(f, ['run', 'check:affected']);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(`feedback-loop未完了: ${diagnostic}`);
        expect(result.output).not.toMatch(/収集: |IMPORT_RAN|FILE_RAN|UNRELATED_RAN/);
      },
    );
  }, 60000);
}

test('分岐点を求められても変更を読めなければ、gitの失敗をそのまま示し、分岐点の診断にしない', async () => {
  await fixture(selection, async (f) => {
    installed(f);
    await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
    // 壊れたindexでは、分岐点は求められるが、変更の一覧を読めない。
    await writeFile(join(f.repo, '.git/index'), 'broken');
    const result = run(f, ['run', 'check:affected']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('feedback-loop未完了: git ');
    expect(result.output).not.toContain('分岐点を求められません');
    expect(result.output).not.toMatch(/IMPORT_RAN|FILE_RAN|UNRELATED_RAN/);
  });
}, 60000);

test('導入したブランチでも、--baseで比較元を指定すれば、変更に関わるqualityだけを実行する', async () => {
  await fixture(selection, async (f) => {
    // 導入の変更は、比較元のmainにまだ入っていない。
    git(f.repo, 'checkout', '-b', 'introduce');
    installed(f);
    await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
    const introduced = run(f, ['run', 'check:affected']);
    expect(introduced.code, introduced.output).toBe(0);
    expect(introduced.output).toContain('quality全件の理由: package.json');
    expect(introduced.output).not.toContain('比較元:');

    const overridden = run(f, ['run', 'check:affected', '--base', 'HEAD']);
    expect(overridden.code, overridden.output).toBe(0);
    expect(overridden.output).toContain('比較元: HEAD（実行時の指定）');
    // 案内のとおりに再実行すると、同じ比較元を使う。
    expect(overridden.output).toContain('再実行: bun run check:affected --base HEAD');
    expect(overridden.output).toContain('IMPORT_RAN');
    expect(overridden.output).toContain('quality選択: 1');
    expectNoUnrelated(overridden.output);
  });
}, 60000);

test('導入したブランチでも、FEEDBACK_LOOP_BASEで比較元を指定すれば、変更に関わるqualityだけを実行する', async () => {
  await fixture(selection, async (f) => {
    git(f.repo, 'checkout', '-b', 'introduce');
    installed(f);
    await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
    // 最初の実行は、依存記録がないので全qualityを実行する。
    const introduced = run(f, ['run', 'check:affected']);
    expect(introduced.code, introduced.output).toBe(0);

    const specified = run(f, ['run', 'check:affected'], { FEEDBACK_LOOP_BASE: 'HEAD' });
    expect(specified.code, specified.output).toBe(0);
    expect(specified.output).toContain('比較元: HEAD（FEEDBACK_LOOP_BASEの指定）');
    // 案内のとおりに再実行すると、同じ比較元を使う。
    expect(specified.output).toContain('再実行: FEEDBACK_LOOP_BASE=HEAD bun run check:affected');
    expect(specified.output).toContain('IMPORT_RAN');
    expect(specified.output).toContain('quality選択: 1');
    expectNoUnrelated(specified.output);

    // --baseは、FEEDBACK_LOOP_BASEより優先する。
    const overridden = run(f, ['run', 'check:affected', '--base', 'HEAD'], {
      FEEDBACK_LOOP_BASE: 'no-such-ref',
    });
    expect(overridden.code, overridden.output).toBe(0);
    expect(overridden.output).toContain('比較元: HEAD（実行時の指定）');
    expect(overridden.output).toContain('再実行: bun run check:affected --base HEAD');
    expect(overridden.output).toContain('quality選択: 1');
  });
}, 60000);

for (const { value, diagnostic } of [
  {
    value: 'no-such-ref',
    diagnostic: 'FEEDBACK_LOOP_BASEに指定した参照をGitのcommitとして読めません: no-such-ref',
  },
  // 未設定の変数を展開した指定は、空になる。既定の比較元へ黙って戻さない。
  { value: '', diagnostic: 'FEEDBACK_LOOP_BASEには参照を指定してください' },
]) {
  test(`FEEDBACK_LOOP_BASEが「${value}」なら、check:affectedは診断を表示してテスト前に止まる`, async () => {
    await fixture(selection, async (f) => {
      installed(f);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      const result = run(f, ['run', 'check:affected'], { FEEDBACK_LOOP_BASE: value });
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(diagnostic);
      expect(result.output).not.toMatch(/収集: |IMPORT_RAN|FILE_RAN|UNRELATED_RAN/);
    });
  }, 60000);
}

for (const { args, diagnostic } of [
  {
    args: ['--base', 'no-such-ref'],
    diagnostic: '--baseに指定した参照をGitのcommitとして読めません: no-such-ref',
  },
  // 除外の指定は、gitの検証を通っても比較元にできない。
  {
    args: ['--base', '^HEAD'],
    diagnostic: '--baseに指定した参照をGitのcommitとして読めません: ^HEAD',
  },
  // -で始まる名前を、gitのオプションとして読ませない。
  {
    args: ['--base', '--all'],
    diagnostic: '--baseに指定した参照をGitのcommitとして読めません: --all',
  },
  { args: ['--base'], diagnostic: '--baseには参照を指定してください: --base' },
  { args: ['--base='], diagnostic: '--baseには参照を指定してください: --base=' },
]) {
  test(`check:affectedの引数が「${args.join(' ')}」なら、診断を表示してテスト前に止まる`, async () => {
    await fixture(selection, async (f) => {
      installed(f);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      const result = run(f, ['run', 'check:affected', ...args]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(diagnostic);
      // 収集の前に止まる。
      expect(result.output).not.toMatch(/収集: |IMPORT_RAN|FILE_RAN|UNRELATED_RAN/);
    });
  }, 60000);
}

test('check:affectedは--base以外の引数を読まず、--base=<参照>の形も受け取る', async () => {
  await fixture(selection, async (f) => {
    await seeded(f, {});
    await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
    // hookが足すファイルのパスなどは、変更前と同じく読まない。
    const ignored = run(f, ['run', 'check:affected', 'src/imported.ts', '--verbose']);
    expect(ignored.code, ignored.output).toBe(0);
    expect(ignored.output).toContain('quality選択: 1');
    expect(ignored.output).not.toContain('比較元:');

    const assigned = run(f, ['run', 'check:affected', 'src/imported.ts', '--base=HEAD']);
    expect(assigned.code, assigned.output).toBe(0);
    expect(assigned.output).toContain('比較元: HEAD（実行時の指定）');
    expect(assigned.output).toContain('quality選択: 1');

    // scriptに書いた--baseより、後に足した--baseを使う。
    const last = run(f, ['run', 'check:affected', '--base', 'no-such-ref', '--base', 'HEAD']);
    expect(last.code, last.output).toBe(0);
    expect(last.output).toContain('比較元: HEAD（実行時の指定）');

    // commitの文で指す参照も、commitとして読む。
    const message = run(f, ['run', 'check:affected', '--base', ':/configured']);
    expect(message.code, message.output).toBe(0);
    expect(message.output).toContain('比較元: :/configured（実行時の指定）');

    // Bunのrepoでは、引き継いだnpm_config_baseと、読まない引数があっても止めない。
    const inherited = run(f, ['run', 'check:affected', 'src/imported.ts'], {
      npm_config_base: 'true',
    });
    expect(inherited.code, inherited.output).toBe(0);
  });
}, 60000);

test('--baseの参照とHEADに分岐点がなければ、参照を示して止まる', async () => {
  await fixture(selection, async (f) => {
    installed(f);
    // 履歴を共有しないbranch。浅いcloneでも同じ状態になる。
    git(f.repo, 'checkout', '-q', '--orphan', 'unrelated');
    commitFixture(f.repo, 'unrelated');
    git(f.repo, 'checkout', '-q', 'main');
    await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
    const result = run(f, ['run', 'check:affected', '--base', 'unrelated']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(
      '--baseに指定した参照とHEADの分岐点を求められません: unrelated',
    );
    expect(result.output).not.toMatch(/IMPORT_RAN|FILE_RAN|UNRELATED_RAN/);
  });
}, 60000);

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
      const refreshed = run(f, ['run', 'check:affected']);
      expect(refreshed.code, refreshed.output).toBe(0);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      await writeFile(join(f.repo, 'untracked.json'), '{}\n');
      const selected = run(f, ['run', 'check:affected']);
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
    await mkdir(join(f.repo, '.claude/workspace/plan'), { recursive: true });
    await writeFile(join(f.repo, '.claude/workspace/plan/state.json'), 'draft\n');
    await mkdir(join(f.repo, 'docs/issues'), { recursive: true });
    await writeFile(join(f.repo, 'docs/issues/draft.md'), 'draft\n');
    await mkdir(join(f.repo, '.issue-drafts'));
    await writeFile(join(f.repo, '.issue-drafts/451.md'), 'draft\n');
    const result = run(f, ['run', 'check:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.stdout.split('\n')).toContain(
      'quality全件の理由: .claude/workspace/plan/state.json, .issue-drafts/451.md, docs/issues/draft.md',
    );
    expect(result.output).toContain('quality選択: 2');
    expect(result.output).toContain(passedLine('a'));
    expect(result.output).toContain(passedLine('b'));
  });
});
