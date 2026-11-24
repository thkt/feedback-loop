import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, header, installed, run } from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { isRecord } from './support/json.ts';
import { git } from './support/runner-affected.ts';
import { linkModules, mutatorConfig, mutatorFiles } from './support/mutator.ts';

const rulesSource = `export function label(value: unknown): string {
  if (typeof value !== 'string') {
    return 'none';
  }
  console.log(\`長さ: \${value.length > 2}\`);
  return value.toUpperCase();
}

export function isAdult(age: number) {
  return age >= 18;
}

export function sum(a: number, b: number) {
  return a + b;
}
`;

const childProbe = `${header}import { spawnSync } from 'node:child_process';
test('child', () => {
  expect(process.env.FROM_ENV_FILE).toBeUndefined();
  expect(Reflect.get(globalThis, 'userPreloaded') ?? null).toBe(process.env.EXPECT_USER_PRELOAD === '1' ? true : null);
  const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.BUN_OPTIONS ?? null, process.env.FROM_ENV_FILE ?? null, Reflect.get(globalThis, "userPreloaded") ?? null]))'], { encoding: 'utf8' });
  expect(JSON.parse(child.stdout)).toEqual([process.env.EXPECT_BUN_OPTIONS ?? null, '1', process.env.EXPECT_USER_PRELOAD === '1' ? true : null]);
});
`;

const failing = `${header}test('never', () => expect(1).toBe(2));\n`;

const mutationConfig = {
  ...mutatorConfig,
  assurance: [
    { path: 'test/assurance.test.ts', reason: '資源解放の確認' },
    { path: 'test/.hidden.test.ts', reason: '名前が.で始まるassuranceの確認' },
  ],
  prepare: [process.execPath, 'scripts/prepare.ts'],
};

const mutationFiles = {
  ...mutatorFiles,
  '.env': 'FROM_ENV_FILE=1\n',
  'bunfig.toml': '[install]\nexact = true\n',
  '.feedback-loop.json': JSON.stringify(mutationConfig),
  'scripts/prepare.ts':
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PREPARE_LOG ?? '/dev/null', 'prepared\\n');\n",
  'scripts/user-preload.ts': "Reflect.set(globalThis, 'userPreloaded', true);\n",
  'src/rules.ts': rulesSource,
  'test/rules.test.ts': `${header}import { isAdult, label } from '../src/rules.ts';
test('upper', () => expect(label('ab')).toBe('AB'));
test('adult', () => expect(isAdult(30)).toBe(true));
`,
  'test/child.test.ts': childProbe,
  'test/assurance.test.ts': failing,
  'test/.hidden.test.ts': failing,
  'other/outside.test.ts': failing,
};

function mutation(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = run(
    f,
    ['--no-env-file', 'scripts/feedback-loop/runtime.mjs', 'mutation', ...args],
    { PREPARE_LOG: join(f.signals, 'prepare.log'), ...env },
    120000,
  );
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }
  return { ...result, report };
}

type Listed = {
  key: string;
  path: string;
  line: number;
  rule: string;
  original: string;
  replacement: string;
};

function isListed(value: unknown): value is Listed {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.path === 'string' &&
    typeof value.line === 'number' &&
    typeof value.rule === 'string' &&
    typeof value.original === 'string' &&
    typeof value.replacement === 'string'
  );
}

function listed(report: unknown, name: 'survived' | 'uncovered' | 'timedOut' | 'errors') {
  assert(isRecord(report), 'mutationの標準出力がJSONのオブジェクトではありません');
  const value = report[name];
  assert(Array.isArray(value) && value.every(isListed), `${name}の要素の形が違います`);
  return value;
}

function withoutKeys(items: Listed[]) {
  return items.map(({ key: _key, ...rest }) => rest);
}

const narrowingItem = {
  path: 'src/rules.ts',
  line: 2,
  rule: 'ConditionalExpression',
  original: "typeof value !== 'string'",
  replacement: 'false',
};

function keyOf(items: Listed[], original: string, replacement: string) {
  const found = items.find(
    (item) => item.original === original && item.replacement === replacement,
  );
  expect(found, `${original} -> ${replacement}`).toBeDefined();
  return found?.key ?? '';
}

