import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  baseEnv,
  files,
  fixture,
  installed,
  run,
  type Fixture,
} from './support/feedback-loop-batch.ts';
import { isStringArray } from './support/json.ts';
import { commitFixture, git } from './support/runner-affected.ts';

// 受け取った引数を1行で表示し、RECORD_EXITの値で終了する。lintやformatterの代わりである。
const recorder =
  "console.log('ARGS:' + JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.RECORD_EXIT ?? 0));\n";

const changedFiles = {
  ...files,
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'bun@1.4.4',
    scripts: {
      check: 'bun test ./test',
      'lint:feedback':
        'bun scripts/feedback-loop/runtime.mjs changed --ext .ts,.tsx -- bun tools/record-args.ts --max-warnings 0',
      'lint:head':
        'bun scripts/feedback-loop/runtime.mjs changed --base HEAD --ext .tsx -- bun tools/record-args.ts',
    },
  }),
  'tools/record-args.ts': recorder,
  'src/removed.ts': 'export const removed = 1;\n',
  'src/renamed.ts': 'export const renamed = 1;\n',
  'src/Case.ts': 'export const cased = 1;\n',
  'docs/guide.md': '# guide\n',
};

async function write(f: Fixture, path: string, body: string) {
  await mkdir(dirname(join(f.repo, path)), { recursive: true });
  await writeFile(join(f.repo, path), body);
}

// 補助が実行したコマンドの引数。実行しなければundefinedを返す。
function recorded(output: string): string[] | undefined {
  const line = output.split('\n').find((text) => text.startsWith('ARGS:'));
  if (line === undefined) {
    return undefined;
  }
  const args: unknown = JSON.parse(line.slice('ARGS:'.length));
  assert(isStringArray(args), line);
  return args;
}

function changed(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  return run(
    f,
    [
      'scripts/feedback-loop/runtime.mjs',
      'changed',
      ...args,
      '--',
      process.execPath,
      'tools/record-args.ts',
    ],
    env,
  );
}

// mainに導入を取り込んだ後の作業ブランチで、commit・staged・unstaged・未追跡・削除・改名の変更を作る。
async function worked(f: Fixture) {
  installed(f);
  git(f.repo, 'checkout', '-b', 'work');
  await write(f, 'src/committed.ts', 'export const committed = 1;\n');
  commitFixture(f.repo, 'committed');
  // mainだけが進んだ変更は、作業ブランチの変更ではない。
  git(f.repo, 'checkout', '-q', 'main');
  await write(f, 'src/main-only.ts', 'export const mainOnly = 1;\n');
  commitFixture(f.repo, 'main only');
  git(f.repo, 'checkout', '-q', 'work');
  await write(f, 'src/staged.tsx', 'export const staged = 1;\n');
  git(f.repo, 'add', 'src/staged.tsx');
  await write(f, 'src/input.ts', 'export const value = 2;\n');
  await write(f, 'src/新しい file.ts', 'export const untracked = 1;\n');
  await write(f, 'docs/guide.md', '# changed\n');
  await rm(join(f.repo, 'src/removed.ts'));
  git(f.repo, 'mv', 'src/renamed.ts', 'src/moved.ts');
  // 大文字と小文字だけを変える改名。区別しないファイルシステムでは、改名前のパスも実在するように見える。
  git(f.repo, 'mv', 'src/Case.ts', 'src/case.ts');
  await write(f, '-notes.ts', 'export const notes = 1;\n');
  // gitは、ファイルでないパスも変更として返す。壊れたsymlinkと、ディレクトリへのsymlinkは渡さない。
  await symlink('missing.ts', join(f.repo, 'src/broken.ts'));
  await symlink('../docs', join(f.repo, 'src/linked.ts'));
}

test('分岐点以降に変更した実在するファイルを、指定したコマンドの引数に足して実行する', async () => {
  await fixture(changedFiles, async (f) => {
    await worked(f);
    const result = changed(f, []);
    expect(result.code, result.output).toBe(0);
    // 削除したファイル、改名前のパス、mainだけが進んだ変更は渡さない。空白と非ASCIIのパスは1つの引数で渡す。
    // -で始まる名前は、コマンドがオプションとして読まないよう./を付ける。パスは名前の順に並べる。
    expect(recorded(result.output), result.output).toEqual([
      './-notes.ts',
      'docs/guide.md',
      'src/case.ts',
      'src/committed.ts',
      'src/input.ts',
      'src/moved.ts',
      'src/staged.tsx',
      'src/新しい file.ts',
    ]);
    // package scriptを通さずに起動したら、起動したコマンドを再実行として案内する。
    expect(result.output).toContain('再実行: bun ');
    expect(result.output).toContain('runtime.mjs changed -- ');
    expect(result.output).not.toContain('再実行: bun run');
    expect(result.output).not.toContain('比較元:');
  });
}, 60000);

