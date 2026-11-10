import { expect, test } from 'bun:test';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitFixture, git } from './support/runner-affected.ts';
import {
  files,
  fixture,
  header,
  installed,
  run,
  type Fixture,
} from './support/feedback-loop-batch.ts';

const affected = (f: Fixture) => run(f, ['run', 'test:affected']);
const direct = (f: Fixture, path: string) => run(f, ['--no-env-file', 'test', `./${path}`]);

function write(f: Fixture, path: string, body: string) {
  return writeFile(join(f.repo, path), body);
}

const bounded = 'test/a.test.ts';
const boundedTest = `${header}import { value } from '../src/route.ts';
test('bounded', () => { console.log('A_RAN'); expect(value).toBeLessThan(3); });\n`;
const positiveTest = `${header}import { value } from '../src/input.ts';
test('positive', () => { console.log('B_RAN'); expect(value).toBeGreaterThan(0); });\n`;
// Bun標準の--changedが静的importから補わないよう、読み込み先を実行時に決めます。
const routeByFile = `import { readFileSync } from 'node:fs';
const name = readFileSync('src/path.txt', 'utf8').trim();
export const value: number = (await import(['.', name].join('/'))).value;\n`;
const routeToInput = `export const value: number = (await import(['.', 'input.ts'].join('/'))).value;\n`;

function expectBothRanAndBoundedFailed(result: ReturnType<typeof run>) {
  expect(result.output).toContain('A_RAN');
  expect(result.output).toContain('B_RAN');
  expect(result.code, result.output).toBe(1);
}

test('Gitのディレクトリへ書けない環境でも、記録を更新して関連選択へ戻り、記録はgitの変更に現れない', async () => {
  await fixture(files, async (f) => {
    installed(f);
    await write(f, 'src/input.ts', 'export const value = 2;\n');
    const gitDir = join(f.repo, '.git');
    await chmod(gitDir, 0o555);
    try {
      const first = affected(f);
      expect(first.code, first.output).toBe(0);
      expect(first.output).toContain('quality選択: 2件');

      const second = affected(f);
      expect(second.code, second.output).toBe(0);
      expect(second.output).toContain('quality選択: 1件');
      expect(git(f.repo, 'status', '--porcelain')).toBe('M src/input.ts');
    } finally {
      await chmod(gitDir, 0o755);
    }
  });
});

test('依存構造の変更をcommitした古い記録では、部分選択せず変更入力を読むテストも実行する', async () => {
  await fixture(
    {
      ...files,
      'src/path.txt': 'old.ts\n',
      'src/old.ts': 'export const value = 1;\n',
      'src/input.ts': 'export const value = 1;\n',
      'src/route.ts': routeByFile,
      [bounded]: boundedTest,
      'test/b.test.ts': positiveTest,
    },
    async (f) => {
      installed(f);
      await write(f, 'src/old.ts', 'export const value = 2;\n');
      expect(affected(f).code).toBe(0);
      commitFixture(f.repo, '正常な記録の基点');

      // 同じcommitの変更なら入力を読むテストだけへ絞れることを対照にします。
      await write(f, 'src/input.ts', 'export const value = 2;\n');
      expect(affected(f).code).toBe(0);
      await write(f, 'src/input.ts', 'export const value = 2; // same commit\n');
      const partial = affected(f);
      expect(partial.code, partial.output).toBe(0);
      expect(partial.output).toContain('B_RAN');
      expect(partial.output).not.toContain('A_RAN');

      // 記録済みのコードは変えず、記録に現れないファイルで依存先だけをcommitで替えます。
      await write(f, 'src/path.txt', 'input.ts\n');
      commitFixture(f.repo, '依存構造を変更');
      await write(f, 'src/input.ts', 'export const value = 3;\n');
      expect(git(f.repo, 'diff', '--name-only')).toBe('src/input.ts');
      const control = direct(f, bounded);
      expect(control.code, control.output).toBe(1);
      expect(control.output).toContain('A_RAN');
      expectBothRanAndBoundedFailed(affected(f));
    },
  );
}, 60000);

test('未commitの依存構造で取得した記録を、コード復元後の部分選択に流用しない', async () => {
  await fixture(
    {
      ...files,
      'src/old.ts': 'export const value = 1;\n',
      'src/input.ts': 'export const value = 1;\n',
      'src/route.ts': routeToInput,
      [bounded]: boundedTest,
      'test/b.test.ts': positiveTest,
    },
    async (f) => {
      installed(f);
      const head = git(f.repo, 'rev-parse', 'HEAD');
      await write(f, 'src/route.ts', "export { value } from './old.ts';\n");
      const recorded = affected(f);
      expect(recorded.code, recorded.output).toBe(0);
      expect(recorded.output).toContain('A_RAN');
      expect(recorded.output).toContain('B_RAN');

      // HEADは同じで、記録時だけ存在した依存構造の差分も消えます。
      await write(f, 'src/route.ts', routeToInput);
      await write(f, 'src/input.ts', 'export const value = 2;\n');
      const passing = direct(f, bounded);
      expect(passing.code, passing.output).toBe(0);
      await write(f, 'src/input.ts', 'export const value = 3;\n');
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(f.repo, 'diff', '--name-only')).toBe('src/input.ts');
      const failing = direct(f, bounded);
      expect(failing.code, failing.output).toBe(1);
      expectBothRanAndBoundedFailed(affected(f));
    },
  );
}, 60000);