function prepareCount(f: Fixture) {
  const log = join(f.signals, 'prepare.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}

test('モジュールの壊し方をqualityだけで判定して標準出力のJSONに分け、ログ出力だけの文も判定し、型検査に通らない壊し方と記録した鍵を一覧から外し、追跡ファイルを変えない', async () => {
  await fixture(mutationFiles, async (f) => {
    await linkModules(f.repo);
    installed(f);
    const userOptions = '--preload=./scripts/user-preload.ts';
    const env = {
      BUN_OPTIONS: userOptions,
      EXPECT_BUN_OPTIONS: userOptions,
      EXPECT_USER_PRELOAD: '1',
    };

    const untyped = mutation(f, ['src/rules.ts'], env);
    expect(untyped.code, untyped.output).toBe(0);
    expect(prepareCount(f)).toBe(1);
    assert(isRecord(untyped.report));
    expect(Object.keys(untyped.report).toSorted()).toEqual([
      'errors',
      'survived',
      'timedOut',
      'uncovered',
    ]);
    const survived = listed(untyped.report, 'survived');
    const uncovered = listed(untyped.report, 'uncovered');
    expect(listed(untyped.report, 'errors')).toEqual([]);
    expect(withoutKeys(survived)).toContainEqual({
      path: 'src/rules.ts',
      line: 5,
      rule: 'EqualityOperator',
      original: 'value.length > 2',
      replacement: 'value.length >= 2',
    });
    expect(withoutKeys(survived)).toContainEqual(narrowingItem);
    expect(withoutKeys(uncovered)).toContainEqual({
      path: 'src/rules.ts',
      line: 14,
      rule: 'ArithmeticOperator',
      original: 'a + b',
      replacement: 'a - b',
    });
    const narrowingKey = keyOf(survived, narrowingItem.original, narrowingItem.replacement);
    const logKey = keyOf(survived, 'value.length > 2', 'value.length >= 2');
    const sumKey = keyOf(uncovered, 'a + b', 'a - b');

    await writeFile(
      join(f.repo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true },
      }),
    );
    await writeFile(
      join(f.repo, 'mutator.accepted.json'),
      JSON.stringify({ [logKey]: { reason: 'ログの文言だけが変わる' } }),
    );
    git(f.repo, 'add', 'tsconfig.json');
    git(f.repo, 'commit', '-m', 'tsconfig');
    const before = {
      status: git(f.repo, 'status', '--porcelain'),
      source: readFileSync(join(f.repo, 'src/rules.ts'), 'utf8'),
    };

    const typed = mutation(f, ['src/rules.ts'], env);
    expect(typed.code, typed.output).toBe(0);
    const typedSurvived = listed(typed.report, 'survived');
    expect(typedSurvived.map(({ key }) => key)).not.toContain(narrowingKey);
    expect(typedSurvived.map(({ key }) => key)).not.toContain(logKey);
    expect(listed(typed.report, 'uncovered').map(({ key }) => key)).toContain(sumKey);
    expect(git(f.repo, 'status', '--porcelain')).toBe(before.status);
    expect(readFileSync(join(f.repo, 'src/rules.ts'), 'utf8')).toBe(before.source);
    expect(existsSync(join(f.repo, '.mutator'))).toBe(true);

    const typeError = mutation(f, ['src/rules.ts', '--key', narrowingKey], env);
    expect(typeError.code, typeError.output).not.toBe(0);
    assert(isRecord(typeError.report));
    const { reason, ...typeErrorReport } = typeError.report;
    expect(typeErrorReport).toEqual({ key: narrowingKey, ...narrowingItem, verdict: 'error' });
    expect(String(reason)).toContain('18046');

    const accepted = mutation(f, ['src/rules.ts', '--key', logKey], env);
    expect(accepted.code, accepted.output).not.toBe(0);
    expect(accepted.stdout).toBe('');
    expect(accepted.stderr).toContain(
      `この鍵はmutator.accepted.jsonに記録されています（ログの文言だけが変わる）。今この鍵に当たる壊し方は、src/rules.tsの5行目、EqualityOperator、「value.length > 2」を「value.length >= 2」に置き換えるものです。今のテストの判定は「拾わない」です。記録にある鍵の結果は、標準出力に書かず、非ゼロで終わります。記録から外すと、結果を標準出力に書きます: ${logKey}`,
    );

    const notCaught = mutation(f, ['src/rules.ts', '--key', sumKey], env);
    expect(notCaught.code, notCaught.output).not.toBe(0);
    assert(isRecord(notCaught.report));
    expect([notCaught.report.key, notCaught.report.verdict]).toEqual([sumKey, 'uncovered']);

    await writeFile(
      join(f.repo, 'test/sum.test.ts'),
      `${header}import { sum } from '../src/rules.ts';\ntest('sum', () => expect(sum(2, 1)).toBe(3));\n`,
    );
    const caught = mutation(f, ['src/rules.ts', '--key', sumKey], env);
    expect(caught.code, caught.output).toBe(0);
    expect(caught.report).toEqual({
      key: sumKey,
      path: 'src/rules.ts',
      line: 14,
      rule: 'ArithmeticOperator',
      original: 'a + b',
      replacement: 'a - b',
      verdict: 'killed',
    });

    await writeFile(
      join(f.repo, 'mutator.accepted.json'),
      JSON.stringify({
        [logKey]: { reason: 'ログの文言だけが変わる' },
        [sumKey]: { reason: '足したテストより前に記録した' },
      }),
    );
    const caughtRecord = mutation(f, ['src/rules.ts', '--key', sumKey], env);
    expect(caughtRecord.code, caughtRecord.output).not.toBe(0);
    expect(caughtRecord.stdout).toBe('');
    expect(caughtRecord.stderr).toContain(
      `この鍵はmutator.accepted.jsonに記録されています（足したテストより前に記録した）。今この鍵に当たる壊し方は、src/rules.tsの14行目、ArithmeticOperator、「a + b」を「a - b」に置き換えるものです。今のテストの判定は「killed」です。記録にある鍵の結果は、標準出力に書かず、非ゼロで終わります。記録から外すと、結果を標準出力に書きます: ${sumKey}`,
    );

    const unknown = mutation(f, ['src/rules.ts', '--key', 'no-such-key'], env);
    expect(unknown.code, unknown.output).not.toBe(0);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain(
      '鍵に当たる壊し方が今のsrc/rules.tsから作られません: no-such-key',
    );
  });
}, 300000);

