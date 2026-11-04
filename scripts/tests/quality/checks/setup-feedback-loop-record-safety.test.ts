import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../../support/runner-affected.ts';
import {
  files,
  fixture,
  header,
  installed,
  run,
  type Fixture,
} from '../../support/feedback-loop-batch.ts';

const affected = (f: Fixture) => run(f, ['run', 'test:affected']);
const direct = (f: Fixture, path: string, env: NodeJS.ProcessEnv = {}) =>
  run(f, ['--no-env-file', 'test', `./${path}`], env);

function write(f: Fixture, path: string, body: string) {
  return writeFile(join(f.repo, path), body);
}

function commit(f: Fixture, message: string) {
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-m', message);
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
  expect(result.output).toContain('1 fail');
  expect(result.code, result.output).toBe(1);
}

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
      commit(f, '正常な記録の基点');

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
      commit(f, '依存構造を変更');
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

// 既知の漏れの固定: 実行時の記録に現れない依存は、別のテストに記録があると選ばれない。
for (const [dependency, body] of [
  [
    'fs',
    "import { readFileSync } from 'node:fs';\ntest('reader', () => { console.log('LEAK_RAN'); expect(readFileSync(['src', 'target.ts'].join('/'), 'utf8')).toContain('value = 1'); });\n",
  ],
  [
    'branch',
    "test('branch', async () => { console.log('LEAK_RAN'); if (process.env.CHECK_BRANCH) expect((await import(['..', 'src', 'target.ts'].join('/'))).value).toBe(1); });\n",
  ],
  [
    'isolated-child',
    "import { spawnSync } from 'node:child_process';\ntest('child', () => { console.log('LEAK_RAN'); const child = spawnSync(process.execPath, ['src/reader.ts'], { env: {}, encoding: 'utf8' }); expect(child.status).toBe(0); expect(child.stdout.trim()).toBe('1'); });\n",
  ],
] as const) {
  test(`既知の漏れ: 一部だけ依存が記録された変更は記録のあるテストだけを選ぶ: ${dependency}`, async () => {
    await fixture(
      {
        ...files,
        'src/target.ts': 'export const value = 1;\n',
        'src/reader.ts': "import { value } from './target.ts'; console.log(value);\n",
        'test/a.test.ts': `${header}test('recorded', async () => { console.log('RECORDED_RAN'); expect((await import(['..', 'src', 'target.ts'].join('/'))).value).toBeGreaterThan(0); });\n`,
        'test/b.test.ts': header + body,
      },
      async (f) => {
        installed(f);
        await write(f, 'src/target.ts', 'export const value = 1; // first\n');
        const first = affected(f);
        expect(first.code, first.output).toBe(0);
        expect(first.output).toContain('LEAK_RAN');
        await write(f, 'src/target.ts', 'export const value = 2;\n');
        const partial = affected(f);
        expect(partial.code, partial.output).toBe(0);
        expect(partial.output).toContain('RECORDED_RAN');
        expect(partial.output).not.toContain('LEAK_RAN');
        expect(partial.output).not.toContain('quality全件の理由:');
        // 直接実行は漏れた依存へ届き、同じ変更を検出します。
        const control = direct(f, 'test/b.test.ts', { CHECK_BRANCH: '1' });
        expect(control.code, control.output).toBe(1);
        expect(control.output).toContain('1 fail');
      },
    );
  }, 60000);
}
