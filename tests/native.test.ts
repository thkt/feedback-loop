import {
  applyFeedback,
  observations,
  traceFile,
  config as batchConfig,
  files as batchFiles,
  run as runFeedback,
} from './support/feedback-loop-batch.ts';
import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitFixture, failedLine, fixture, git, header } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  return runFeedback(
    f,
    args,
    {
      FEEDBACK_TRACE: traceFile(f),
      FEEDBACK_LOAD_BRANCH: '0',
      ...env,
    },
    30000,
  );
}

const config = {
  ...batchConfig,
  assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放だけを確認する対照' }],
  prepare: [],
  bunArgs: ['--no-env-file'],
  testArgs: ['--timeout', '15000'],
  globalChanges: ['scripts/**'],
  dependencies: [{ inputs: ['data/value.json', 'src/imported.ts'], tests: ['test/file.test.ts'] }],
};

const files = {
  'package.json': batchFiles['package.json'],
  '.feedback-loop.json': JSON.stringify(config),
  'scripts/collect.ts': batchFiles['scripts/collect.ts'],
  'src/imported.ts': 'export const value = 1;\n',
  'src/child.ts': 'export const value = 1;\n',
  'src/worker.ts': "import { value } from './child.ts'; process.stdout.write(String(value));\n",
  'data/value.json': '{"value":1}\n',
  'test/observe.ts': `import { appendFileSync } from 'node:fs';
export function observe(name: string) {
  appendFileSync(process.env.FEEDBACK_TRACE!, name + '\\n');
}\n`,
  'test/import.test.ts':
    header +
    "import { observe } from './observe.ts'; import { value } from '../src/imported.ts'; test('import', () => { observe('import'); expect(value).toBeLessThan(3); });\n",
  'test/child.test.ts':
    header +
    "import { observe } from './observe.ts'; import { execFileSync } from 'node:child_process'; test('child', () => { observe('child'); const value = Number(execFileSync(process.execPath, ['src/worker.ts'], { encoding: 'utf8' })); expect(value).toBeLessThan(3); });\n",
  'test/file.test.ts':
    header +
    "import { observe } from './observe.ts'; import { readFileSync } from 'node:fs'; test('file', () => { observe('file'); expect(JSON.parse(readFileSync('data/value.json', 'utf8')).value).toBeLessThan(3); expect(readFileSync('src/imported.ts', 'utf8')).toMatch(/value = [123];/); });\n",
  'test/unrelated.test.ts':
    header +
    "import { observe } from './observe.ts'; test('unrelated', () => { observe('unrelated'); expect(1).toBe(1); });\n",
  'test/assurance.test.ts':
    header +
    "import { observe } from './observe.ts'; import { value } from '../src/imported.ts'; test('cleanup', () => { observe('assurance'); expect(value).toBeGreaterThan(0); });\n",
};

async function installed(f: Fixture) {
  const result = applyFeedback(f, 'bun run check:affected', run);
  expect(result.code, result.output).toBe(0);
  commitFixture(f.repo, 'configured');
  await writeFile(traceFile(f), '');
}

// seedは最初の全件実行で記録を作るための変更、changedはその後に関連選択を確かめる変更である。
const importedInput = {
  path: 'src/imported.ts',
  seed: 'export const value = 1;\n// seed\n',
  changed: 'export const value = 2;\n',
};
const childInput = {
  path: 'src/child.ts',
  seed: 'export const value = 1;\n// seed\n',
  changed: 'export const value = 2;\n',
};
const fileInput = { path: 'data/value.json', seed: '{"value":1}\n ', changed: '{"value":2}\n' };

const plain = {};
// Bunは色付きの出力で、--changedの選択の診断にも色を付ける。
const colored = { FORCE_COLOR: '1', NO_COLOR: undefined };

for (const { name, inputs, env, selected, selection } of [
  {
    name: 'importする入力と、同じ入力への明示依存',
    inputs: [importedInput],
    env: plain,
    selected: ['file', 'import'],
    selection: 'quality選択: 2',
  },
  {
    name: 'テストが起動した子のBunが読む入力',
    inputs: [childInput],
    env: plain,
    selected: ['child'],
    selection: 'quality選択: 1',
  },
  {
    name: '通常のファイル読込みで読む入力への明示依存',
    inputs: [fileInput],
    env: plain,
    selected: ['file'],
    selection: 'quality選択: 1',
  },
  {
    name: '色付きの出力で、通常のファイル読込みで読む入力への明示依存',
    inputs: [fileInput],
    env: colored,
    selected: ['file'],
    selection: 'quality選択: 1',
  },
  {
    name: '3種類の入力の同時変更',
    inputs: [importedInput, childInput, fileInput],
    env: plain,
    selected: ['child', 'file', 'import'],
    selection: 'quality選択: 3',
  },
]) {
  test(`${name}に関連するqualityだけを実行し、無関係なqualityとassuranceを実行しない`, async () => {
    await fixture(files, async (f) => {
      await installed(f);
      for (const input of inputs) {
        await writeFile(join(f.repo, input.path), input.seed);
      }
      const initial = run(f, ['run', 'check:affected'], env);
      expect(initial.code, initial.output).toBe(0);
      expect((await observations(f)).toSorted()).toEqual(['child', 'file', 'import', 'unrelated']);
      await writeFile(traceFile(f), '');
      for (const input of inputs) {
        await writeFile(join(f.repo, input.path), input.changed);
      }
      const result = run(f, ['run', 'check:affected'], env);
      expect(result.code, result.output).toBe(0);
      expect((await observations(f)).toSorted(), result.output).toEqual(selected);
      expect(result.output).toContain('quality候補: 4');
      expect(result.output).toContain(selection);
      expect(result.output).not.toContain('quality全件の理由:');
    });
  }, 60000);
}