const extraSource = `export function drain(items: number[]) {
  let pending = true;
  let total = 0;
  while (pending) {
    total += items.length;
    pending = false;
  }
  return total;
}

export function spawned(flag: boolean) {
  return flag ? 'yes' : 'no';
}
`;

test('名前にglobの記号を含むモジュールで、終わらない壊し方はtimedOutに、テストが起こした子プロセスだけが実行する壊し方はuncoveredに入り、時間切れの--keyは終了0で終わり、記録にある時間切れの--keyは標準出力に何も書かず非ゼロで終わる', async () => {
  await fixture(
    {
      ...mutationFiles,
      'src/[id]/extra.ts': extraSource,
      'test/extra.test.ts': `${header}import { drain } from '../src/[id]/extra.ts';\ntest('drain', () => expect(drain([1, 2])).toBe(2));\n`,
      'test/spawn.test.ts': `${header}import { spawnSync } from 'node:child_process';
test('spawned', () => {
  const child = spawnSync(process.execPath, ['-e', "import('./src/[id]/extra.ts').then((m) => process.exit(m.spawned(true) === 'yes' ? 0 : 1))"]);
  expect(child.status).toBe(0);
});
`,
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/[id]/extra.ts']);
      expect(result.code, result.output).toBe(0);
      expect(withoutKeys(listed(result.report, 'timedOut'))).toContainEqual({
        path: 'src/[id]/extra.ts',
        line: 6,
        rule: 'BooleanLiteral',
        original: 'false',
        replacement: 'true',
      });
      const uncovered = withoutKeys(listed(result.report, 'uncovered'));
      expect(uncovered).toContainEqual({
        path: 'src/[id]/extra.ts',
        line: 12,
        rule: 'ConditionalExpression',
        original: 'flag',
        replacement: 'false',
      });
      expect(uncovered.filter(({ line }) => line < 10)).toEqual([]);
      const loopKey = keyOf(listed(result.report, 'timedOut'), 'false', 'true');

      const key = mutation(f, ['src/[id]/extra.ts', '--key', loopKey]);
      expect(key.code, key.output).toBe(0);
      assert(isRecord(key.report));
      expect([key.report.key, key.report.verdict]).toEqual([loopKey, 'timedOut']);

      await writeFile(
        join(f.repo, 'mutator.accepted.json'),
        JSON.stringify({ [loopKey]: { reason: '終わらない壊し方の記録' } }),
      );
      const recorded = mutation(f, ['src/[id]/extra.ts', '--key', loopKey]);
      expect(recorded.code, recorded.output).not.toBe(0);
      expect(recorded.stdout).toBe('');
      expect(recorded.stderr).toContain(
        `この鍵はmutator.accepted.jsonに記録されています（終わらない壊し方の記録）。今この鍵に当たる壊し方は、src/[id]/extra.tsの6行目、BooleanLiteral、「false」を「true」に置き換えるものです。今のテストの判定は「timedOut」です。記録にある鍵の結果は、標準出力に書かず、非ゼロで終わります。記録から外すと、結果を標準出力に書きます: ${loopKey}`,
      );
    },
  );
}, 240000);

