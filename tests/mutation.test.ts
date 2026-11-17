import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as oxc from 'oxc-parser';
import { generate } from '../scripts/build.ts';
import {
  config,
  files,
  fixture,
  header,
  installed,
  recordFile,
  run,
  seed,
} from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { git } from './support/runner-affected.ts';
import { vitestModules } from './support/vitest.ts';

// guard.tsは壊さないモジュールで、falseを渡すと読み込みの時点で投げる。
const mutationFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  '.feedback-loop.json': JSON.stringify({
    ...config,
    testArgs: ['--timeout', '20000'],
    bunWorkers: 2,
  }),
  'src/rules.ts': 'export function isAdult(age: number) {\n  return age >= 18;\n}\n',
  'src/loop.ts': `export function drain(items: number[]) {
  let pending = true;
  let total = 0;
  while (pending) {
    total += items.length;
    pending = false;
  }
  return total;
}
`,
  'src/guard.ts':
    "export function required(flag: boolean) {\n  if (!flag) throw new Error('required');\n  return 1;\n}\n",
  'src/startup.ts':
    "import { required } from './guard.ts';\nexport const ready = required(true);\n",
  'test/adult.test.ts': `${header}import { isAdult } from '../src/rules.ts';
test('adult', () => expect(isAdult(30)).toBe(true));\n`,
  'test/young.test.ts': `${header}import { isAdult } from '../src/rules.ts';
test('young', () => expect(isAdult(5)).toBe(false));\n`,
  'test/loop.test.ts': `${header}import { drain } from '../src/loop.ts';
test('drain', () => expect(drain([1, 2])).toBe(2));\n`,
  'test/startup.test.ts': `${header}import { ready } from '../src/startup.ts';
test('startup', () => expect(ready).toBe(1));\n`,
};

async function prepared(f: Fixture) {
  // oxc-parserは、導入先と同じく、fixtureのnode_modulesから読み込む。
  await symlink(vitestModules, join(f.repo, 'node_modules'));
  installed(f);
}

function mutation(f: Fixture, args: string[]) {
  const result = run(
    f,
    ['--no-env-file', 'scripts/feedback-loop/runtime.mjs', 'mutation', ...args],
    {},
    60000,
  );
  return { ...result, ...parse(result.stdout) };
}

/**
 * 標準出力をJSONとして読む。JSONでなければreportはundefinedである。
 * 鍵は構文木の経路と置き換えのhashを含むため、各件から外してkeysで、エラーの理由はreasonsで確かめる。
 */
function parse(stdout: string) {
  const keys: string[] = [];
  const reasons: string[] = [];
  try {
    const report: unknown = JSON.parse(stdout, (name, value: unknown) => {
      if (name === 'key' && typeof value === 'string') {
        keys.push(value);
        return undefined;
      }
      if (name === 'reason' && typeof value === 'string') {
        reasons.push(value);
        return undefined;
      }
      return value;
    });
    return { report, keys, reasons };
  } catch {
    return { report: undefined, keys, reasons };
  }
}

function head(f: Fixture, path: string) {
  return git(f.repo, 'show', `HEAD:${path}`);
}

function current(f: Fixture, path: string) {
  return readFileSync(join(f.repo, path), 'utf8').trimEnd();
}

test('既存のテストが拾わない壊し方を、全qualityで確かめて標準出力のJSONだけで返し、依存記録と追跡ファイルを変えない', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    await seed(f);
    const records = readFileSync(recordFile(f.repo), 'utf8');
    const status = git(f.repo, 'status', '--porcelain');
    const diff = git(f.repo, 'diff', 'HEAD');

    const result = mutation(f, ['src/rules.ts']);
    expect(result.code, result.output).toBe(0);
    // trueへの置き換えは、渡していないyoung.test.tsだけが拾う。全qualityで走らせたので、一覧に残らない。
    expect(result.report, result.output).toEqual({
      survived: [
        {
          path: 'src/rules.ts',
          line: 2,
          rule: 'EqualityOperator',
          original: 'age >= 18',
          replacement: 'age > 18',
        },
      ],
      timedOut: [],
      errors: [],
    });
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]).toMatch(/^src\/rules\.ts:isAdult:/);
    expect(result.stderr).not.toContain('改善するものがありません');
    expect(readFileSync(recordFile(f.repo), 'utf8')).toBe(records);
    expect(git(f.repo, 'status', '--porcelain')).toBe(status);
    expect(git(f.repo, 'diff', 'HEAD')).toBe(diff);
  });
}, 60000);