test('--extで拡張子を絞り、package scriptから呼んでも同じファイルを渡す', async () => {
  await fixture(changedFiles, async (f) => {
    await worked(f);
    // 拡張子は、先頭の.を省いても同じに読む。
    const narrowed = changed(f, ['--ext', 'tsx']);
    expect(narrowed.code, narrowed.output).toBe(0);
    expect(recorded(narrowed.output), narrowed.output).toEqual(['src/staged.tsx']);
    const assigned = changed(f, ['--ext=.tsx']);
    expect(assigned.code, assigned.output).toBe(0);
    expect(recorded(assigned.output), assigned.output).toEqual(['src/staged.tsx']);
    // --extを複数書いたら、すべての拡張子を対象にする。
    const repeated = changed(f, ['--ext', '.md', '--ext', '.tsx']);
    expect(repeated.code, repeated.output).toBe(0);
    expect(recorded(repeated.output), repeated.output).toEqual(['docs/guide.md', 'src/staged.tsx']);

    const script = run(f, ['run', 'lint:feedback']);
    expect(script.code, script.output).toBe(0);
    // コマンドの引数の後に、変更したファイルを足す。
    expect(recorded(script.output), script.output).toEqual([
      '--max-warnings',
      '0',
      './-notes.ts',
      'src/case.ts',
      'src/committed.ts',
      'src/input.ts',
      'src/moved.ts',
      'src/staged.tsx',
      'src/新しい file.ts',
    ]);
    expect(script.output).toContain('再実行: bun run lint:feedback');
  });
}, 60000);

test('Node.jsで起動しても、変更したファイルをコマンドへ渡す', async () => {
  await fixture(changedFiles, async (f) => {
    await worked(f);
    // Vitestのrepoは、実行部をNode.jsで起動する。
    const result = spawnSync(
      'node',
      [
        'scripts/feedback-loop/runtime.mjs',
        'changed',
        '--ext',
        '.tsx',
        '--',
        process.execPath,
        'tools/record-args.ts',
      ],
      { cwd: f.repo, encoding: 'utf8', timeout: 30000, env: baseEnv(f) },
    );
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);
    expect(recorded(output), output).toEqual(['src/staged.tsx']);

    // --baseの読み方と診断は、Node.jsのparseArgsでも同じである。
    const node = (options: string[]) => {
      const spawned = spawnSync(
        'node',
        [
          'scripts/feedback-loop/runtime.mjs',
          'changed',
          ...options,
          '--',
          process.execPath,
          'tools/record-args.ts',
        ],
        { cwd: f.repo, encoding: 'utf8', timeout: 30000, env: baseEnv(f) },
      );
      return { code: spawned.status, output: spawned.stdout + spawned.stderr };
    };
    const overridden = node(['--base', 'HEAD', '--ext', '.ts']);
    expect(overridden.code, overridden.output).toBe(0);
    expect(overridden.output).toContain('比較元: HEAD（実行時の指定）');
    expect(recorded(overridden.output), overridden.output).toEqual([
      './-notes.ts',
      'src/case.ts',
      'src/input.ts',
      'src/moved.ts',
      'src/新しい file.ts',
    ]);
    const valueless = node(['--base']);
    expect(valueless.code, valueless.output).not.toBe(0);
    expect(valueless.output).toContain('--baseには参照を指定してください: --base');
    expect(recorded(valueless.output), valueless.output).toBeUndefined();
  });
}, 60000);

test('変更したファイルが21件以上なら、実行の表示には先頭の20件と残りの件数を並べる', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    const names = Array.from(
      { length: 25 },
      (_, index) => `many/${String(index).padStart(2, '0')}.ts`,
    );
    await mkdir(join(f.repo, 'many'));
    await Promise.all(names.map((name) => writeFile(join(f.repo, name), '')));
    const result = changed(f, ['--ext', '.ts']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('many/19.ts …ほか5件; 再実行: ');
    expect(result.output).not.toContain('many/20.ts …');
  });
}, 60000);

