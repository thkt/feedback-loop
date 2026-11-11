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
import {
  commitFixture,
  failedLine,
  fixture,
  git,
  header,
  passedLine,
} from './support/runner-affected.ts';
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
  'src/worker.ts': "import { value } from './child.ts'; console.log(value);\n",
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

for (const { name, inputs, selected, selection } of [
  {
    name: 'importする入力と、同じ入力への明示依存',
    inputs: [importedInput],
    selected: ['file', 'import'],
    selection: 'quality選択: 2',
  },
  {
    name: 'テストが起動した子のBunが読む入力',
    inputs: [childInput],
    selected: ['child'],
    selection: 'quality選択: 1',
  },
  {
    name: '通常のファイル読込みで読む入力への明示依存',
    inputs: [fileInput],
    selected: ['file'],
    selection: 'quality選択: 1',
  },
  {
    name: '3種類の入力の同時変更',
    inputs: [importedInput, childInput, fileInput],
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
      const initial = run(f, ['run', 'check:affected']);
      expect(initial.code, initial.output).toBe(0);
      expect((await observations(f)).sort()).toEqual(['child', 'file', 'import', 'unrelated']);
      await writeFile(traceFile(f), '');
      for (const input of inputs) {
        await writeFile(join(f.repo, input.path), input.changed);
      }
      const result = run(f, ['run', 'check:affected']);
      expect(result.code, result.output).toBe(0);
      expect((await observations(f)).sort(), result.output).toEqual(selected);
      expect(result.output).toContain('quality候補: 4');
      expect(result.output).toContain(selection);
      expect(result.output).not.toContain('quality全件の理由:');
    });
  }, 60000);
}

for (const mention of ['', '// data/value.json\n']) {
  test(`未知入力は${mention ? '無関係なコメントにパスがあっても' : 'パスへの言及がなくても'}全qualityで失敗を検出する`, async () => {
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
        'test/unrelated.test.ts': files['test/unrelated.test.ts'] + mention,
      },
      async (f) => {
        await installed(f);
        await writeFile(join(f.repo, 'data/value.json'), '{"value":1}\n ');
        const initial = run(f, ['run', 'check:affected']);
        expect(initial.code, initial.output).toBe(0);
        expect((await observations(f)).sort()).toEqual(['child', 'file', 'import', 'unrelated']);
        await writeFile(join(f.repo, 'data/value.json'), '{"value":3}\n');
        expect(git(f.repo, 'diff', '--name-only')).toBe('data/value.json');
        await writeFile(traceFile(f), '');

        const failed = run(f, ['run', 'check:affected']);
        expect(failed.code, failed.output).not.toBe(0);
        expect(failed.output).toContain(failedLine('file'));
        expect((await observations(f)).sort(), failed.output).toEqual([
          'child',
          'file',
          'import',
          'unrelated',
        ]);
        expect(failed.output).toContain('quality全件の理由:');
      },
    );
  }, 60000);
}

test('関連するqualityの失敗と全件skipを成功にせず、失敗したqualityの依存記録を外す', async () => {
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
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 3;\n');
      const failed = run(f, ['run', 'check:affected']);
      expect(failed.code, failed.output).not.toBe(0);
      expect(failed.output).toContain(failedLine('import'));
      expect(await observations(f)).toContain('import');

      await writeFile(join(f.repo, 'src/imported.ts'), files['src/imported.ts']);
      await writeFile(join(f.repo, 'data/value.json'), '{"value":2}\n');
      const repaired = run(f, ['run', 'check:affected']);
      expect(repaired.code, repaired.output).toBe(0);
      expect(repaired.output).toContain(passedLine('import'));
      expect(repaired.output).toContain('quality選択: 4');
      expect(repaired.output).toContain('依存記録がありません');
      await writeFile(join(f.repo, 'data/value.json'), files['data/value.json']);
      await writeFile(traceFile(f), '');
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 4;\n');
      const skipped = run(f, ['run', 'check:affected']);
      expect(skipped.code, skipped.output).not.toBe(0);
      expect(skipped.output).toContain('未実行:');
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
      expect((await observations(f)).sort()).toEqual([
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
      expect((await observations(f)).sort()).toEqual(['import', 'native-only']);
      await writeFile(traceFile(f), '');
      const affected = run(f, ['run', 'check:affected']);
      expect(affected.code, affected.output).toBe(0);
      expect((await observations(f)).sort(), affected.output).toEqual([
        'file',
        'import',
        'native-only',
      ]);
      expect(affected.output).toContain('quality候補: 5');
      expect(affected.output).toContain('quality選択: 3');
    },
  );
}, 60000);

test('FORCE_COLORの有無で正常な関連qualityの成功と無関係qualityの除外を変えない', async () => {
  await fixture(
    {
      'package.json': files['package.json'],
      '.feedback-loop.json': JSON.stringify({ ...config, assurance: [], dependencies: [] }),
      'scripts/collect.ts': files['scripts/collect.ts'],
      'src/imported.ts': files['src/imported.ts'],
      'test/observe.ts': files['test/observe.ts'],
      'test/import.test.ts': files['test/import.test.ts'],
      'test/unrelated.test.ts': files['test/unrelated.test.ts'],
    },
    async (f) => {
      await installed(f);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 1;\n// seed\n');
      const initial = run(f, ['run', 'check:affected'], { FORCE_COLOR: '0', NO_COLOR: undefined });
      expect(initial.code, initial.output).toBe(0);
      expect((await observations(f)).sort()).toEqual(['import', 'unrelated']);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      expect(git(f.repo, 'diff', '--name-only')).toBe('src/imported.ts');
      for (const color of ['0', '1']) {
        const env = { FORCE_COLOR: color, NO_COLOR: undefined };
        await writeFile(traceFile(f), '');
        const native = run(
          f,
          [
            '--no-env-file',
            'test',
            '--changed=main',
            './test/import.test.ts',
            './test/unrelated.test.ts',
          ],
          env,
        );
        expect(native.code, native.output).toBe(0);
        expect(await observations(f)).toEqual(['import']);
        await writeFile(traceFile(f), '');
        const affected = run(f, ['run', 'check:affected'], env);
        expect(await observations(f), affected.output).toEqual(['import']);
        expect(affected.code, affected.output).toBe(0);
      }
    },
  );
}, 60000);
