import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertObject } from './values.ts';
import { repoPath } from './config.ts';
import { selectQuality } from './selection.ts';
import type { FeedbackConfig, TestContext } from './config.ts';

type VitestAPI = {
  parseCLI: (args: string[]) => { options: Record<string, unknown> };
  createVitest: (
    mode: 'test',
    options: Record<string, unknown>,
  ) => Promise<{
    config: { related?: string[] };
    getRelevantTestSpecifications: () => Promise<{ moduleId: string }[]>;
    close: () => Promise<void>;
  }>;
};

function vitestAPI(value: unknown): asserts value is VitestAPI {
  assertObject(value);
  assert(
    typeof value.parseCLI === 'function' && typeof value.createVitest === 'function',
    '導入版Vitestの公開収集APIを利用できません',
  );
}

async function selectVitest(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
  apiPath: string,
  exclude: string[],
) {
  return selectQuality(root, config, quality, changed, {
    async reach(changes, fullRunKnown) {
      if (fullRunKnown) {
        return undefined;
      }
      const reached = new Map<string, string[]>();
      const pending = changes.map(({ path }) => path).filter((path) => !quality.includes(path));
      if (pending.length === 0) {
        return { reached, unrecorded: [] };
      }
      const api: unknown = await import(pathToFileURL(apiPath).href);
      vitestAPI(api);
      const parsed = api.parseCLI([
        'vitest',
        'related',
        ...pending,
        ...config.testArgs,
        ...exclude,
        '--run',
      ]);
      const context = await api.createVitest('test', { ...parsed.options, watch: false });
      try {
        for (const path of pending) {
          context.config.related = [join(root, path)];
          const specs = await context.getRelevantTestSpecifications();
          const files = specs.map((spec) => repoPath(root, spec.moduleId));
          const targets = files.filter((file) => quality.includes(file));
          // assuranceは除外済みなので、残りはcollectとVitestの収集のずれである。黙って捨てると未実行を成功にしてしまう。
          assert(
            targets.length === files.length,
            `Vitestの到達先がquality集合と一致しません: ${files.filter((file) => !quality.includes(file)).join(', ')}`,
          );
          reached.set(path, targets);
        }
      } finally {
        await context.close();
      }
      return { reached, unrecorded: [] };
    },
  });
}

export async function runVitestTests({ root, config, quality, changed, run }: TestContext) {
  const require = createRequire(join(root, 'package.json'));
  const packagePath = require.resolve('vitest/package.json');
  const installed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
  assertObject(installed);
  assertObject(installed.bin);
  assert(typeof installed.bin.vitest === 'string', 'Vitestの公開CLIがありません');
  const cli = join(dirname(packagePath), installed.bin.vitest);
  const exclude = config.assurance.flatMap((entry) => ['--exclude', join(root, entry.path)]);
  const selected = await selectVitest(
    root,
    config,
    quality,
    changed,
    require.resolve('vitest/node'),
    exclude,
  );
  assert(selected.files.length > 0, '候補0件: Vitestの関連qualityがありません');
  const selection = selected.all ? ['run', ...quality] : ['related', ...selected.files, '--run'];
  if (selected.all) {
    console.log(
      `quality全件の理由: 設定変更、削除、または依存先不明: ${selected.reasons.join(', ')}`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), 'feedback-vitest-'));
  try {
    const report = join(dir, 'results.json');
    await run([
      process.execPath,
      cli,
      ...selection,
      ...config.testArgs,
      ...exclude,
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${report}`,
    ]);
    const result: unknown = JSON.parse(await readFile(report, 'utf8'));
    assertObject(result);
    assert(
      result.success === true &&
        typeof result.numTotalTests === 'number' &&
        result.numTotalTests > 0,
      'Vitestが完了していません。候補0件または結果欠落',
    );
    assert(Array.isArray(result.testResults), 'Vitestのファイル結果がありません');
    assert(
      typeof result.numPassedTests === 'number' && result.numPassedTests > 0,
      '未実行: Vitestで成功したテストがありません',
    );
    if (!config.allowSkipped) {
      assert(
        result.numPassedTests === result.numTotalTests,
        '未実行: Vitestにskipまたはtodoがあります',
      );
    }
    const executed = result.testResults.map((item: unknown) => {
      assertObject(item);
      assert(typeof item.name === 'string', 'Vitest結果のファイル名が不正です');
      return repoPath(root, item.name);
    });
    assert(
      executed.length > 0 && executed.every((file) => quality.includes(file)),
      'Vitestの実行結果がquality集合と一致しません',
    );
    const completed = new Set(executed);
    assert(
      selected.files.every((file) => completed.has(file)),
      'Vitestの選択したテストの結果が欠落しています',
    );
    console.log(`quality選択: ${completed.size}件（Vitestの実行結果）`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
