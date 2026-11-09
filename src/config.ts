import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertObject } from './values.ts';
import type { commandRunner } from './command.ts';

export type FeedbackConfig = {
  runner: 'bun' | 'vitest';
  base: string | undefined;
  collect: string[] | undefined;
  testGlobs: string[];
  assurance: { path: string; reason: string }[];
  prepare: string[];
  bunArgs: string[];
  bunWorkers: number;
  testArgs: string[];
  allowSkipped: boolean;
  globalChanges: string[];
  dependencies: { inputs: string[]; tests: string[] }[];
};

export type TestContext = {
  root: string;
  config: FeedbackConfig;
  base: string;
  quality: string[];
  changed: string[];
  run: ReturnType<typeof commandRunner>;
};

// 生成したruntime.mjsで、導入時にpackage managerへ置き換える文字列です。
export const packageManagerToken = '__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__';

function assertStringArray(value: unknown): asserts value is string[] {
  assert(
    Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && item.trim().length > 0),
    '文字列配列が必要です',
  );
}

function assertRepoRelativePath(path: string) {
  assert(
    !isAbsolute(path) &&
      !path.split('/').includes('..') &&
      !path.startsWith('./') &&
      !path.includes('\\'),
    `repo相対パスが必要です: ${path}`,
  );
}

const configKeys = new Set([
  'runner',
  'base',
  'collect',
  'testGlobs',
  'assurance',
  'prepare',
  'bunArgs',
  'bunWorkers',
  'testArgs',
  'allowSkipped',
  'globalChanges',
  'dependencies',
]);

export function readConfig(root: string): FeedbackConfig {
  const value: unknown = JSON.parse(readFileSync(join(root, '.feedback-loop.json'), 'utf8'));
  assertObject(value);
  const unknownKeys = Object.keys(value).filter((key) => !configKeys.has(key));
  assert(
    unknownKeys.length === 0,
    `.feedback-loop.jsonの未知のキーです: ${unknownKeys.join(', ')}`,
  );
  assert(value.runner === 'bun' || value.runner === 'vitest', 'runnerはbunまたはvitestです');
  if (value.base !== undefined) {
    assert(typeof value.base === 'string' && value.base.trim().length > 0, '比較元baseが必要です');
  }
  const {
    collect,
    testGlobs,
    prepare = [],
    testArgs = [],
    globalChanges = [],
    bunArgs = [],
    bunWorkers = 4,
    allowSkipped = true,
    assurance: assuranceValue = [],
    dependencies: dependenciesValue = [],
  } = value;
  if (collect !== undefined || value.runner === 'vitest') {
    assertStringArray(collect);
    assert(collect.length > 0, '収集コマンドは空にできません');
  }
  assertStringArray(testGlobs);
  assertStringArray(prepare);
  assertStringArray(testArgs);
  assertStringArray(globalChanges);
  assert(testGlobs.length > 0, 'テストglobは必須です');
  assert(typeof allowSkipped === 'boolean', 'allowSkippedはbooleanです');
  assertStringArray(bunArgs);
  assert(value.runner === 'bun' || bunArgs.length === 0, 'VitestにはbunArgsを指定できません');
  assert(
    typeof bunWorkers === 'number' && Number.isSafeInteger(bunWorkers) && bunWorkers > 0,
    'bunWorkersは正の安全な整数で指定してください',
  );
  assert(
    value.runner === 'bun' || value.bunWorkers === undefined,
    'VitestにはbunWorkersを指定できません',
  );
  if (value.runner === 'bun') {
    assert(
      ![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)),
      'Bunの隔離は固定です。並列数はbunWorkersで指定してください',
    );
  }
  assert(Array.isArray(assuranceValue), 'assurance配列が必要です');
  const assurance = assuranceValue.map((item: unknown) => {
    assertObject(item);
    assert(
      typeof item.path === 'string' &&
        typeof item.reason === 'string' &&
        item.reason.trim().length > 0,
      'assuranceにはpathと指定理由が必要です',
    );
    assertRepoRelativePath(item.path);
    return { path: item.path, reason: item.reason };
  });
  assert(Array.isArray(dependenciesValue), 'dependencies配列が必要です');
  const dependencies = dependenciesValue.map((item: unknown) => {
    assertObject(item);
    assertStringArray(item.inputs);
    assertStringArray(item.tests);
    assert(item.inputs.length > 0 && item.tests.length > 0, '依存対応は空にできません');
    item.inputs.forEach(assertRepoRelativePath);
    item.tests.forEach(assertRepoRelativePath);
    return { inputs: item.inputs, tests: item.tests };
  });
  testGlobs.forEach(assertRepoRelativePath);
  globalChanges.forEach(assertRepoRelativePath);
  return {
    runner: value.runner,
    base: value.base,
    collect,
    testGlobs,
    assurance,
    prepare,
    bunArgs,
    bunWorkers,
    testArgs,
    allowSkipped,
    globalChanges,
    dependencies,
  };
}

