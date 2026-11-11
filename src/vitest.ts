import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertObject } from './values.ts';
import { repoPath } from './config.ts';
import { selectQuality, type TestOutcome } from './selection.ts';
import type { TestContext } from './config.ts';

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
  { root, config, quality, changed, outside }: TestContext,
  apiPath: string,
  exclude: string[],
) {
  return selectQuality(root, config, quality, changed, {
    async reach(changes, fullRunKnown) {
      if (fullRunKnown) {
        return undefined;
      }
      const reached = new Map<string, string[]>();
      const always: string[] = [];
      const inside = changes.map(({ path }) => path).filter((path) => !quality.includes(path));
      const pending = [...inside, ...outside];
      if (pending.length === 0) {
        return { reached, always };
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
      // VitestのCLIは--excludeをcliExcludeへ移し、設定ファイルのexcludeへ足します（vitest 5.1.0のnormalizeCliOptions）。
      // parseCLIの結果はexcludeのままで、そのまま渡すと設定ファイルのexcludeを置き換えます。
      const { exclude: cliExclude, ...options } = parsed.options;
      const context = await api.createVitest('test', { ...options, cliExclude, watch: false });
      try {
        const targetsOf = async (...paths: string[]) => {
          context.config.related = paths.map((path) => join(root, path));
          const specs = await context.getRelevantTestSpecifications();
          const files = specs.map((spec) => repoPath(root, spec.moduleId));
          const targets = files.filter((file) => quality.includes(file));
          // assuranceは除外済みなので、残りはcollectとVitestの収集のずれである。黙って捨てると未実行を成功にしてしまう。
          assert(
            targets.length === files.length,
            `Vitestの到達先がquality集合と一致しません: ${files.filter((file) => !quality.includes(file)).join(', ')}`,
          );
          return targets;
        };
        for (const path of inside) {
          reached.set(path, await targetsOf(path));
        }
        // 外の変更は届くテストだけを選び、どこにも届かなくても全件へ広げません。他のpackageの変更が大半のためです。
        // 変更ごとの届く先は使わないので、まとめて1回で照会します。
        if (outside.length > 0) {
          always.push(...(await targetsOf(...outside)));
        }
      } finally {
        await context.close();
      }
      return { reached, always };
    },
  });
}

export async function runVitestTests(ctx: TestContext): Promise<TestOutcome> {
  const { root, config, quality, run } = ctx;
  const require = createRequire(join(root, 'package.json'));
  const packagePath = require.resolve('vitest/package.json');
  const installed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
  assertObject(installed);
  assertObject(installed.bin);
  assert(typeof installed.bin.vitest === 'string', 'Vitestの公開CLIがありません');
  const cli = join(dirname(packagePath), installed.bin.vitest);
  const exclude = config.assurance.flatMap((entry) => ['--exclude', join(root, entry.path)]);
  // 到達先の照会でVitestがprocess.envへNODE_ENV=developmentなどを書き込むため、照会の前の環境を実行へ渡します。
  const env = { ...process.env };
  const selected = await selectVitest(ctx, require.resolve('vitest/node'), exclude);
  if (selected.kind === 'exempt' || selected.kind === 'none') {
    return selected;
  }
  const selection =
    selected.kind === 'all' ? ['run', ...quality] : ['related', ...selected.files, '--run'];
  if (selected.kind === 'all') {
    console.log(
      `quality全件の理由: 設定変更、削除、または依存先不明: ${selected.reasons.join(', ')}`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), 'feedback-vitest-'));
  try {
    const report = join(dir, 'results.json');
    await run(
      [
        process.execPath,
        cli,
        ...selection,
        ...config.testArgs,
        ...exclude,
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { env },
    );
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
  return { kind: 'ran' };
}