const workerProbe = `${header}import { appendFileSync } from 'node:fs';
test('overlap', async () => {
  const log = process.env.WORKER_LOG;
  if (log !== undefined) appendFileSync(log, \`\${Date.now()} 1\\n\`);
  await Bun.sleep(700);
  if (log !== undefined) appendFileSync(log, \`\${Date.now()} -1\\n\`);
});
`;

const pacingFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  'src/tiny.ts': 'export function isPositive(n: number) {\n  return n > 0;\n}\n',
  'test/tiny.test.ts': `${header}import { isPositive } from '../src/tiny.ts';
test('tiny', () => {
  expect(isPositive(1)).toBe(true);
  expect(isPositive(-1)).toBe(false);
});
`,
  'test/slow.test.ts': `${header}import { appendFileSync } from 'node:fs';
test('slow-baseline', async () => {
  const log = process.env.WORKER_LOG;
  if (log !== undefined) appendFileSync(log, \`\${Date.now()} 1\\n\`);
  await Bun.sleep(Number(process.env.SLOW_MS ?? '0'));
  if (log !== undefined) appendFileSync(log, \`\${Date.now()} -1\\n\`);
});
`,
  'test/w1.test.ts': workerProbe,
  'test/w2.test.ts': workerProbe,
  'test/w3.test.ts': workerProbe,
};

function maxOverlap(log: string) {
  const events = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' ').map(Number))
    .toSorted(([a = 0, da = 0], [b = 0, db = 0]) => a - b || da - db);
  let running = 0;
  let most = 0;
  for (const [, delta = 0] of events) {
    running += delta;
    most = Math.max(most, running);
  }
  return most;
}

test('mutatorへ、testArgsの--timeoutの3倍の時間切れと、bunWorkersの並列数を渡し、省略時はBunの既定の5000の3倍と4を渡す', async () => {
  await fixture(pacingFiles, async (f) => {
    await linkModules(f.repo);
    installed(f);
    const log = join(f.signals, 'workers.log');
    const pace = async (settings: { testArgs?: string[]; bunWorkers?: number }, slowMs: number) => {
      const { testArgs: _testArgs, ...rest } = config;
      await writeFile(
        join(f.repo, '.feedback-loop.json'),
        JSON.stringify({ ...rest, ...settings }),
      );
      await writeFile(log, '');
      await rm(join(f.repo, '.mutator'), { recursive: true, force: true });
      return mutation(f, ['src/tiny.ts'], { WORKER_LOG: log, SLOW_MS: String(slowMs) });
    };

    const spaced = await pace({ testArgs: ['--timeout', '1000'], bunWorkers: 1 }, 1500);
    expect(spaced.code, spaced.output).toBe(0);
    expect(maxOverlap(log)).toBe(1);
    expect(spaced.stderr).toContain('total test worker limit: 1');

    const joined = await pace({ testArgs: ['--timeout=1000'], bunWorkers: 2 }, 1500);
    expect(joined.code, joined.output).toBe(0);
    expect(maxOverlap(log)).toBe(2);
    expect(joined.stderr).toContain('total test worker limit: 2');
    expect(joined.stderr).toContain('(2 sessions;');

    const defaults = await pace({}, 6000);
    expect(defaults.code, defaults.output).toBe(0);
    expect(defaults.stderr).toContain('total test worker limit: 4');

    for (const testArgs of [['--timeout', '400'], ['--timeout=400']]) {
      const short = await pace({ testArgs, bunWorkers: 1 }, 1500);
      expect(short.code, short.output).not.toBe(0);
      expect(short.stdout).toBe('');
      expect(short.stderr).toContain('slow-baseline');
    }
  });
}, 300000);