// *は同階層、**は階層をまたぐglobです。正規表現の記号はリテラルとして扱います。
function matches(path: string, glob: string): boolean {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (glob.slice(i, i + 3) === '**/') {
      pattern += '(?:.*/)?';
      i += 2;
    } else if (glob.slice(i, i + 2) === '**') {
      pattern += '.*';
      i++;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`).test(path);
}

const fullRunGlobs = [
  'package.json',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  '.feedback-loop.json',
  'scripts/feedback-loop/**',
];

// 記録や依存グラフに現れるかによらず、全qualityを実行する入力か判定します。
export function requiresFullRun(path: string, config: FeedbackConfig): boolean {
  return [...fullRunGlobs, ...config.globalChanges].some((glob) => matches(path, glob));
}

export function mappedTests(path: string, config: FeedbackConfig): string[] {
  return config.dependencies
    .filter((entry) => entry.inputs.some((glob) => matches(path, glob)))
    .flatMap((entry) => entry.tests);
}

export function repoPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
  const local = relative(root, canonical);
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
    ? local.split(sep).join('/')
    : absolute;
}

function filesUnder(root: string, prefix = '', excludeHidden = false): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (
      entry.name === '.git' ||
      entry.name === 'node_modules' ||
      (excludeHidden && entry.isDirectory() && entry.name.startsWith('.'))
    ) {
      return [];
    }
    return entry.isDirectory()
      ? filesUnder(root, `${path}/`, excludeHidden)
      : entry.isFile()
        ? [path]
        : [];
  });
}

export async function classification(
  root: string,
  config: FeedbackConfig,
  run: ReturnType<typeof commandRunner>,
) {
  const expected = filesUnder(root, '', config.collect === undefined)
    .filter((path) => config.testGlobs.some((glob) => matches(path, glob)))
    .sort();
  let actual: string[];
  if (config.collect !== undefined) {
    const { stdout } = await run(config.collect, { cwd: root, captureStdout: true });
    const collected: unknown = JSON.parse(stdout);
    assertStringArray(collected);
    collected.forEach(assertRepoRelativePath);
    assert(new Set(collected).size === collected.length, '収集結果が重複しています');
    actual = collected;
  } else {
    const prefixes = config.testGlobs.map((glob) => {
      const fixed = glob.split(/[*?]/, 1)[0] ?? '';
      return fixed.slice(0, fixed.lastIndexOf('/') + 1);
    });
    const roots = [...new Set(prefixes)].filter(
      (prefix, _, all) => !all.some((parent) => parent !== prefix && prefix.startsWith(parent)),
    );
    actual = roots
      .flatMap((prefix) => filesUnder(root, prefix, true))
      .filter(
        (path) =>
          !path.split('/').some((part) => part === 'node_modules' || part.startsWith('.')) &&
          /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(path),
      )
      .sort();
  }
  assert(
    JSON.stringify([...actual].sort()) === JSON.stringify(expected),
    `通常収集とtestGlobsの集合が一致しません\ncollect=${JSON.stringify(actual)}\nglob=${JSON.stringify(expected)}`,
  );
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert(assurance.size === config.assurance.length, 'assurance指定が重複しています');
  assert(
    [...assurance].every((path) => expected.includes(path)),
    'assuranceに存在しないテストか集合外の指定があります',
  );
  assert(
    config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))),
    '依存対応に集合外のテストがあります',
  );
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance],
  };
}