test('依存記録にも明示依存にもない入力の変更は、全qualityで失敗を検出する', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        dependencies: [{ inputs: ['src/imported.ts'], tests: ['test/file.test.ts'] }],
      }),
      'test/file.test.ts':
        header +
        "import { observe } from './observe.ts'; import { readFileSync } from 'node:fs'; import { join } from 'node:path'; test('file', () => { observe('file'); expect(JSON.parse(readFileSync(join('data', 'value.json'), 'utf8')).value).toBeLessThan(3); });\n",
    },
    async (f) => {
      await installed(f);
      await writeFile(join(f.repo, 'data/value.json'), '{"value":1}\n ');
      const initial = run(f, ['run', 'check:affected']);
      expect(initial.code, initial.output).toBe(0);
      expect((await observations(f)).toSorted()).toEqual(['child', 'file', 'import', 'unrelated']);
      await writeFile(join(f.repo, 'data/value.json'), '{"value":3}\n');
      expect(git(f.repo, 'diff', '--name-only')).toBe('data/value.json');
      await writeFile(traceFile(f), '');

      const failed = run(f, ['run', 'check:affected']);
      expect(failed.code, failed.output).not.toBe(0);
      expect(failed.output).toContain(failedLine('file'));
      expect((await observations(f)).toSorted(), failed.output).toEqual([
        'child',
        'file',
        'import',
        'unrelated',
      ]);
      expect(failed.output).toContain('quality全件の理由:');
    },
  );
}, 60000);

// importは1回目のBunの--changedで、fileは明示依存として2回目の実行で選ばれる。
test('2回に分けて実行した関連qualityがすべてskipされると、成功にしない', async () => {
  await fixture(
    {
      ...files,
      'test/import.test.ts': files['test/import.test.ts'].replace(
        "test('import'",
        "(value === 4 ? test.skip : test)('import'",
      ),
      'test/file.test.ts': files['test/file.test.ts'].replace(
        "test('file'",
        "(readFileSync('src/imported.ts', 'utf8').includes('value = 4;') ? test.skip : test)('file'",
      ),
    },
    async (f) => {
      await installed(f);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      const initial = run(f, ['run', 'check:affected']);
      expect(initial.code, initial.output).toBe(0);
      await writeFile(traceFile(f), '');
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 4;\n');
      const skipped = run(f, ['run', 'check:affected']);
      expect(skipped.code, skipped.output).not.toBe(0);
      expect(skipped.output).toContain('未実行: 選択したテストがすべてskipされています');
      expect(await observations(f)).toEqual([]);
    },
  );
}, 60000);

test('依存記録に変更した入力が載っていなくても、その入力をimportするqualityを、記録と明示依存のqualityとあわせて実行する', async () => {
  await fixture(
    {
      ...files,
      'src/conditional-route.ts': "export { value } from './imported.ts';\n",
      'test/native-only.test.ts':
        header +
        "import { observe } from './observe.ts'; test('conditional import', async () => { observe('native-only'); if (process.env.FEEDBACK_LOAD_BRANCH === '1') { const { value } = await import('../src/conditional-route.ts'); expect(value).toBeLessThan(3); } expect(1).toBe(1); });\n",
    },
    async (f) => {
      await installed(f);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 1;\n// seed\n');
      const initial = run(f, ['run', 'check:affected']);
      expect(initial.code, initial.output).toBe(0);
      expect((await observations(f)).toSorted()).toEqual([
        'child',
        'file',
        'import',
        'native-only',
        'unrelated',
      ]);
      await writeFile(traceFile(f), '');
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      expect(git(f.repo, 'diff', '--name-only')).toBe('src/imported.ts');
      const native = run(f, [
        '--no-env-file',
        'test',
        '--changed=main',
        './test/import.test.ts',
        './test/child.test.ts',
        './test/file.test.ts',
        './test/native-only.test.ts',
        './test/unrelated.test.ts',
      ]);
      expect(native.code, native.output).toBe(0);
      expect((await observations(f)).toSorted()).toEqual(['import', 'native-only']);
      await writeFile(traceFile(f), '');
      const affected = run(f, ['run', 'check:affected']);
      expect(affected.code, affected.output).toBe(0);
      expect((await observations(f)).toSorted(), affected.output).toEqual([
        'file',
        'import',
        'native-only',
      ]);
      expect(affected.output).toContain('quality候補: 5');
      expect(affected.output).toContain('quality選択: 3');
    },
  );
}, 60000);