test('パスの長さの合計が1回に渡せる上限を超えれば、分けて実行し、すべてのファイルを順に1回ずつ渡す', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    // パスの長さの合計が、1回に渡す上限の10万バイトを超える数。
    const names = Array.from(
      { length: 3000 },
      (_, index) => `generated/${String(index).padStart(4, '0')}-${'x'.repeat(40)}.ts`,
    );
    await mkdir(join(f.repo, 'generated'));
    await Promise.all(names.map((name) => writeFile(join(f.repo, name), '')));
    const result = changed(f, ['--ext', '.ts']);
    expect(result.code, result.output).toBe(0);
    const runs = result.output
      .split('\n')
      .filter((line) => line.startsWith('ARGS:'))
      .map((line) => recorded(line) ?? []);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.flat()).toEqual(names);
    // 実行の表示は回ごとに1行である。
    const shown = result.output.split('\n').filter((line) => line.startsWith('実行: '));
    expect(shown).toHaveLength(runs.length);
  });
}, 60000);

test('対象のファイルが0件なら、コマンドを実行せず終了0にする', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    // 変更がない。
    const clean = changed(f, []);
    expect(clean.code, clean.output).toBe(0);
    expect(recorded(clean.output), clean.output).toBeUndefined();
    expect(clean.output).toContain('変更したファイルがありません。コマンドを実行しません');

    // 変更はあるが、拡張子に当たらない。全件を対象にしない。
    await write(f, 'docs/guide.md', '# changed\n');
    const unmatched = changed(f, ['--ext', '.ts']);
    expect(unmatched.code, unmatched.output).toBe(0);
    expect(recorded(unmatched.output), unmatched.output).toBeUndefined();
    expect(unmatched.output).toContain('変更したファイルがありません。コマンドを実行しません');
  });
}, 60000);

test('--baseで比較元を指定すれば、その実行だけ、指定した参照からの変更を渡す', async () => {
  await fixture(changedFiles, async (f) => {
    await worked(f);
    // HEADを比較元にすると、作業ブランチでcommitした変更は渡さない。
    const uncommitted = [
      './-notes.ts',
      'docs/guide.md',
      'src/case.ts',
      'src/input.ts',
      'src/moved.ts',
      'src/staged.tsx',
      'src/新しい file.ts',
    ];
    const overridden = changed(f, ['--base', 'HEAD']);
    expect(overridden.code, overridden.output).toBe(0);
    expect(recorded(overridden.output), overridden.output).toEqual(uncommitted);
    expect(overridden.output).toContain('比較元: HEAD（実行時の指定）');
    // 起動したコマンドをそのまま案内するので、再実行も同じ比較元になる。
    expect(overridden.output).toContain('runtime.mjs changed --base HEAD -- ');
    const assigned = changed(f, ['--base=HEAD']);
    expect(assigned.code, assigned.output).toBe(0);
    expect(recorded(assigned.output), assigned.output).toEqual(uncommitted);
    // changedを呼ばないscriptの名前を引き継いだ環境では、その名前を案内しない。scriptから起動したシェルがこれに当たる。
    const inherited = changed(f, ['--base', 'HEAD'], { npm_lifecycle_event: 'check' });
    expect(inherited.code, inherited.output).toBe(0);
    expect(inherited.output).toContain('runtime.mjs changed --base HEAD -- ');
    expect(inherited.output).not.toContain('再実行: bun run');
    // --baseを複数書いたら、最後の指定を使う。
    const last = changed(f, ['--base', 'no-such-ref', '--base', 'HEAD']);
    expect(last.code, last.output).toBe(0);
    expect(recorded(last.output), last.output).toEqual(uncommitted);

    const narrowed = changed(f, ['--ext', '.ts', '--base', 'HEAD']);
    expect(narrowed.code, narrowed.output).toBe(0);
    expect(recorded(narrowed.output), narrowed.output).toEqual([
      './-notes.ts',
      'src/case.ts',
      'src/input.ts',
      'src/moved.ts',
      'src/新しい file.ts',
    ]);

    // scriptに書いた--baseは、script名の案内で再実行しても同じ比較元になる。
    const script = run(f, ['run', 'lint:head']);
    expect(script.code, script.output).toBe(0);
    expect(recorded(script.output), script.output).toEqual(['src/staged.tsx']);
    expect(script.output).toContain('再実行: bun run lint:head');

    // --の後の--baseは、実行するコマンドの引数であり、比較元にしない。
    const passed = run(f, [
      'scripts/feedback-loop/runtime.mjs',
      'changed',
      '--ext',
      '.ts',
      '--',
      process.execPath,
      'tools/record-args.ts',
      '--base',
      'no-such-ref',
    ]);
    expect(passed.code, passed.output).toBe(0);
    expect(recorded(passed.output), passed.output).toEqual([
      '--base',
      'no-such-ref',
      './-notes.ts',
      'src/case.ts',
      'src/committed.ts',
      'src/input.ts',
      'src/moved.ts',
      'src/新しい file.ts',
    ]);
    expect(passed.output).not.toContain('比較元:');
  });
}, 60000);