test('壊す前のテストが落ちると、やり直さずに落ちたテストの名前を標準エラーに出し、標準出力に何も書かずに非ゼロで終わる', async () => {
  await fixture(
    {
      ...mutationFiles,
      '.feedback-loop.json': JSON.stringify({ ...mutationConfig, testArgs: ['--timeout=100'] }),
      'test/slow.test.ts': `${header}test('slow-baseline', async () => {\n  await Bun.sleep(1000);\n  expect(1).toBe(1);\n});\n`,
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/rules.ts']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('slow-baseline');
      expect(prepareCount(f)).toBe(1);
    },
  );
}, 120000);

test('package.jsonがGitのルートより下にあり、mutatorが親のディレクトリのnode_modulesにあっても、nodeの無いPATHで最後まで走り、tsconfig.jsonが無ければ型検査をしない', async () => {
  const nested = Object.fromEntries(
    Object.entries(mutationFiles)
      .filter(([path]) => path !== '.gitignore')
      .map(([path, body]) => [`workspace/${path}`, body]),
  );
  await fixture({ ...nested, '.gitignore': 'node_modules\n' }, async (root) => {
    await linkModules(root.repo);
    const f = { ...root, repo: join(root.repo, 'workspace') };
    installed(f);
    const bin = join(root.signals, 'bin');
    await mkdir(bin);
    for (const command of ['bun', 'git']) {
      const found = spawnSync('which', [command], { encoding: 'utf8' }).stdout.trim();
      await symlink(command === 'bun' ? process.execPath : found, join(bin, command));
    }
    expect(spawnSync('node', ['--version'], { env: { PATH: bin } }).error).toBeDefined();

    const result = mutation(f, ['src/rules.ts'], { PATH: bin });
    expect(result.code, result.output).toBe(0);
    expect(withoutKeys(listed(result.report, 'survived'))).toContainEqual(narrowingItem);
    expect(git(root.repo, 'status', '--porcelain')).toBe('');
  });
}, 180000);

test('使えない呼び方と設定では、mutatorを起こさずに理由を示して非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await linkModules(f.repo);
    installed(f);
    for (const [args, message] of [
      [['src/rules.ts', '--tests', 'test/rules.test.ts'], 'mutationは「mutation <モジュール>」'],
      [['--restore'], 'mutationは「mutation <モジュール>」'],
      [['--key', 'abc'], 'mutationは「mutation <モジュール>」'],
      [[], 'mutationは「mutation <モジュール>」'],
      [['../outside.ts'], 'repo相対パスが必要です'],
      [['src/missing.ts'], '対象のモジュールがrepoの中のファイルではありません'],
    ] as const) {
      const result = mutation(f, [...args]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(message);
    }

    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({ ...mutationConfig, bunArgs: ['scripts/wrap.ts'] }),
    );
    const script = mutation(f, ['src/rules.ts']);
    expect(script.code, script.output).not.toBe(0);
    expect(script.stderr).toContain(
      'bunArgsのスクリプト（scripts/wrap.ts）は、mutationでは使えません',
    );
    expect(script.stderr).toContain('ファイルの配置と接続');

    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({ ...mutationConfig, bunArgs: ['--env-file', '.env.test'] }),
    );
    const separate = mutation(f, ['src/rules.ts']);
    expect(separate.code, separate.output).not.toBe(0);
    expect(separate.stdout).toBe('');
    expect(separate.stderr).toContain(
      'bunArgsの「--env-file .env.test」は、mutationでは読めません',
    );
    expect(separate.stderr).toMatch(
      /スクリプトなら、[\s\S]*値を取る引数なら、--env-file=\.env\.testの形で書いてください/,
    );
    expect(separate.stderr).not.toContain('bunArgsのスクリプト（');

    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({ ...mutationConfig, bunArgs: ['--env-file=my env'] }),
    );
    const spaced = mutation(f, ['src/rules.ts']);
    expect(spaced.code, spaced.output).not.toBe(0);
    expect(spaced.stdout).toBe('');
    expect(spaced.stderr).toContain('bunArgsの「--env-file=my env」は空白を含むため');

    await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(mutationConfig));
    await writeFile(
      join(f.repo, 'bunfig.toml'),
      '[install]\nexact = true\n\n[test]\ntimeout = 1\n',
    );
    const bunfig = mutation(f, ['src/rules.ts']);
    expect(bunfig.code, bunfig.output).not.toBe(0);
    expect(bunfig.stderr).toContain('bunfig.tomlが[install]のほかの設定を持つ');

    await writeFile(
      join(f.repo, 'bunfig.toml'),
      '[install]\nexact = true\n\n[test] # 見出しの後ろのコメント\ntimeout = 1\n',
    );
    const commented = mutation(f, ['src/rules.ts']);
    expect(commented.code, commented.output).not.toBe(0);
    expect(commented.stderr).toContain('bunfig.tomlが[install]のほかの設定を持つ');

    for (const record of ['{', '[]', '{"k1":"理由"}']) {
      await writeFile(join(f.repo, 'mutator.accepted.json'), record);
      const unreadable = mutation(f, ['src/rules.ts', '--key', 'k1']);
      expect(unreadable.code, unreadable.output).not.toBe(0);
      expect(unreadable.stdout).toBe('');
      expect(unreadable.stderr, record).toContain(
        'mutator.accepted.jsonを読めません。{"<鍵>": {"reason": "<理由>"}}の形で書いてください',
      );
    }
    await unlink(join(f.repo, 'mutator.accepted.json'));

    await unlink(join(f.repo, 'node_modules'));
    for (const installOnly of [
      '[install]\nexact = true\n',
      'install.exact = true\n',
      '[install] # 見出しの後ろのコメント\nexact = true\n\n[install.cache] # 入れ子の表\ndisable = false\n',
    ]) {
      await writeFile(join(f.repo, 'bunfig.toml'), installOnly);
      const missing = mutation(f, ['src/rules.ts']);
      expect(missing.code, missing.output).not.toBe(0);
      expect(missing.stderr, installOnly).toContain('@mizchi/mutatorを読み込めません');
    }
    expect(prepareCount(f)).toBe(0);
  });
}, 120000);

