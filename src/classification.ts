import assert from 'node:assert/strict';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isTestFile } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import type { commandRunner } from './command.ts';
import { assertRepoRelativePath, assertStringArray } from './values.ts';

function filesUnder(root: string, prefix: string, excludeHidden: boolean): string[] {
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

// リンク先のないシンボリックリンクも、エントリがあるので実在として扱う。
function entryExists(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    // 途中が通常ファイルであるパスは、たどれないので実在しない。
    return false;
  }
}

// テストが数百件あるrepoでも食い違ったパスと向きを診断だけで読めるよう、両方にあるパスは出さない。
function mismatchDiagnostic(
  root: string,
  config: FeedbackConfig,
  collected: string[],
  globbed: string[],
) {
  const inCollected = new Set(collected);
  const inGlobbed = new Set(globbed);
  // testGlobsの側の集合は、探索で見つかる通常ファイルから作る。testGlobsに当たるパスでも、この集合に入らないものがある。
  const missing: string[] = [];
  const unmatched: string[] = [];
  const unlisted: string[] = [];
  for (const path of collected.filter((path) => !inGlobbed.has(path))) {
    if (!entryExists(join(root, path))) {
      missing.push(path);
    } else if (isTestFile(path, config)) {
      unlisted.push(path);
    } else {
      unmatched.push(path);
    }
  }
  const sides: [string, string[]][] = [
    ['収集にあって実在しない', missing],
    ['収集にあってtestGlobsに当たらない', unmatched],
    [
      '収集にあってtestGlobsに当たるが、探索で見つからない（シンボリックリンク、ディレクトリ、node_modules・.gitの下、表記の違いなど）',
      unlisted,
    ],
    ['testGlobsに当たって収集にない', globbed.filter((path) => !inCollected.has(path))],
  ];
  return [
    '通常収集とtestGlobsの集合が一致しません',
    ...sides
      .filter(([, paths]) => paths.length > 0)
      .map(([label, paths]) => `${label}: ${JSON.stringify(paths.sort())}`),
  ].join('\n');
}

export async function classification(
  root: string,
  config: FeedbackConfig,
  run: ReturnType<typeof commandRunner>,
) {
  const prefixes = config.testGlobs.map((glob) => {
    const fixed = glob.split(/[*?]/, 1)[0] ?? '';
    return fixed.slice(0, fixed.lastIndexOf('/') + 1);
  });
  const roots = [...new Set(prefixes)].filter(
    (prefix, _, all) => !all.some((parent) => parent !== prefix && prefix.startsWith(parent)),
  );
  const files = roots
    .filter(
      (prefix) =>
        !prefix
          .split('/')
          .some(
            (part) =>
              part === '.git' ||
              part === 'node_modules' ||
              (config.collect === undefined && part.startsWith('.')),
          ),
    )
    .filter((prefix) => {
      const found = statSync(join(root, prefix), { throwIfNoEntry: false })?.isDirectory() ?? false;
      // 内蔵の一覧は探索場所だけが根拠なので、欠けた場所を0件として通さない。collect指定では収集結果との差で検出する。
      assert(found || config.collect !== undefined, `testGlobsの探索場所がありません: ${prefix}`);
      return found;
    })
    .flatMap((prefix) => filesUnder(root, prefix, config.collect === undefined));
  const expected = files.filter((path) => isTestFile(path, config)).sort();
  let actual: string[];
  if (config.collect !== undefined) {
    const { stdout } = await run(config.collect, { cwd: root, captureStdout: true });
    const collected: unknown = JSON.parse(stdout);
    assertStringArray(collected);
    collected.forEach(assertRepoRelativePath);
    assert(new Set(collected).size === collected.length, '収集結果が重複しています');
    actual = collected;
  } else {
    actual = files
      .filter(
        (path) =>
          !path.split('/').some((part) => part.startsWith('.')) &&
          /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(path),
      )
      .sort();
  }
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected)) {
    assert.fail(mismatchDiagnostic(root, config, actual, expected));
  }
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