test('渡したテストですり抜けた壊し方は全qualityで確かめ直し、拾われたものを外して、改善するものが無いことを示す', async () => {
  await fixture(
    {
      ...mutationFiles,
      'test/boundary.test.ts': `${header}import { isAdult } from '../src/rules.ts';
test('boundary', () => expect(isAdult(18)).toBe(true));\n`,
    },
    async (f) => {
      await prepared(f);
      const result = mutation(f, ['src/rules.ts', '--tests', 'test/adult.test.ts']);
      expect(result.code, result.output).toBe(0);
      expect(result.report, result.output).toEqual({ survived: [], timedOut: [], errors: [] });
      // adult.test.tsだけでは、trueと>への置き換えがすり抜け、全qualityで確かめ直している。
      expect(result.stderr.match(/（渡したテスト）: survived /g), result.output).toHaveLength(2);
      expect(result.stderr.match(/（全quality）: killed /g), result.output).toHaveLength(2);
      expect(result.stderr).toContain('改善するものがありません');
    },
  );
}, 60000);

test('終わらない壊し方は、時間切れとして拾ったに数えて一覧のtimedOutへ入れ、対象のファイルを元に戻す', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const result = mutation(f, ['src/loop.ts', '--tests', 'test/loop.test.ts']);
    expect(result.code, result.output).toBe(0);
    // pending = falseをtrueにすると、whileが終わらない。
    expect(result.report, result.output).toEqual({
      survived: [],
      timedOut: [
        {
          path: 'src/loop.ts',
          line: 6,
          rule: 'BooleanLiteral',
          original: 'false',
          replacement: 'true',
        },
      ],
      errors: [],
    });
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]).toMatch(/^src\/loop\.ts:drain:/);
    expect(result.stderr).toContain('改善するものがありません');
    expect(current(f, 'src/loop.ts')).toBe(head(f, 'src/loop.ts'));
  });
}, 60000);

test('エラーで終わった壊し方は理由を付けてerrorsへ入れ、すり抜けが無くても非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const result = mutation(f, ['src/startup.ts']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.report, result.output).toEqual({
      survived: [],
      timedOut: [],
      errors: [
        {
          path: 'src/startup.ts',
          line: 2,
          rule: 'BooleanLiteral',
          original: 'true',
          replacement: 'false',
        },
      ],
    });
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]).toMatch(/^src\/startup\.ts:<top>:/);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('test/startup.test.ts');
    expect(result.stderr).toContain('エラーで終わった壊し方が1件あります');
    expect(result.stderr).not.toContain('改善するものがありません');
    expect(current(f, 'src/startup.ts')).toBe(head(f, 'src/startup.ts'));
  });
}, 60000);

test('壊していない状態で対象のテストが落ちると、壊し方を当てずに非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    await writeFile(
      join(f.repo, 'test/adult.test.ts'),
      `${header}import { isAdult } from '../src/rules.ts';
test('adult', () => expect(isAdult(30)).toBe(false));\n`,
    );
    const result = mutation(f, ['src/rules.ts', '--tests', 'test/adult.test.ts']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.stderr).toContain('壊していない状態で渡したテストが通りません');
    expect(result.stderr).not.toMatch(/壊し方 \d+\//);
    expect(result.report).toBeUndefined();
    expect(current(f, 'src/rules.ts')).toBe(head(f, 'src/rules.ts'));
  });
}, 60000);

test('生成したruntimeは、読み込みの時点ではnodeの組み込みモジュールだけをimportし、oxc-parserはmutationの実行時に読み込む', async () => {
  const runtime = (await generate()).get('scripts/runtime.mjs');
  assert(runtime !== undefined);
  const parsed = oxc.parseSync('runtime.mjs', runtime);
  expect(parsed.errors).toEqual([]);
  const statics = parsed.module.staticImports.map((item) => item.moduleRequest.value);
  expect(statics.length).toBeGreaterThan(0);
  expect(statics.filter((request) => !request.startsWith('node:'))).toEqual([]);
  const dynamics = parsed.module.dynamicImports.map((item) =>
    runtime.slice(item.moduleRequest.start, item.moduleRequest.end),
  );
  expect(dynamics).toContain('"oxc-parser"');
});
