import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { repoPath, type TestContext } from './config.ts';
import { selectQuality, type TestOutcome } from './selection.ts';
import { openRecords } from './records.ts';
import { readBunReport } from './bun-report.ts';
import { assertObject } from './values.ts';
import type * as Recorder from './record-modules.ts';

type BunTestState =
  | { status: 'running' | 'skipped' | 'excluded' }
  | { status: 'passed'; modules: Set<string> };

/** 実行全体が成功した場合。成功したテストの依存を記録し、skipされたテストの記録を外す。 */
function recordsAfterSuccess(states: Map<string, BunTestState>) {
  const ran = new Map<string, Set<string>>();
  const failed: string[] = [];
  for (const [file, state] of states) {
    if (state.status === 'passed') {
      ran.set(file, state.modules);
    } else if (state.status !== 'excluded') {
      failed.push(file);
    }
  }
  return { ran, failed };
}

/** 実行が途中で失敗した場合。先に成功したテストも含めて、実行に含めたテストの記録をすべて外す。 */
function recordsAfterFailure(states: Map<string, BunTestState>) {
  const failed = [...states]
    .filter(([, state]) => state.status !== 'excluded')
    .map(([file]) => file);
  return { ran: new Map<string, Set<string>>(), failed };
}

function recorderModule(value: unknown): asserts value is typeof Recorder {
  assertObject(value);
  assert(
    typeof value.recorderEnv === 'function' && typeof value.readRecords === 'function',
    '記録器を読み込めません',
  );
}

function hasNoChangedTests(
  comparison: string | undefined,
  report: string,
  recorded: Map<string, Set<string>>,
  stderr: string,
) {
  // 関連0件の終了0と、選択されたファイルの結果欠落を区別します。
  return (
    comparison !== undefined &&
    !existsSync(report) &&
    recorded.size === 0 &&
    /^--changed: (?:\d+ changed files?, but no test files are affected|no changed files, nothing to run)\r?$/m.test(
      stripVTControlCharacters(stderr),
    )
  );
}

async function runBunBatch(
  { root, config, run }: TestContext,
  batch: {
    files: string[];
    comparison: string | undefined;
    dir: string;
    recorderFile: string;
    recorder: typeof Recorder;
  },
) {
  const candidates = new Set(batch.files);
  const report = join(batch.dir, 'results.xml');
  const recordDir = join(batch.dir, 'records');
  await mkdir(recordDir, { recursive: true });
  const argv = [
    process.versions.bun ? process.execPath : 'bun',
    ...config.bunArgs,
    'test',
    ...batch.files.map((file) => `./${file}`),
    ...config.testArgs,
    '--no-orphans',
    // --parallelはテストファイルごとの分離を含むため、--isolateは渡しません。
    `--parallel=${config.bunWorkers}`,
    '--reporter=junit',
    '--reporter-outfile',
    report,
    ...(batch.comparison === undefined ? [] : [`--changed=${batch.comparison}`]),
  ];
  const { stderr } = await run(argv, {
    env: batch.recorder.recorderEnv(process.env, recordDir, batch.recorderFile),
  });
  const recorded = new Map(
    [...(await batch.recorder.readRecords(recordDir))].map(([owner, modules]) => [
      repoPath(root, owner),
      new Set([...modules].map((path) => repoPath(root, path))),
    ]),
  );
  const results = hasNoChangedTests(batch.comparison, report, recorded, stderr)
    ? new Map<string, number>()
    : readBunReport(await readFile(report, 'utf8'), root, candidates, config.allowSkipped);
  assert(
    recorded.size === results.size && [...recorded.keys()].every((file) => results.has(file)),
    '読み込んだテストとJUnitのファイル集合が一致しません',
  );
  assert(
    batch.comparison !== undefined || results.size === candidates.size,
    '指定したテストの結果が欠落しています',
  );
  return new Map(
    [...results].map(([owner, count]) => {
      const modules = recorded.get(owner);
      assert(modules, `完了したテストの依存記録がありません: ${owner}`);
      return [owner, { count, modules }];
    }),
  );
}

export async function runBunTests(ctx: TestContext): Promise<TestOutcome> {
  const { root, config, comparison, quality, changed } = ctx;
  const { records, save: saveRecords } = openRecords(root, changed, quality, ctx.ancestorLockfiles);
  const selected = await selectQuality(root, config, quality, changed, {
    fullRunReason: records.kind === 'unusable' ? records.reason : undefined,
    async reach(changes) {
      const inputsByTest = new Map(records.kind === 'usable' ? records.records : []);
      for (const { path, targets } of changes) {
        for (const test of targets) {
          // 明示対応を補い、同じ入力へ到達する実行記録も選択に残します。
          inputsByTest.set(test, new Set([...(inputsByTest.get(test) ?? []), path]));
        }
      }
      return {
        reached: new Map(
          changed.map((path) => [
            path,
            quality.filter((file) => inputsByTest.get(file)?.has(path)),
          ]),
        ),
        // 記録がないqualityは、変更入力を読むか分からないため常に選びます。
        always: quality.filter((file) => !inputsByTest.has(file)),
      };
    },
  });
  // 選ぶ先がなければ、Bunの--changedへ渡さずに終えます。
  if (selected.kind === 'exempt' || selected.kind === 'none') {
    return selected;
  }
  if (selected.kind === 'all') {
    console.log(`quality全件の理由: ${selected.reasons.join(', ')}`);
  }
  const dir = await mkdtemp(join(tmpdir(), 'feedback-loop-'));
  // npm/Vitestの実行にはBunを要求しません。記録器はBunの分岐でだけ読み込みます。
  const recorderFile = join(root, 'scripts/feedback-loop/record-modules.ts');
  const recorder: unknown = await import(pathToFileURL(recorderFile).href);
  recorderModule(recorder);
  const states = new Map<string, BunTestState>();
  let outcome: 'failed' | 'succeeded' = 'failed';
  try {
    const runBatch = async (files: string[], compared: boolean, index: number) => {
      for (const file of files) {
        states.set(file, { status: 'running' });
      }
      const results = await runBunBatch(ctx, {
        files: files,
        comparison: compared ? comparison : undefined,
        dir: join(dir, String(index)),
        recorderFile,
        recorder,
      });
      for (const file of files) {
        const result = results.get(file);
        states.set(
          file,
          result === undefined
            ? { status: 'excluded' }
            : result.count > 0
              ? { status: 'passed', modules: result.modules }
              : { status: 'skipped' },
        );
      }
    };
    await runBatch(quality, selected.kind === 'some', 0);
    if (selected.kind === 'some') {
      const remaining = selected.files.filter((file) => states.get(file)?.status === 'excluded');
      if (remaining.length > 0) {
        await runBatch(remaining, false, 1);
      }
    }
    const results = [...states.values()].filter(
      (state) => state.status === 'passed' || state.status === 'skipped',
    );
    console.log(`quality選択: ${results.length}件（Bunの実行結果と補完依存の和集合）`);
    assert(results.length > 0, '候補0件: 関連テストがありません');
    assert(
      results.some((state) => state.status === 'passed'),
      '未実行: 選択したテストがすべてskipされています',
    );
    outcome = 'succeeded';
  } finally {
    saveRecords(
      outcome === 'succeeded' ? recordsAfterSuccess(states) : recordsAfterFailure(states),
    );
    await rm(dir, { recursive: true, force: true });
  }
  return { kind: 'ran' };
}
