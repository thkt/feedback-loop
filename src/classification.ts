import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertRepoRelativePath, assertStringArray, matches } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import type { commandRunner } from './command.ts';

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
  const expected = files
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
    actual = files
      .filter(
        (path) =>
          !path.split('/').some((part) => part.startsWith('.')) &&
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
