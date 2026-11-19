import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as oxc from 'oxc-parser';
import { generate } from '../scripts/build.ts';
import { mutants } from '../src/mutants.ts';
import { isRecord } from '../src/values.ts';
import {
  baseEnv,
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
import { vitestConfig, vitestHeader, vitestModules } from './support/vitest.ts';

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
      JSON.stringify({ equivalent: [{ key: gone, original: 'true', reason: '消えた壊し方' }] }),
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

// fixtureのモジュールの壊し方の鍵を、置き換えの後の字から引く。
function mutantOf(
  path: string,
  replacement: string,
  sources: Record<string, string> = mutationFiles,
) {
  const source = sources[path];
  assert(source !== undefined, `fixtureに${path}がありません`);
  const found = mutants(oxc, path, source).find((m) => m.replacement === replacement);
  assert(found !== undefined, `${path}に${replacement}への壊し方がありません`);
  return found;
}

function keyOf(path: string, replacement: string, sources?: Record<string, string>) {
  return mutantOf(path, replacement, sources).key;
}

// 壊し方の記録1件。originalは、一覧のJSONのoriginalを写す。
function recordOf(
  path: string,
  replacement: string,
  reason = '理由',
  sources?: Record<string, string>,
) {
  const { key, original } = mutantOf(path, replacement, sources);
  return { key, original, reason };
}

async function writeRecords(f: Fixture, equivalent: unknown[]) {
  await writeFile(join(f.repo, '.feedback-loop-mutants.json'), JSON.stringify({ equivalent }));
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

      // 記録した鍵が拾われたら、記録から外す案内を書く。時間切れでは書かない。
      const endless = keyOf('src/loop.ts', 'true');
      await writeRecords(f, [
        recordOf('src/rules.ts', 'age > 18'),
        recordOf('src/loop.ts', 'true'),
      ]);
      const guidance = `この鍵は.feedback-loop-mutants.jsonに記録されていますが、渡したテストが拾いました。記録から外してください: ${greater}`;

      const killed = mutation(f, ['--key', greater, '--tests', 'test/boundary.test.ts']);
      expect(killed.code, killed.output).toBe(0);
      expect(killed.raw, killed.output).toEqual({ ...item, verdict: 'killed' });
      expect(killed.stderr).toContain(guidance);
      // 渡したテストだけで確かめ、全qualityで確かめ直さない。
      expect(killed.stderr).not.toContain('全quality');

      const survived = mutation(f, ['--key', greater, '--tests', 'test/adult.test.ts']);
      expect(survived.code, survived.output).not.toBe(0);
      expect(survived.raw, survived.output).toEqual({ ...item, verdict: 'survived' });
      expect(survived.stderr).toContain(
        `渡したテストは、この壊し方を拾いません（survived）: ${greater}`,
      );
      expect(survived.stderr).not.toContain('記録から外してください');
      expect(current(f, 'src/rules.ts')).toBe(head(f, 'src/rules.ts'));

      const timedOut = mutation(f, ['--key', endless, '--tests', 'test/loop.test.ts']);
      expect(timedOut.code, timedOut.output).toBe(0);
      expect(timedOut.raw, timedOut.output).toMatchObject({ key: endless, verdict: 'timedOut' });
      expect(timedOut.stderr).not.toContain('記録から外してください');
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
      {
        args: ['--key', `./${greater}`, '--tests', 'test/young.test.ts'],
        message: `鍵は、repoからのそろえたパス（./や前後の空白を持たない）と、関数、経路、規則、hashを':'でつなぎます: ./${greater}`,
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

test('記録と鍵とoriginalの一致する壊し方は、すり抜ければ一覧に入れず、拾われればstaleへkilledで、作られなくなった鍵と消えたファイルの鍵はnot-generatedで入れ、ほかのモジュールの鍵は入れない', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const caught = recordOf('src/rules.ts', 'true', '拾われる記録');
    const gone = 'src/rules.ts:isAdult:gone:EqualityOperator:000000000000';
    const removed = 'src/removed.ts:check:body:BooleanLiteral:000000000000';
    // 大文字と小文字だけが違うパスと、ファイルの下を指すパスは、ファイルが無いとみなす。
    const upper = `src/Rules.ts${gone.slice('src/rules.ts'.length)}`;
    const underFile = 'src/rules.ts/x.ts:check:body:BooleanLiteral:000000000000';
    const equivalent = recordOf('src/rules.ts', 'age > 18', '境界の18を渡す呼び出し元がない');
    await writeRecords(f, [
      equivalent,
      caught,
      { key: gone, original: 'age >= 18', reason: '消えた壊し方' },
      {
        key: 'src/loop.ts:drain:gone:BooleanLiteral:000000000000',
        original: 'false',
        reason: '別のモジュール',
      },
      // 名前を変えたか消したモジュールの記録は、どのモジュールの実行でもnot-generatedに入れる。
      { key: removed, original: 'true', reason: '消えたモジュール' },
      { key: upper, original: 'age >= 18', reason: '大文字のパス' },
      { key: underFile, original: 'true', reason: 'ファイルの下のパス' },
    ]);
    const result = mutation(f, ['src/rules.ts']);
    expect(result.code, result.output).toBe(0);
    expect(result.raw, result.output).toEqual({
      survived: [],
      timedOut: [],
      errors: [],
      stale: [
        { key: caught.key, reason: 'killed' },
        { key: gone, reason: 'not-generated' },
        { key: removed, reason: 'not-generated' },
        { key: upper, reason: 'not-generated' },
        { key: underFile, reason: 'not-generated' },
      ],
    });
    expect(result.stderr).toContain(
      `記録した壊し方のうち5件を、.feedback-loop-mutants.jsonから外してください（理由は一覧のstaleにあります）: ${caught.key} ${gone} ${removed} ${upper} ${underFile}\n`,
    );
    expect(result.stderr).toContain('改善するものがありません');

    // 置き換える前の字が記録と違えば、記録で除かずに一覧へ入れ、記録をchangedにする。
    await writeRecords(f, [{ ...equivalent, original: 'age >= 17' }]);
    const changed = mutation(f, ['src/rules.ts']);
    expect(changed.code, changed.output).toBe(0);
    expect(changed.raw, changed.output).toEqual({
      survived: [
        {
          key: equivalent.key,
          path: 'src/rules.ts',
          line: 2,
          rule: 'EqualityOperator',
          original: 'age >= 18',
          replacement: 'age > 18',
        },
      ],
      timedOut: [],
      errors: [],
      stale: [{ key: equivalent.key, reason: 'changed' }],
    });
    expect(changed.stderr).toContain(
      `記録した壊し方のうち1件を、.feedback-loop-mutants.jsonから外してください（理由は一覧のstaleにあります）: ${equivalent.key}`,
    );
    expect(changed.stderr).not.toContain('改善するものがありません');
  });
}, 120000);

