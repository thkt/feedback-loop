import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertObject, assertRepoRelativePath, assertStringArray } from './values.ts';
import type { commandRunner } from './command.ts';
import { lockfileNames } from './lockfiles.ts';

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
  ignoredChanges: string[];
  dependencies: { inputs: string[]; tests: string[] }[];
};

export type TestContext = {
  root: string;
  config: FeedbackConfig;
  comparison: string;
  quality: string[];
  changed: string[];
  // rootの外にある変更。Vitestだけが、importでつながるテストの選択に使う。
  outside: string[];
  // rootにlockfileがない構成で使う、祖先のlockfile。実在するものだけで、rootからの相対パスである。
  ancestorLockfiles: string[];
  run: ReturnType<typeof commandRunner>;
};

// FeedbackConfigのキーと過不足があれば型検査で失敗します。
const configKeys = {
  runner: true,
  base: true,
  collect: true,
  testGlobs: true,
  assurance: true,
  prepare: true,
  bunArgs: true,
  bunWorkers: true,
  testArgs: true,
  allowSkipped: true,
  globalChanges: true,
  ignoredChanges: true,
  dependencies: true,
} satisfies Record<keyof FeedbackConfig, true>;

export function readConfig(root: string): FeedbackConfig {
  const value: unknown = JSON.parse(readFileSync(join(root, '.feedback-loop.json'), 'utf8'));
  assertObject(value);
  const unknownKeys = Object.keys(value).filter((key) => !Object.hasOwn(configKeys, key));
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
    ignoredChanges = [],
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
  assertStringArray(ignoredChanges);
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
      'テストファイルごとの分離は固定です。並列数はbunWorkersで指定してください',
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
  ignoredChanges.forEach(assertRepoRelativePath);
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
    ignoredChanges,
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
  ...lockfileNames,
  'tsconfig.json',
  '.feedback-loop.json',
  'scripts/feedback-loop/**',
];

// 通常checkが収集するテストファイルか判定します。
export function isTestFile(path: string, config: FeedbackConfig): boolean {
  return config.testGlobs.some((glob) => matches(path, glob));
}

// 記録や依存グラフに現れるかによらず、全qualityを実行する入力か判定します。
export function requiresFullRun(path: string, config: FeedbackConfig): boolean {
  return [...fullRunGlobs, ...config.globalChanges].some((glob) => matches(path, glob));
}

// テストに影響しないと設定で宣言した入力か判定します。
export function ignoresChange(path: string, config: FeedbackConfig): boolean {
  return config.ignoredChanges.some((glob) => matches(path, glob));
}

export function isAssurance(path: string, config: FeedbackConfig): boolean {
  return config.assurance.some((entry) => entry.path === path);
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
