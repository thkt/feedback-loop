import { expect, test } from 'bun:test';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { files, fixture, header, installed, run } from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';

const base = {
  'package.json': files['package.json'],
  '.feedback-loop.json': files['.feedback-loop.json'],
  'scripts/collect.ts': files['scripts/collect.ts'],
};

/** 影響先のない一時ファイルで全qualityを実行して依存記録を作り、変更のない状態へ戻す。 */
async function recordEveryQuality(f: Fixture, selected: string) {
  await writeFile(join(f.repo, 'seed.txt'), 'seed\n');
  const result = run(f, ['run', 'check:affected']);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain(selected);
  await rm(join(f.repo, 'seed.txt'));
}

// 比較先をASCIIエスケープで書き、実値と期待値が同時に文字化けして通ることを防ぐ。
const expectJapanese = "expect(value).toBe('\\u65e5\\u672c\\u8a9e\\ud83c\\udf38');";
const json = '{"value":"日本語🌸","count":7,"nested":{"enabled":true}}\n';
const expectJson = `${expectJapanese} expect(data.count).toBe(7); expect(data.nested.enabled).toBe(true);`;

test('依存を記録する実行でも、UnicodeとJSONを読むテストの結果を変えず、読んだファイルの変更でそのテストだけを選ぶ', async () => {
  await fixture(
    {
      ...base,
      'src/text.ts': "export const value = '日本語🌸';\n",
      'data/value.json': json,
      'test/text.test.ts': `${header}import { value } from '../src/text.ts';
test('text', () => { console.log('RAN_TEXT'); ${expectJapanese} });\n`,
      'data/settings.toml': 'name = "feedback"\n',
      'test/toml.test.ts': `${header}import settings from '../data/settings.toml';
test('toml', () => { console.log('RAN_TOML'); expect(settings.name).toBe('feedback'); });\n`,
      'test/json-static.test.ts': `${header}import data from '../data/value.json';
const { value } = data;
test('json static', () => { console.log('RAN_JSON_STATIC'); ${expectJson} });\n`,
      'test/json-dynamic.test.ts': `${header}const { default: data } = await import('../data/value.json');
const { value } = data;
test('json dynamic', () => { console.log('RAN_JSON_DYNAMIC'); ${expectJson} });\n`,
      'test/json-extensionless.test.ts': `${header}import data from '../data/value';
const { value } = data;
test('json extensionless', () => { console.log('RAN_JSON_EXTENSIONLESS'); ${expectJson} });\n`,
      'test/json-dynamic-extensionless.test.ts': `${header}const { default: data } = await import('../data/value');
const { value } = data;
test('json dynamic extensionless', () => { console.log('RAN_JSON_DYNAMIC_EXTENSIONLESS'); ${expectJson} });\n`,
    },
    async (f) => {
      installed(f);
      await recordEveryQuality(f, 'quality選択: 6');

      await writeFile(join(f.repo, 'data/value.json'), `${json}\n`);
      const jsonChanged = run(f, ['run', 'check:affected']);
      expect(jsonChanged.code, jsonChanged.output).toBe(0);
      expect(jsonChanged.output).toContain('RAN_JSON_STATIC');
      expect(jsonChanged.output).toContain('RAN_JSON_DYNAMIC');
      expect(jsonChanged.output).toContain('RAN_JSON_EXTENSIONLESS');
      expect(jsonChanged.output).toContain('RAN_JSON_DYNAMIC_EXTENSIONLESS');
      expect(jsonChanged.output).not.toContain('RAN_TEXT');
      expect(jsonChanged.output).not.toContain('RAN_TOML');
      expect(jsonChanged.output).toContain('quality選択: 4');
      expect(jsonChanged.output).not.toContain('quality全件の理由:');

      await writeFile(join(f.repo, 'data/settings.toml'), 'name = "feedback"\n\n');
      const tomlChanged = run(f, ['run', 'check:affected']);
      expect(tomlChanged.code, tomlChanged.output).toBe(0);
      expect(tomlChanged.output).toContain('RAN_TOML');
      expect(tomlChanged.output).not.toContain('RAN_TEXT');
      expect(tomlChanged.output).toContain('quality選択: 5');
      expect(tomlChanged.output).not.toContain('quality全件の理由:');

      // JSONの変更は残したまま、もう1つのファイルを変える。戻すと記録のhashと食い違い、全件になる。
      await writeFile(
        join(f.repo, 'src/text.ts'),
        "export const value = '日本語🌸';\n// changed\n",
      );
      const textChanged = run(f, ['run', 'check:affected']);
      expect(textChanged.code, textChanged.output).toBe(0);
      expect(textChanged.output).toContain('RAN_TEXT');
      expect(textChanged.output).toContain('quality選択: 6');
      expect(textChanged.output).not.toContain('quality全件の理由:');
    },
  );
});