test('prepareが失敗するか、qualityが0件なら、mutatorを起こさずに、標準出力に何も書かず非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await linkModules(f.repo);
    installed(f);
    await writeFile(
      join(f.repo, 'scripts/prepare.ts'),
      mutationFiles['scripts/prepare.ts'] + 'process.exit(1);\n',
    );
    const failed = mutation(f, ['src/rules.ts']);
    expect(failed.code, failed.output).not.toBe(0);
    expect(failed.stdout).toBe('');
    expect(prepareCount(f)).toBe(1);
    expect(existsSync(join(f.repo, '.mutator'))).toBe(false);

    await writeFile(join(f.repo, 'scripts/prepare.ts'), mutationFiles['scripts/prepare.ts']);
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({
        ...mutationConfig,
        assurance: Object.keys(mutationFiles)
          .filter((path) => /^test\/[^/]+\.test\.ts$/.test(path))
          .map((path) => ({ path, reason: '全候補をassuranceへ分類する対照' })),
      }),
    );
    const empty = mutation(f, ['src/rules.ts']);
    expect(empty.code, empty.output).not.toBe(0);
    expect(empty.stdout).toBe('');
    expect(empty.stderr).toContain('候補0件');
    expect(prepareCount(f)).toBe(1);
    expect(existsSync(join(f.repo, '.mutator'))).toBe(false);
  });
}, 120000);

test('mutatorが壊し方を作らなかったモジュールは、空の一覧を書いて終了0で終わり、作らなかったことを示す', async () => {
  await fixture(
    {
      ...mutationFiles,
      'src/types.ts': 'export type Age = number;\nexport interface Person {\n  age: Age;\n}\n',
      'src/ambient.d.ts': 'declare const ambient: number;\n',
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      for (const module of ['src/types.ts', 'src/ambient.d.ts']) {
        const result = mutation(f, [module]);
        expect(result.code, result.output).toBe(0);
        expect(result.report).toEqual({ survived: [], uncovered: [], timedOut: [], errors: [] });
        expect(result.stderr).toContain(
          `mutatorは${module}から壊し方を作りませんでした。mutatorが対象にしないファイルか、壊せるコードが無いファイルです`,
        );
        expect(result.stderr).toContain('テストをすり抜けた壊し方は0件です（時間切れ0件）');
        expect(result.stderr).not.toContain('改善するもの');
      }
      const rules = mutation(f, ['src/rules.ts']);
      expect(rules.code, rules.output).toBe(0);
      expect(rules.stderr).not.toContain('から壊し方を作りませんでした');
    },
  );
}, 240000);

