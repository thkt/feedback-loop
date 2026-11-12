import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { files, fixture, installed, run, type Fixture } from './support/feedback-loop-batch.ts';
import { assertStringArray } from '../src/values.ts';
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
    },
  }),
  'tools/record-args.ts': recorder,
  'src/removed.ts': 'export const removed = 1;\n',
  'src/renamed.ts': 'export const renamed = 1;\n',
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
  assertStringArray(args);
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
}

test('分岐点以降に変更した実在するファイルを、指定したコマンドの引数に足して実行する', async () => {
  await fixture(changedFiles, async (f) => {
    await worked(f);
    const result = changed(f, []);
    expect(result.code, result.output).toBe(0);
    // 削除したファイル、改名前のパス、mainだけが進んだ変更は渡さない。空白と非ASCIIのパスは1つの引数で渡す。
    expect(recorded(result.output)?.sort(), result.output).toEqual([
      'docs/guide.md',
      'src/committed.ts',
      'src/input.ts',
      'src/moved.ts',
      'src/staged.tsx',
      'src/新しい file.ts',
    ]);
  });
}, 60000);

test('--extで拡張子を絞り、package scriptから呼んでも同じファイルを渡す', async () => {
  await fixture(changedFiles, async (f) => {
    await worked(f);
    // 拡張子は、先頭の.を省いても同じに読む。
    const narrowed = changed(f, ['--ext', 'tsx']);
    expect(narrowed.code, narrowed.output).toBe(0);
    expect(recorded(narrowed.output), narrowed.output).toEqual(['src/staged.tsx']);

    const script = run(f, ['run', 'lint:feedback']);
    expect(script.code, script.output).toBe(0);
    // コマンドの引数の後に、変更したファイルを足す。
    expect(recorded(script.output)?.slice(0, 2), script.output).toEqual(['--max-warnings', '0']);
    expect(recorded(script.output)?.slice(2).sort(), script.output).toEqual([
      'src/committed.ts',
      'src/input.ts',
      'src/moved.ts',
      'src/staged.tsx',
      'src/新しい file.ts',
    ]);
    expect(script.output).toContain('再実行: bun run lint:feedback');
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

test('コマンドが非ゼロ終了したら、その終了コードを表示して非ゼロ終了する', async () => {
  await fixture(changedFiles, async (f) => {
    installed(f);
    await write(f, 'src/input.ts', 'export const value = 2;\n');
    const result = changed(f, [], { RECORD_EXIT: '3' });
    expect(result.code, result.output).not.toBe(0);
    expect(recorded(result.output), result.output).toEqual(['src/input.ts']);
    expect(result.output).toContain('検査失敗または取消: 3');
  });
}, 60000);

for (const { args, diagnostic } of [
  {
    args: ['changed'],
    diagnostic: 'changedは「changed [--ext <拡張子>] -- <コマンド>」の形で呼びます',
  },
  {
    args: ['changed', '--ext', '.ts', '--'],
    diagnostic: 'changedは「changed [--ext <拡張子>] -- <コマンド>」の形で呼びます',
  },
  {
    args: ['changed', '--ext', '--', 'true'],
    diagnostic: 'changedの指定は--ext <拡張子>だけです: --ext',
  },
  {
    args: ['changed', '--all', '--', 'true'],
    diagnostic: 'changedの指定は--ext <拡張子>だけです: --all',
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