test('テストがnode:fsをmockしていても、依存の記録の読み書きを製品の読み込みとして観測させない', async () => {
  await fixture(
    {
      ...base,
      'test/state.txt': 'fixture only, no credential\n',
      'test/metadata.ts': `import { statSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
export async function inspect(mode) {
  const path = import.meta.dir + '/state.txt';
  if (mode === 'metadata') return { present: statSync(path).isFile() };
  if (mode === 'read-sync') return readFileSync(path, 'utf8');
  return await readFile(path, 'utf8');
}
`,
      'test/boundary.ts': "export { inspect } from './metadata.ts';\n",
      'test/observe.ts': `import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
const syncRead = fs.readFileSync;
const asyncRead = promises.readFile;
const reads = [];
mock.module('node:fs', () => ({ ...fs, readFileSync(...args) {
  reads.push({ api: 'node:fs.readFileSync', path: String(args[0]) });
  return syncRead(...args);
} }));
mock.module('node:fs/promises', () => ({ ...promises, readFile(...args) {
  reads.push({ api: 'node:fs/promises.readFile', path: String(args[0]) });
  return asyncRead(...args);
} }));
const { inspect } = await import('./boundary.ts');
const value = await inspect(process.argv[2]);
console.log(JSON.stringify({ value, reads }));
`,
      // メタデータの参照は読み込みとして観測されない対照、同期と非同期の読み込みは観測される対照である。
      'test/observation.test.ts': `${header}import { spawnSync } from 'node:child_process';
function observe(mode) {
  const child = spawnSync(process.execPath, ['--no-env-file', 'observe.ts', mode], {
    cwd: import.meta.dir, encoding: 'utf8', env: { ...process.env },
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}
const state = import.meta.dir + '/state.txt';
test('metadata', () => {
  expect(observe('metadata')).toEqual({ value: { present: true }, reads: [] });
});
test('read sync', () => {
  expect(observe('read-sync')).toEqual({
    value: 'fixture only, no credential\\n',
    reads: [{ api: 'node:fs.readFileSync', path: state }],
  });
});
test('read async', () => {
  expect(observe('read-async')).toEqual({
    value: 'fixture only, no credential\\n',
    reads: [{ api: 'node:fs/promises.readFile', path: state }],
  });
});
`,
    },
    async (f) => {
      installed(f);
      await recordEveryQuality(f, 'quality選択: 1');
    },
  );
});

test('テストが起動した子のBunが読むJSONを変えると、起動したテストだけを選ぶ', async () => {
  await fixture(
    {
      ...base,
      'src/child-data.json': '{"value":2}\n',
      'src/child.ts': "import data from './child-data';\nconsole.log(data.value);\n",
      'test/spawn.test.ts': `${header}import { spawnSync } from 'node:child_process';
test('spawns', () => {
  console.log('RAN_SPAWN');
  const child = spawnSync(process.execPath, ['src/child.ts'], { env: process.env, encoding: 'utf8' });
  expect(child.stdout.trim()).toBe('2');
});\n`,
      'test/other.test.ts': `${header}test('other', () => { console.log('RAN_OTHER'); expect(1).toBe(1); });\n`,
    },
    async (f) => {
      installed(f);
      await recordEveryQuality(f, 'quality選択: 2');

      await writeFile(join(f.repo, 'src/child-data.json'), '{"value":2}\n\n');
      const result = run(f, ['run', 'check:affected']);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('RAN_SPAWN');
      expect(result.output).not.toContain('RAN_OTHER');
      expect(result.output).toContain('quality選択: 1');
      expect(result.output).not.toContain('quality全件の理由:');
    },
  );
});