const fixedReportMutator = (
  reportFiles: Record<string, unknown>,
) => `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[process.argv.indexOf('--report-dir') + 1];
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'mutation.json'), JSON.stringify({ files: ${JSON.stringify(reportFiles)} }));
`;

async function installFakeMutator(f: Fixture, cli: string) {
  const mutator = join(f.repo, 'node_modules/@mizchi/mutator');
  await mkdir(join(mutator, 'dist'), { recursive: true });
  await writeFile(join(mutator, 'package.json'), JSON.stringify({ name: '@mizchi/mutator' }));
  await writeFile(join(mutator, 'dist/cli.js'), cli);
}

const pendingLocation = { start: { line: 10, column: 10 }, end: { line: 10, column: 19 } };
const reportingMutator = fixedReportMutator({
  'src/rules.ts': {
    source: rulesSource,
    mutants: [
      {
        id: 'pending-1',
        mutatorName: 'EqualityOperator',
        replacement: 'age > 18',
        status: 'Pending',
        statusReason: 'not run',
        location: pendingLocation,
      },
      {
        id: 'killed-1',
        mutatorName: 'EqualityOperator',
        replacement: 'age < 18',
        status: 'Killed',
        location: pendingLocation,
      },
    ],
  },
});

test('mutatorが判定を返さなかった壊し方をerrorsに入れ、一覧を書いて非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await installFakeMutator(f, reportingMutator);
    installed(f);
    const result = mutation(f, ['src/rules.ts']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.report).toEqual({
      survived: [],
      uncovered: [],
      timedOut: [],
      errors: [
        {
          key: 'pending-1',
          path: 'src/rules.ts',
          line: 10,
          rule: 'EqualityOperator',
          original: 'age >= 18',
          replacement: 'age > 18',
          reason: 'mutatorが判定を返しませんでした（Pending: not run）',
        },
      ],
    });
    expect(result.stderr).toContain('mutatorが判定を返さなかった壊し方が1件あります');
  });
}, 120000);

test('mutatorの報告に項目が1つも無ければ、空の一覧を書いて終了0で終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await installFakeMutator(f, fixedReportMutator({}));
    installed(f);
    const result = mutation(f, ['src/rules.ts']);
    expect(result.code, result.output).toBe(0);
    expect(result.report).toEqual({ survived: [], uncovered: [], timedOut: [], errors: [] });
    expect(result.stderr).toContain('mutatorはsrc/rules.tsから壊し方を作りませんでした');
  });
}, 120000);

test('mutatorの報告に渡したモジュールの項目が無く、別のパスの項目だけがあれば、報告の不一致を示して非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await installFakeMutator(
      f,
      fixedReportMutator({ './src/rules.ts': { source: '', mutants: [] } }),
    );
    installed(f);
    for (const args of [['src/rules.ts'], ['src/rules.ts', '--key', 'k1']]) {
      const result = mutation(f, args);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'mutatorの報告にsrc/rules.tsの項目が無く、別のパスの項目（./src/rules.ts）だけがあります。報告の形が合わないため止めます。@mizchi/mutatorの版を確かめてください',
      );
      expect(result.stderr).not.toContain('から壊し方を作りませんでした');
    }
  });
}, 120000);

function checkChanges(f: Fixture) {
  return run(f, [
    '--no-env-file',
    'scripts/feedback-loop/runtime.mjs',
    'mutation',
    '--check-changes',
  ]);
}

const changeFiles = { ...files, 'mutator.accepted.json': '{}\n' };
const outsideMessage = '改善の処理が変えてよいファイルの外の変更があります: ';