// 文字列リテラルのメンバー名は、鍵の関数の部分に':'を持ち込む。id 0を渡すテストが無いので、>= 0とtrueへの置き換えはすり抜ける。
// src/events.ts:old.tsは、名前の途中までがsrc/events.tsと同じで、':'を含むファイルである。
const memberFiles = {
  ...mutationFiles,
  'src/events.ts:old.ts': 'export const legacy = (n: number) => n > 0;\n',
  'src/events.ts':
    "export const handlers = {\n  'user:created': (event: { id: number }) => event.id > 0,\n};\n",
  'test/events.test.ts': `${header}import { handlers } from '../src/events.ts';
test('created', () => expect(handlers['user:created']({ id: 1 })).toBe(true));\n`,
};

test('関数の名前やファイル名が:を含む鍵でも、--keyは鍵のモジュールで確かめ、一覧は記録を鍵のモジュールだけで照らす', async () => {
  await fixture(memberFiles, async (f) => {
    await prepared(f);
    const caught = keyOf('src/events.ts', 'false', memberFiles);
    const byKey = mutation(f, ['--key', caught, '--tests', 'test/events.test.ts']);
    expect(byKey.code, byKey.output).toBe(0);
    expect(byKey.raw, byKey.output).toMatchObject({
      key: caught,
      path: 'src/events.ts',
      verdict: 'killed',
    });
    // events.test.tsはlegacyを呼ばないので、すり抜ける。鍵のモジュールで壊し方を作れたことを、pathで確かめる。
    const legacy = recordOf('src/events.ts:old.ts', 'n >= 0', '理由', memberFiles);
    const colon = mutation(f, ['--key', legacy.key, '--tests', 'test/events.test.ts']);
    expect(colon.raw, colon.output).toMatchObject({
      key: legacy.key,
      path: 'src/events.ts:old.ts',
      verdict: 'survived',
    });

    await writeRecords(f, [
      recordOf('src/events.ts', 'event.id >= 0', '理由', memberFiles),
      recordOf('src/events.ts', 'true', '理由', memberFiles),
      legacy,
    ]);
    const own = mutation(f, ['src/events.ts']);
    expect(own.code, own.output).toBe(0);
    expect(own.raw, own.output).toEqual({ survived: [], timedOut: [], errors: [], stale: [] });
    expect(own.stderr).toContain('改善するものがありません');

    const other = mutation(f, ['src/rules.ts']);
    expect(other.raw, other.output).toMatchObject({ stale: [] });
  });
}, 120000);