test('同じモジュールを読む2つのテストは、片方のテストの変更ではもう片方を選ばず、モジュールの変更では両方を選ぶ', async () => {
  await fixture(
    {
      ...base,
      'src/shared.ts': 'export const value = 3;\n',
      'test/first.test.ts': `${header}test('first', async () => { console.log('RAN_FIRST'); expect((await import('../src/shared.ts')).value).toBe(3); });\n`,
      'test/second.test.ts': `${header}test('second', async () => { console.log('RAN_SECOND'); expect((await import('../src/shared.ts')).value).toBe(3); });\n`,
      'test/third.test.ts': `${header}test('third', () => { console.log('RAN_THIRD'); expect(1).toBe(1); });\n`,
    },
    async (f) => {
      installed(f);
      await recordEveryQuality(f, 'quality選択: 3');

      await writeFile(
        join(f.repo, 'test/second.test.ts'),
        `${header}test('second', async () => { console.log('RAN_SECOND'); expect((await import('../src/shared.ts')).value).toBe(3); });\n// changed\n`,
      );
      const testChanged = run(f, ['run', 'check:affected']);
      expect(testChanged.code, testChanged.output).toBe(0);
      expect(testChanged.output).toContain('RAN_SECOND');
      expect(testChanged.output).not.toContain('RAN_FIRST');
      expect(testChanged.output).not.toContain('RAN_THIRD');
      expect(testChanged.output).not.toContain('quality全件の理由:');

      await writeFile(join(f.repo, 'src/shared.ts'), 'export const value = 3;\n// changed\n');
      const moduleChanged = run(f, ['run', 'check:affected']);
      expect(moduleChanged.code, moduleChanged.output).toBe(0);
      expect(moduleChanged.output).toContain('RAN_FIRST');
      expect(moduleChanged.output).toContain('RAN_SECOND');
      expect(moduleChanged.output).not.toContain('RAN_THIRD');
      expect(moduleChanged.output).toContain('quality選択: 2');
      expect(moduleChanged.output).not.toContain('quality全件の理由:');
    },
  );
});

test('利用者がBUN_OPTIONSで指定したpreloadを、依存を記録する実行でも有効にする', async () => {
  await fixture(
    {
      ...base,
      'preload.ts': "Reflect.set(globalThis, 'userPreloaded', true);\n",
      'test/preloaded.test.ts': `${header}test('preloaded', () => { expect(Reflect.get(globalThis, 'userPreloaded')).toBe(true); });\n`,
    },
    async (f) => {
      installed(f);
      await writeFile(join(f.repo, 'seed.txt'), 'seed\n');
      const without = run(f, ['run', 'check:affected']);
      expect(without.code, without.output).not.toBe(0);
      const result = run(f, ['run', 'check:affected'], {
        BUN_OPTIONS: `--preload=${join(f.repo, 'preload.ts')}`,
      });
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('quality選択: 1');
    },
  );
});

test('空白を含むパスのrepoでは、依存を記録できない理由を示して失敗する', async () => {
  await fixture(
    {
      ...base,
      'test/a.test.ts': `${header}test('a', () => expect(1).toBe(1));\n`,
    },
    async (initial) => {
      const repo = join(initial.repo, '..', 'with space');
      await rename(initial.repo, repo);
      const f = { ...initial, repo };
      installed(f);
      await writeFile(join(repo, 'seed.txt'), 'seed\n');
      const result = run(f, ['run', 'check:affected']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('空白を含む記録器のパスは渡せません');
    },
  );
});
