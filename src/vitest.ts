import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertObject } from './values.ts';
import { isAssurance, repoPath } from './config.ts';
import { runtimePath } from './installed.ts';
import { selectQuality, type TestContext, type TestOutcome } from './selection.ts';

type VitestAPI = {
  parseCLI: (args: string[]) => { options: Record<string, unknown> };
  createVitest: (
    mode: 'test',
    options: Record<string, unknown>,
  ) => Promise<{
    config: { related?: string[]; experimental?: { recordDependencies?: unknown } };
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

type VitestContext = Awaited<ReturnType<VitestAPI['createVitest']>>;

// 変更ごとの届くテストを、importのつながりと依存記録で照会します。
async function reachByVitest(
  context: VitestContext,
  { root, config, quality, changes: { outside } }: TestContext,
  inside: string[],
) {
  const reached = new Map<string, string[]>();
  const always: string[] = [];
  const reachesAssurance = new Set<string>();
  // experimental.recordDependenciesが有効だと、Vitestは手元の依存記録だけで到達先を決めます（vitest 5.1.0のRecordedModulesResolver）。
  // 記録はテストを実行した時点のimportで、取り込んだ変更でimportが増えても古いままです。
  // importのつながりは、実行時に組み立てたパスのimportを追えません。両方で照会し、どちらかで届くテストを届く先にします。
  // sinceLastRunは設定の解決でこの値を有効へ戻すため、作成時の指定ではなく解決後の値を切り替えます。
  const experimental = context.config.experimental;
  const records = Boolean(experimental?.recordDependencies);
  // assuranceにしか届かない変更を見分けるため、照会ではassuranceを除外しません。実行では除外します。
  const query = async (paths: string[], recorded: boolean) => {
    if (experimental !== undefined && records) {
      experimental.recordDependencies = recorded;
    }
    context.config.related = paths.map((path) => join(root, path));
    const specs = await context.getRelevantTestSpecifications();
    const files = specs.map((spec) => repoPath(root, spec.moduleId));
    // qualityでもassuranceでもない到達先は、collectとVitestの収集のずれである。黙って捨てると未実行を成功にしてしまう。
    const unknown = files.filter((file) => !quality.includes(file) && !isAssurance(file, config));
    assert(
      unknown.length === 0,
      `Vitestの到達先がquality集合と一致しません: ${unknown.join(', ')}`,
    );
    return files;
  };
  // 実在し、テストがimportしないruntime自身の照会に現れるテストは、変更が届いた根拠にしません。
  // テストがruntimeをimportしていれば、選ぶテストが増える側に倒れます。
  // 依存記録の照会は、記録のないテストをどの変更にも届くテストとして返します。
  // 記録のないqualityは、変更に届いた先とせず、変更によらず選びます。届く先のない変更を全件へ広げる判定を残すためです。
  const unrecorded = new Set(records ? await query([runtimePath], true) : []);
  always.push(...quality.filter((file) => unrecorded.has(file)));
  const reachOf = async (...paths: string[]) => {
    const graph = await query(paths, false);
    const recorded = records
      ? (await query(paths, true)).filter((file) => !unrecorded.has(file))
      : [];
    return {
      targets: quality.filter((file) => graph.includes(file) || recorded.includes(file)),
      assurance: {
        graph: graph.filter((file) => isAssurance(file, config)),
        recorded: recorded.filter((file) => isAssurance(file, config)),
      },
    };
  };
  // qualityに届かない変更ごとの、届いたassurance。
  const assuranceOnly = new Map<string, { graph: string[]; recorded: string[] }>();
  for (const path of inside) {
    // queryは照会のたびに、共有するcontext.configのrelatedとrecordDependenciesを書き換えます。並行に照会すると、別の変更の指定で照会します。
    // oxlint-disable-next-line no-await-in-loop
    const reach = await reachOf(path);
    reached.set(path, reach.targets);
    // assuranceのテストファイル自身は、selection.tsが届く先によらず扱うため、照会を増やしません。
    if (
      reach.targets.length === 0 &&
      reach.assurance.graph.length + reach.assurance.recorded.length > 0 &&
      !isAssurance(path, config)
    ) {
      assuranceOnly.set(path, reach.assurance);
    }
  }
  if (assuranceOnly.size > 0) {
    // Vitest 5.1.0は、importのつながりの照会で、読み込みに失敗するテストをどの変更にも届くテストとして返します。4.1.11は返しません。
    const unloadable = new Set(await query([runtimePath], false));
    for (const [path, tests] of assuranceOnly) {
      if (tests.recorded.length > 0 || tests.graph.some((test) => !unloadable.has(test))) {
        reachesAssurance.add(path);
      }
    }
  }
  // 外の変更は届くテストだけを選び、どこにも届かなくても全件へ広げません。他のpackageの変更が大半のためです。
  // 変更ごとの届く先は使わないので、まとめて照会します。
  if (outside.length > 0) {
    always.push(...(await reachOf(...outside)).targets);
  }
  return { reached, always, reachesAssurance };
}

async function selectVitest(ctx: TestContext, apiPath: string) {
  const { config, quality } = ctx;
  return selectQuality(ctx, {
    async reach(changes, fullRunKnown) {
      if (fullRunKnown) {
        return undefined;
      }
      const inside = changes.map(({ path }) => path).filter((path) => !quality.includes(path));
      const pending = [...inside, ...ctx.changes.outside];
      if (pending.length === 0) {
        return { reached: new Map<string, string[]>(), always: [], reachesAssurance: new Set() };
      }
      const api: unknown = await import(pathToFileURL(apiPath).href);
      vitestAPI(api);
      const parsed = api.parseCLI(['vitest', 'related', ...pending, ...config.testArgs, '--run']);
      // VitestのCLIは--excludeをcliExcludeへ移し、設定ファイルのexcludeへ足します（vitest 5.1.0のnormalizeCliOptions）。
      // parseCLIの結果はexcludeのままで、そのまま渡すと設定ファイルのexcludeを置き換えます。
      const { exclude: parsedExclude, ...options } = parsed.options;
      const context = await api.createVitest('test', {
        ...options,
        ...(parsedExclude === undefined ? {} : { cliExclude: [parsedExclude].flat() }),
        watch: false,
      });
      try {
        return await reachByVitest(context, ctx, inside);
      } finally {
        await context.close();
      }
    },
  });
}

/**
 * assuranceのファイル1つだけに当たる、--excludeのパターン。Vitestは--excludeをglobとして読みます。
 * Vitestが使うtinyglobby 0.2.17は、絶対パスのパターンの先頭を、記号を打ち消したcwdと突き合わせて外します。
 * rootの打ち消しがtinyglobbyのescapePath（POSIX）とずれると一致しないため、rootには同じ置換を使います。
 * 残りの相対パスは、記号とバックスラッシュをすべて打ち消して、文字どおりに当てます。
 */
function excludePattern(root: string, path: string): string {
  const escapedRoot = root.replace(/(?<!\\)([()[\]{}*?|]|^!|[!+@](?=\())/g, '\\$&');
  return `${escapedRoot}/${path.replace(/[\\()[\]{}!*+?@|]/g, '\\$&')}`;
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
  const exclude = config.assurance.flatMap((entry) => [
    '--exclude',
    excludePattern(root, entry.path),
  ]);
  // 到達先の照会でVitestがprocess.envへNODE_ENV=developmentなどを書き込むため、照会の前の環境を実行へ渡します。
  const env = { ...process.env };
  const selected = await selectVitest(ctx, require.resolve('vitest/node'));
  // テストが失敗しても表示が残るよう、実行の前に出します。
  if (selected.kind !== 'none' && selected.assuranceReach.length > 0) {
    console.log(
      `assuranceのテストにしか届かない変更は、このコマンドでは確かめません。全体checkとCIで実行します: ${selected.assuranceReach.join(', ')}`,
    );
  }
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