test('--check-changesは、比較元にあるテストと記録ファイルの変更と、追跡外と追加した新しいファイルだけなら、終了0で終わる', async () => {
  await fixture(changeFiles, async (f) => {
    installed(f);
    await writeFile(
      join(f.repo, 'test/a.test.ts'),
      `${header}test('a', () => expect(2).toBe(2));\n`,
    );
    await writeFile(join(f.repo, 'mutator.accepted.json'), '{\n  "abc": { "reason": "理由" }\n}\n');
    await mkdir(join(f.repo, 'test/fixtures'));
    await writeFile(join(f.repo, 'test/fixtures/helper.ts'), 'export const helper = 1;\n');
    await writeFile(join(f.repo, 'test/staged.json'), '{}\n');
    git(f.repo, 'add', 'test/staged.json');

    const result = checkChanges(f);
    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('改善の処理が変えてよいファイルの外の変更はありません');
  });
});

test('--check-changesは、比較元にあるテストでないファイルの変更、テストの削除、テストの改名を、パスを示して非ゼロで終わる', async () => {
  await fixture(changeFiles, async (f) => {
    installed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
    await unlink(join(f.repo, 'test/b.test.ts'));
    git(f.repo, 'mv', 'test/a.test.ts', 'test/renamed.test.ts');
    await writeFile(join(f.repo, 'test/helper.ts'), 'export const helper = 1;\n');

    const result = checkChanges(f);
    expect(result.code, result.output).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(outsideMessage);
    for (const reported of [
      'src/input.ts（テストのファイルとmutator.accepted.jsonの外の変更）',
      'test/a.test.ts（比較元にあるファイルの削除）',
      'test/b.test.ts（比較元にあるファイルの削除）',
    ]) {
      expect(result.stderr).toContain(reported);
    }
    for (const allowed of ['test/renamed.test.ts', 'test/helper.ts']) {
      expect(result.stderr).not.toContain(allowed);
    }
  });
});

test('package.jsonがGitのルートより下にあるrepoでも、--check-changesはパスをpackage.jsonのディレクトリから読み、ディレクトリの外の変更と新しいファイルを外の変更とする', async () => {
  const nested = Object.fromEntries(
    Object.entries({
      ...changeFiles,
      '.feedback-loop.json': JSON.stringify({ ...config, testGlobs: ['**/*.test.ts'] }),
    }).map(([path, body]) => [`workspace/${path}`, body]),
  );
  const sibling = `${header}test('x', () => expect(1).toBe(1));\n`;
  await fixture(
    { ...nested, 'other/file.txt': 'outside\n', 'other/x.test.ts': sibling },
    async (root) => {
      const f = { ...root, repo: join(root.repo, 'workspace') };
      installed(f);
      await writeFile(
        join(f.repo, 'test/a.test.ts'),
        `${header}test('a', () => expect(2).toBe(2));\n`,
      );
      await writeFile(join(root.repo, 'other/file.txt'), 'changed\n');
      await writeFile(join(root.repo, 'other/new.txt'), 'new\n');
      await writeFile(join(root.repo, 'other/x.test.ts'), `${sibling}// changed\n`);

      const result = checkChanges(f);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stderr).toContain(outsideMessage);
      for (const reported of [
        '../other/file.txt（package.jsonのディレクトリの外の変更）',
        '../other/x.test.ts（package.jsonのディレクトリの外の変更）',
        '../other/new.txt（package.jsonのディレクトリの外の変更）',
      ]) {
        expect(result.stderr).toContain(reported);
      }
      expect(result.stderr).not.toContain('test/a.test.ts');
    },
  );
});

test('--check-changesは、branchへcommitしたテストでないファイルの変更も、比較元との分岐点から数えて外の変更とする', async () => {
  await fixture(changeFiles, async (f) => {
    installed(f);
    git(f.repo, 'checkout', '-b', 'feedback-loop/improve-tests-1');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
    git(f.repo, 'commit', '-am', 'change');

    const result = checkChanges(f);
    expect(result.code, result.output).not.toBe(0);
    expect(result.stderr).toContain(
      `${outsideMessage}src/input.ts（テストのファイルとmutator.accepted.jsonの外の変更）`,
    );
  });
});

test('--check-changesは、.github/の下に足した新しいファイルを外の変更とする', async () => {
  await fixture(changeFiles, async (f) => {
    installed(f);
    await mkdir(join(f.repo, '.github/workflows'), { recursive: true });
    await writeFile(join(f.repo, '.github/workflows/x.yml'), 'on: push\n');

    const result = checkChanges(f);
    expect(result.code, result.output).not.toBe(0);
    expect(result.stderr).toContain(
      `${outsideMessage}.github/workflows/x.yml（.github/の下の変更）`,
    );
  });
});