test('.feedback-loop.jsonのbaseより、--baseに指定した参照を比較元にする', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    const path = join(f.repo, '.feedback-loop.json');
    const config: unknown = JSON.parse(await readFile(path, 'utf8'));
    assert(typeof config === 'object' && config !== null);
    await writeFile(path, JSON.stringify({ ...config, base: 'no-such-ref' }));
    await write(f, 'src/input.ts', 'export const value = 2;\n');
    const configured = changed(f, ['--ext', '.ts']);
    expect(configured.code, configured.output).not.toBe(0);
    expect(configured.output).toContain(
      '.feedback-loop.jsonのbaseをGitのcommitとして読めません: no-such-ref',
    );
    const overridden = changed(f, ['--ext', '.ts', '--base', 'HEAD']);
    expect(overridden.code, overridden.output).toBe(0);
    expect(recorded(overridden.output), overridden.output).toEqual(['src/input.ts']);
  });
}, 60000);

test('--baseに指定した参照から変更がなければ、commitした変更があってもコマンドを実行しない', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    git(f.repo, 'checkout', '-b', 'work');
    await write(f, 'src/committed.ts', 'export const committed = 1;\n');
    commitFixture(f.repo, 'committed');
    const result = changed(f, ['--base', 'HEAD']);
    expect(result.code, result.output).toBe(0);
    expect(recorded(result.output), result.output).toBeUndefined();
    // 対象が0件でも、どの比較元で0件だったかを表示する。
    expect(result.output).toContain('比較元: HEAD（実行時の指定）');
    expect(result.output).toContain('変更したファイルがありません。コマンドを実行しません');
  });
}, 60000);

test('--baseに指定した参照をcommitとして読めなければ、コマンドを実行せず、参照を示して非ゼロ終了する', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    await write(f, 'src/input.ts', 'export const value = 2;\n');
    const result = changed(f, ['--base', 'no-such-ref']);
    expect(result.code, result.output).not.toBe(0);
    expect(recorded(result.output), result.output).toBeUndefined();
    expect(result.output).toContain(
      '--baseに指定した参照をGitのcommitとして読めません: no-such-ref',
    );
  });
}, 60000);

test('--baseに指定した参照とHEADに分岐点がなければ、コマンドを実行せず、参照を示して非ゼロ終了する', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    // 履歴を共有しないbranch。浅いcloneでも同じ状態になる。
    git(f.repo, 'checkout', '-q', '--orphan', 'unrelated');
    commitFixture(f.repo, 'unrelated');
    git(f.repo, 'checkout', '-q', 'main');
    await write(f, 'src/input.ts', 'export const value = 2;\n');
    const result = changed(f, ['--base', 'unrelated']);
    expect(result.code, result.output).not.toBe(0);
    expect(recorded(result.output), result.output).toBeUndefined();
    expect(result.output).toContain(
      '--baseに指定した参照とHEADの分岐点を求められません: unrelated',
    );
  });
}, 60000);

