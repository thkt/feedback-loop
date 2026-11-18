import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as oxc from 'oxc-parser';
import { generate } from '../scripts/build.ts';
import { mutants } from '../src/mutants.ts';
import { isRecord } from '../src/values.ts';
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
 * 標準出力をJSONとして読む。JSONでなければreportとrawはundefinedである。
 * 鍵は構文木の経路と置き換えのhashを含むため、各件から外してkeysで、エラーの理由はreasonsで確かめる。
 * rawは、鍵と理由を外していないJSONである。
 */
function parse(stdout: string) {
  const keys: string[] = [];
  const reasons: string[] = [];
  try {
    const raw: unknown = JSON.parse(stdout);
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
    return { report, raw, keys, reasons };
  } catch {
    return { report: undefined, raw: undefined, keys, reasons };
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
      stale: [],
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
      expect(result.report, result.output).toEqual({
        survived: [],
        timedOut: [],
        errors: [],
        stale: [],
      });
      // adult.test.tsだけでは、trueと>への置き換えがすり抜け、全qualityで確かめ直している。
      expect(result.stderr.match(/（渡したテスト）: survived /g), result.output).toHaveLength(2);
      expect(result.stderr.match(/（全quality）: killed /g), result.output).toHaveLength(2);
      expect(result.stderr).toContain('改善するものがありません');
    },
  );
}, 60000);

test('--testsに同じテストを書き方を変えて2回渡しても、1回として走らせる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const result = mutation(f, [
      'src/rules.ts',
      '--tests',
      'test/adult.test.ts',
      './test/adult.test.ts',
    ]);
    expect(result.code, result.output).toBe(0);
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
      stale: [],
    });
  });
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
      stale: [],
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
      stale: [],
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

test('壊し方が0件のモジュールでは、基準の実行もせずに、記録した鍵だけをstaleに入れた一覧を出し、改善するものが無いことを示して終了0で終わる', async () => {
  await fixture({ ...mutationFiles, 'src/constant.ts': 'export const value = 1;\n' }, async (f) => {
    await prepared(f);
    const gone = 'src/constant.ts:<top>:body{value}:BooleanLiteral:000000000000';
    await writeFile(
      join(f.repo, '.feedback-loop-mutants.json'),
      JSON.stringify({ equivalent: [{ key: gone, reason: '消えた壊し方' }] }),
    );
    const result = mutation(f, ['src/constant.ts']);
    expect(result.code, result.output).toBe(0);
    expect(result.raw, result.output).toEqual({
      survived: [],
      timedOut: [],
      errors: [],
      stale: [{ key: gone, reason: 'not-generated' }],
    });
    expect(result.stderr).toContain('改善するものがありません');
    expect(result.stderr).not.toContain('基準の実行');
  });
}, 60000);

// src/rules.tsの壊し方の鍵を、置き換えの後の字から引く。
function keyOf(path: keyof typeof mutationFiles, replacement: string) {
  const found = mutants(oxc, path, mutationFiles[path]).find((m) => m.replacement === replacement);
  assert(found !== undefined, `${path}に${replacement}への壊し方がありません`);
  return found.key;
}

test('--keyの壊し方1件を渡したテストで確かめ、killedとtimedOutは終了0、survivedとerrorは理由を示して非ゼロで終わる', async () => {
  await fixture(
    {
      ...mutationFiles,
      'test/boundary.test.ts': `${header}import { isAdult } from '../src/rules.ts';
test('boundary', () => expect(isAdult(18)).toBe(true));\n`,
    },
    async (f) => {
      await prepared(f);
      const greater = keyOf('src/rules.ts', 'age > 18');
      const item = {
        key: greater,
        path: 'src/rules.ts',
        line: 2,
        rule: 'EqualityOperator',
        original: 'age >= 18',
        replacement: 'age > 18',
      };

      const killed = mutation(f, ['--key', greater, '--tests', 'test/boundary.test.ts']);
      expect(killed.code, killed.output).toBe(0);
      expect(killed.raw, killed.output).toEqual({ ...item, verdict: 'killed' });
      // 渡したテストだけで確かめ、全qualityで確かめ直さない。
      expect(killed.stderr).not.toContain('全quality');

      const survived = mutation(f, ['--key', greater, '--tests', 'test/adult.test.ts']);
      expect(survived.code, survived.output).not.toBe(0);
      expect(survived.raw, survived.output).toEqual({ ...item, verdict: 'survived' });
      expect(survived.stderr).toContain(
        `渡したテストは、この壊し方を拾いません（survived）: ${greater}`,
      );
      expect(current(f, 'src/rules.ts')).toBe(head(f, 'src/rules.ts'));

      const endless = keyOf('src/loop.ts', 'true');
      const timedOut = mutation(f, ['--key', endless, '--tests', 'test/loop.test.ts']);
      expect(timedOut.code, timedOut.output).toBe(0);
      expect(timedOut.raw, timedOut.output).toMatchObject({ key: endless, verdict: 'timedOut' });
      expect(current(f, 'src/loop.ts')).toBe(head(f, 'src/loop.ts'));

      const throwing = keyOf('src/startup.ts', 'false');
      const failed = mutation(f, ['--key', throwing, '--tests', 'test/startup.test.ts']);
      expect(failed.code, failed.output).not.toBe(0);
      expect(failed.raw, failed.output).toMatchObject({ key: throwing, verdict: 'error' });
      expect(failed.stderr).toContain('壊し方がエラーで終わりました: ');
      expect(failed.stderr).toContain('test/startup.test.ts');
    },
  );
}, 60000);