test('--testsを渡した一覧の実行では、渡したテストをすり抜けた記録の壊し方を全qualityで確かめ直さず、一覧にもstaleにも入れない', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    // trueへの置き換えは、渡さないyoung.test.tsだけが拾う。全qualityで確かめ直せば、staleのkilledに入る。
    await writeRecords(f, [recordOf('src/rules.ts', 'age > 18'), recordOf('src/rules.ts', 'true')]);
    const result = mutation(f, ['src/rules.ts', '--tests', 'test/adult.test.ts']);
    expect(result.code, result.output).toBe(0);
    expect(result.raw, result.output).toEqual({
      survived: [],
      timedOut: [],
      errors: [],
      stale: [],
    });
    expect(result.stderr.match(/（渡したテスト）: survived /g), result.output).toHaveLength(2);
    expect(result.stderr).not.toContain('全quality');
  });
}, 60000);

test('記録した壊し方が時間切れになると、負荷による時間切れと区別できないため、staleに入れず一覧のtimedOutに入れる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const endless = recordOf('src/loop.ts', 'true');
    await writeRecords(f, [endless]);
    const result = mutation(f, ['src/loop.ts', '--tests', 'test/loop.test.ts']);
    expect(result.code, result.output).toBe(0);
    expect(result.raw, result.output).toEqual({
      survived: [],
      timedOut: [
        {
          key: endless.key,
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
    expect(result.stderr).toContain(`（渡したテスト）: timedOut ${endless.key}`);
  });
}, 60000);

test('記録した壊し方がエラーで終わるとerrorsへ入れ、staleがあれば記録から外す案内を書いてから非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const throwing = recordOf('src/startup.ts', 'false');
    const gone = 'src/startup.ts:<top>:gone:BooleanLiteral:000000000000';
    await writeRecords(f, [throwing, { key: gone, original: 'true', reason: '消えた壊し方' }]);
    const result = mutation(f, ['src/startup.ts']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.report, result.output).toMatchObject({
      survived: [],
      timedOut: [],
      errors: [{ path: 'src/startup.ts', original: 'true', replacement: 'false' }],
    });
    expect(result.raw).toMatchObject({ stale: [{ key: gone, reason: 'not-generated' }] });
    expect(result.stderr).toContain(
      `記録した壊し方のうち1件を、.feedback-loop-mutants.jsonから外してください（理由は一覧のstaleにあります）: ${gone}`,
    );
    expect(result.stderr).toContain('エラーで終わった壊し方が1件あります');
  });
}, 60000);

const vitestFiles = {
  ...Object.fromEntries(
    Object.entries(mutationFiles).map(([path, body]) => [
      path,
      path.startsWith('test/') ? body.replace(header, vitestHeader) : body,
    ]),
  ),
  '.feedback-loop.json': JSON.stringify(vitestConfig(config)),
  'vitest.config.ts': `import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: '.vitest-cache', test: { experimental: { recordDependencies: true } } });\n`,
};