test('lintとformatのscriptがあっても、起動したscriptの名前を再実行として案内する', async () => {
  const scripts = {
    check: 'bun test ./test',
    'lint:feedback':
      'bun scripts/feedback-loop/runtime.mjs changed -- bun tools/record-args.ts lint',
    'format:feedback':
      'bun scripts/feedback-loop/runtime.mjs changed -- bun tools/record-args.ts format',
    // 補助と関係のない、同じ名前のscript。
    'check:changed': 'echo unrelated',
    // 実行部のパスを引用して書いたscript。
    'lint:quoted':
      'bun "scripts/feedback-loop/runtime.mjs" changed -- bun tools/record-args.ts quoted',
  };
  const both = {
    ...changedFiles,
    'package.json': JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'bun@1.4.4',
      scripts,
    }),
  };
  await fixture(both, async (f) => {
    installed(f);
    await write(f, 'src/input.ts', 'export const value = 2;\n');
    const format = run(f, ['run', 'format:feedback']);
    expect(format.code, format.output).toBe(0);
    expect(recorded(format.output), format.output).toEqual(['format', 'src/input.ts']);
    expect(format.output).toContain('再実行: bun run format:feedback');
    const quoted = run(f, ['run', 'lint:quoted']);
    expect(quoted.code, quoted.output).toBe(0);
    expect(quoted.output).toContain('再実行: bun run lint:quoted');

    // scriptを通さずに起動したら、どのscriptの名前も案内しない。空白を含む引数は引用する。
    const direct = run(f, [
      'scripts/feedback-loop/runtime.mjs',
      'changed',
      '--',
      process.execPath,
      'tools/record-args.ts',
      'two words',
    ]);
    expect(direct.code, direct.output).toBe(0);
    expect(direct.output).toMatch(
      /再実行: bun \S+runtime\.mjs changed -- \S+ tools\/record-args\.ts 'two words'\n/,
    );
    expect(direct.output).not.toContain('再実行: bun run');
  });
}, 60000);

test('コマンドが非ゼロ終了したら、その終了コードを表示して非ゼロ終了する', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    await write(f, 'src/input.ts', 'export const value = 2;\n');
    const result = changed(f, [], { RECORD_EXIT: '3' });
    expect(result.code, result.output).not.toBe(0);
    expect(recorded(result.output), result.output).toEqual(['src/input.ts']);
    // 失敗の理由を示す行は、コマンドの終了コードを示す1行だけである。
    expect(
      result.output.split('\n').filter((line) => line.includes('未完了')),
      result.output,
    ).toEqual(['feedback-loop未完了: 検査失敗または取消: 3']);
  });
}, 60000);

for (const { args, diagnostic } of [
  {
    args: ['changed'],
    diagnostic: 'changedは「changed [--ext <拡張子>] [--base <参照>] -- <コマンド>」の形で呼びます',
  },
  {
    args: ['changed', '--ext', '.ts', '--'],
    diagnostic: 'changedは「changed [--ext <拡張子>] [--base <参照>] -- <コマンド>」の形で呼びます',
  },
  {
    args: ['changed', '--ext', '--', 'true'],
    diagnostic: 'changedの指定は--ext <拡張子>と--base <参照>だけです: --ext',
  },
  {
    args: ['changed', '--all', '--', 'true'],
    diagnostic: 'changedの指定は--ext <拡張子>と--base <参照>だけです: --all',
  },
  {
    args: ['changed', '--base', '--', 'true'],
    diagnostic: '--baseには参照を指定してください: --base',
  },
  {
    args: ['changed', '--base', '--ext', '.ts', '--', 'true'],
    diagnostic: '--baseには参照を指定してください: --base --ext .ts',
  },
  // --extの値がないときは、--baseがあっても--baseの診断にしない。
  {
    args: ['changed', '--base', 'HEAD', '--ext', '--', 'true'],
    diagnostic: 'changedの指定は--ext <拡張子>と--base <参照>だけです: --base HEAD --ext',
  },
  {
    args: ['changed', '--base=', '--', 'true'],
    diagnostic: '--baseには参照を指定してください: --base=',
  },
  // どのパスにも当たらない拡張子の指定を、対象0件の成功にしない。
  {
    args: ['changed', '--ext', ',', '--', 'true'],
    diagnostic: '--extには拡張子をカンマ区切りで指定してください: ,',
  },
  {
    args: ['changed', '--ext', '*.ts', '--', 'true'],
    diagnostic: '--extには拡張子をカンマ区切りで指定してください: *.ts',
  },
  {
    args: ['changed', '--ext', 'ts tsx', '--', 'true'],
    diagnostic: '--extには拡張子をカンマ区切りで指定してください: ts tsx',
  },
]) {
  test(`changedの引数が「${args.slice(1).join(' ')}」なら、診断を表示して止まる`, async () => {
    await fixture(changedFiles, async (f) => {
      installed(f);
      await write(f, 'src/input.ts', 'export const value = 2;\n');
      const result = run(f, ['scripts/feedback-loop/runtime.mjs', ...args]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(diagnostic);
    });
  }, 60000);
}