test('--keyで、壊していない状態のテストが落ちるとき、鍵の壊し方が作られないとき、--testsが無いときは、壊し方を当てずに非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const greater = keyOf('src/rules.ts', 'age > 18');
    await writeFile(
      join(f.repo, 'test/adult.test.ts'),
      `${header}import { isAdult } from '../src/rules.ts';
test('adult', () => expect(isAdult(30)).toBe(false));\n`,
    );
    const cases = [
      {
        args: ['--key', greater, '--tests', 'test/adult.test.ts'],
        message: '壊していない状態で渡したテストが通りません',
      },
      {
        args: ['--key', `${greater}x`, '--tests', 'test/young.test.ts'],
        message: `鍵に当たる壊し方が今のsrc/rules.tsから作られません: ${greater}x`,
      },
      {
        args: ['--key', greater],
        message: '--keyで確かめるときは、--testsにテストファイルを渡してください',
      },
    ];
    for (const { args, message } of cases) {
      const result = mutation(f, args);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stderr, result.output).toContain(message);
      expect(result.stderr).not.toMatch(/壊し方 \d+\//);
      expect(result.raw).toBeUndefined();
      expect(current(f, 'src/rules.ts')).toBe(head(f, 'src/rules.ts'));
    }
  });
}, 60000);

test('記録した壊し方は、すり抜ければ一覧に入れず、拾われればstaleへkilledで、作られなければnot-generatedで入れ、ほかのモジュールの鍵は入れない', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const caught = keyOf('src/rules.ts', 'true');
    const gone = 'src/rules.ts:isAdult:gone:EqualityOperator:000000000000';
    await writeFile(
      join(f.repo, '.feedback-loop-mutants.json'),
      JSON.stringify({
        equivalent: [
          { key: keyOf('src/rules.ts', 'age > 18'), reason: '境界の18を渡す呼び出し元がない' },
          { key: caught, reason: '拾われる記録' },
          { key: gone, reason: '消えた壊し方' },
          { key: 'src/loop.ts:drain:gone:BooleanLiteral:000000000000', reason: '別のモジュール' },
        ],
      }),
    );
    const result = mutation(f, ['src/rules.ts']);
    expect(result.code, result.output).toBe(0);
    expect(result.raw, result.output).toEqual({
      survived: [],
      timedOut: [],
      errors: [],
      stale: [
        { key: caught, reason: 'killed' },
        { key: gone, reason: 'not-generated' },
      ],
    });
    expect(result.stderr).toContain('記録した壊し方のうち2件は、拾われたか作られなくなりました');
    expect(result.stderr).toContain('改善するものがありません');
  });
}, 60000);

test('記録ファイルの形が崩れていると、記録ファイルのパスを示し、壊し方を当てずに非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    await writeFile(
      join(f.repo, '.feedback-loop-mutants.json'),
      JSON.stringify({ equivalent: [], note: '余分なキー' }),
    );
    const result = mutation(f, ['src/rules.ts']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.stderr).toContain('.feedback-loop-mutants.jsonの形が崩れています');
    expect(result.stderr).not.toContain('基準の実行');
    expect(result.raw).toBeUndefined();
  });
}, 60000);

test('モジュールを書き込んだpackage scriptから起動しても、再実行の案内はモジュールと--testsの引数を1回ずつ含む', async () => {
  const pkg: unknown = JSON.parse(mutationFiles['package.json']);
  assert(isRecord(pkg) && isRecord(pkg.scripts));
  await fixture(
    {
      ...mutationFiles,
      'package.json': JSON.stringify({
        ...pkg,
        scripts: {
          ...pkg.scripts,
          'mutation:rules': 'bun scripts/feedback-loop/runtime.mjs mutation src/rules.ts',
        },
      }),
    },
    async (f) => {
      await prepared(f);
      const result = run(f, ['run', 'mutation:rules', '--tests', 'test/adult.test.ts'], {}, 60000);
      expect(result.code, result.output).toBe(0);
      expect(result.stderr).toMatch(
        /再実行: bun \S*scripts\/feedback-loop\/runtime\.mjs mutation src\/rules\.ts --tests test\/adult\.test\.ts\n/,
      );
    },
  );
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