function nodeMutation(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('node', ['scripts/feedback-loop/runtime.mjs', 'mutation', ...args], {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...baseEnv(f), ...env },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return {
    code: result.status,
    output: result.stdout + result.stderr,
    stderr: result.stderr,
    ...parse(result.stdout),
  };
}

test('nodeで起動したVitestの導入先で、一覧は既存のテストが拾わない壊し方だけを返し、--keyは渡したテストの判定を返し、どちらもVitestの依存記録を書かない', async () => {
  await fixture(vitestFiles, async (f) => {
    await prepared(f);
    const listed = nodeMutation(f, ['src/rules.ts']);
    expect(listed.code, listed.output).toBe(0);
    expect(listed.report, listed.output).toEqual({
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
    expect(listed.keys).toEqual([keyOf('src/rules.ts', 'age > 18')]);

    const always = keyOf('src/rules.ts', 'true');
    const byKey = nodeMutation(f, ['--key', always, '--tests', 'test/young.test.ts']);
    expect(byKey.code, byKey.output).toBe(0);
    expect(byKey.raw, byKey.output).toMatchObject({ key: always, verdict: 'killed' });
    expect(current(f, 'src/rules.ts')).toBe(head(f, 'src/rules.ts'));
    expect(existsSync(join(f.repo, '.vitest-cache'))).toBe(false);
  });
}, 120000);

test('Vitestの導入先で、渡したテストのパスを名前に含むほかのテストファイルは判定に入れず、testGlobsに当たらないものが結果に混ざれば、壊し方を当てずに非ゼロで終わる', async () => {
  await fixture(
    {
      ...vitestFiles,
      '.feedback-loop.json': JSON.stringify(
        vitestConfig({ ...config, testGlobs: ['test/*.test.ts', 'e2etest/*.test.ts'] }),
      ),
      'scripts/collect.ts':
        "import { readdirSync } from 'node:fs'; console.log(JSON.stringify(['test', 'e2etest'].flatMap(d => readdirSync(d).filter(p => p.endsWith('.test.ts')).map(p => d + '/' + p))));\n",
      'e2etest/adult.test.ts': `${vitestHeader}import { isAdult } from '../src/rules.ts';
test('boundary', () => expect(isAdult(18)).toBe(true));\n`,
    },
    async (f) => {
      await prepared(f);
      const key = keyOf('src/rules.ts', 'age > 18');
      const args = ['--key', key, '--tests', 'test/adult.test.ts'];
      const classified = nodeMutation(f, args);
      expect(classified.raw, classified.output).toMatchObject({ key, verdict: 'survived' });

      await mkdir(join(f.repo, 'other/test'), { recursive: true });
      await writeFile(
        join(f.repo, 'other/test/adult.test.ts'),
        `${vitestHeader}test('other', () => expect(1).toBe(1));\n`,
      );
      const unclassified = nodeMutation(f, args);
      expect(unclassified.code, unclassified.output).not.toBe(0);
      expect(unclassified.stderr, unclassified.output).toContain(
        '壊していない状態で渡したテストが通りません（渡していないテストファイルが結果にあります: other/test/adult.test.ts）',
      );
      expect(unclassified.stderr).not.toMatch(/壊し方 \d+\//);
      expect(current(f, 'src/rules.ts')).toBe(head(f, 'src/rules.ts'));
    },
  );
}, 60000);

test('Vitestの導入先で、壊し方でテストの読み込みが投げると、拾ったでなくエラーとし、理由にそのテストのパスを入れる', async () => {
  await fixture(vitestFiles, async (f) => {
    await prepared(f);
    const result = nodeMutation(f, ['src/startup.ts']);
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
    expect(result.reasons).toEqual([
      '読み込みに失敗したテストファイルがあります: test/startup.test.ts',
    ]);
    expect(current(f, 'src/startup.ts')).toBe(head(f, 'src/startup.ts'));
  });
}, 60000);

const hookFiles = {
  ...vitestFiles,
  'src/ready.ts': 'export function ready() {\n  return true;\n}\n',
  'test/hook.test.ts': `import { beforeAll, expect, test } from 'vitest';
import { ready } from '../src/ready.ts';
beforeAll(() => {
  if (!ready()) throw new Error('not ready');
});
test('runs', () => expect(1).toBe(1));\n`,
};

test('Vitestの導入先で、壊し方でbeforeAllが投げると、読み込みの失敗でなく拾ったと判定する', async () => {
  await fixture(hookFiles, async (f) => {
    await prepared(f);
    const key = keyOf('src/ready.ts', 'false', hookFiles);
    const result = nodeMutation(f, ['--key', key, '--tests', 'test/hook.test.ts']);
    expect(result.code, result.output).toBe(0);
    expect(result.raw, result.output).toMatchObject({ key, verdict: 'killed' });
    expect(current(f, 'src/ready.ts')).toBe(head(f, 'src/ready.ts'));
  });
}, 60000);

test('Vitestの導入先で、実行したテストが0件のとき、渡したテストが結果に無いとき、Vitestが結果のJSONを出さないときは、壊していない状態で通らないとして、壊し方を当てずに非ゼロで終わる', async () => {
  await fixture(
    {
      ...vitestFiles,
      'vitest.config.ts': `import { configDefaults, defineConfig } from 'vitest/config';
if (process.env.BREAK_VITEST) throw new Error('設定の読み込みの失敗');
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'test/dropped.test.ts'] } });\n`,
      'test/skipped.test.ts': `${vitestHeader}test.skip('skipped', () => expect(1).toBe(2));\n`,
      'test/dropped.test.ts': `${vitestHeader}test('dropped', () => expect(1).toBe(1));\n`,
    },
    async (f) => {
      await prepared(f);
      const cases = [
        { args: ['--tests', 'test/skipped.test.ts'], env: {}, reason: '実行したテストが0件です' },
        {
          args: ['--tests', 'test/adult.test.ts', 'test/dropped.test.ts'],
          env: {},
          reason: '報告にないテストファイルがあります（読み込みの失敗など）: test/dropped.test.ts',
        },
        {
          args: ['--tests', 'test/adult.test.ts'],
          env: { BREAK_VITEST: '1' },
          reason: 'テストの結果の報告がありません',
        },
      ];
      for (const { args, env, reason } of cases) {
        const result = nodeMutation(f, ['src/rules.ts', ...args], env);
        expect(result.code, result.output).not.toBe(0);
        expect(result.stderr, result.output).toContain(
          `壊していない状態で渡したテストが通りません（${reason}）`,
        );
        expect(result.stderr).not.toMatch(/壊し方 \d+\//);
        expect(current(f, 'src/rules.ts')).toBe(head(f, 'src/rules.ts'));
      }
    },
  );
}, 60000);

test('Vitestの導入先で、終わらない壊し方は時間切れとして一覧のtimedOutへ入れ、対象のファイルを元に戻す', async () => {
  await fixture(vitestFiles, async (f) => {
    await prepared(f);
    const result = nodeMutation(f, ['src/loop.ts', '--tests', 'test/loop.test.ts']);
    expect(result.code, result.output).toBe(0);
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
    expect(current(f, 'src/loop.ts')).toBe(head(f, 'src/loop.ts'));
  });
}, 60000);

test('記録ファイルの形が崩れていると、構文解析器の読み込みと分類の前に、記録ファイルのパスを示して非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    // oxc-parserを置かない。記録ファイルより先に読み込めば、oxc-parserの診断で止まる。
    installed(f);
    await writeFile(
      join(f.repo, '.feedback-loop-mutants.json'),
      JSON.stringify({ equivalent: [], note: '余分なキー' }),
    );
    const key = keyOf('src/rules.ts', 'age > 18');
    for (const args of [['src/rules.ts'], ['--key', key, '--tests', 'test/adult.test.ts']]) {
      const result = mutation(f, args);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stderr).toContain('.feedback-loop-mutants.jsonの形が崩れています');
      expect(result.stderr).not.toContain('oxc-parser');
      // 分類は、収集のコマンドを「収集: 」で表示する。
      expect(result.stderr).not.toContain('収集: ');
      expect(result.raw).toBeUndefined();
    }
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
