import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { repoPath, type TestContext } from './config.ts';
import { selectQuality } from './selection.ts';
import { mergeBase } from './git.ts';
import { loadRecords, saveRecords } from './records.ts';
import { readBunReport } from './bun-report.ts';
import { assertObject } from '../shared/values.ts';
import type * as Recorder from './record-modules.ts';

type BunTestState =
  | { status: 'running' | 'skipped' | 'excluded' }
  | { status: 'passed'; modules: Set<string> };

function bunRecordUpdates(states: Map<string, BunTestState>, succeeded: boolean) {
  const ran = new Map<string, Set<string>>();
  const failed: string[] = [];
  for (const [file, state] of states) {
    switch (state.status) {
      case 'excluded':
        break;
      case 'passed':
        if (succeeded) {
          ran.set(file, state.modules);
        } else {
          failed.push(file);
        }
        break;
      case 'running':
      case 'skipped':
        failed.push(file);
        break;
    }
  }
  return { ran, failed };
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
  const candidates = new Set(batch.files.map((file) => join(root, file)));
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
    '--isolate',
    `--parallel=${config.bunWorkers}`,
    '--reporter=junit',
    '--reporter-outfile',
    report,
    ...(batch.comparison === undefined ? [] : [`--changed=${batch.comparison}`]),
  ];
  const { stderr } = await run(argv, {
    env: batch.recorder.recorderEnv(process.env, recordDir, batch.recorderFile),
  });
  const recorded = await batch.recorder.readRecords(recordDir);
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

export async function runBunTests(ctx: TestContext) {
  const { root, config, base, quality, changed } = ctx;
  const testFiles = quality.map((path) => join(root, path));
  const { records, warning } = loadRecords(root, changed, testFiles);
  const selected = await selectQuality(root, config, quality, changed, {
    warning,
    missingRecords: records.size === 0,
    async reach(changes) {
      const inputsByTest = new Map(records);
      for (const { path, targets } of changes) {
        for (const test of targets) {
          const file = join(root, test);
          // 明示対応を補い、同じ入力へ到達する実行記録も選択に残します。
          inputsByTest.set(file, new Set([...(inputsByTest.get(file) ?? []), join(root, path)]));
        }
      }
      return {
        reached: new Map(
          changed.map((path) => [
            repoPath(root, path),
            testFiles
              .filter((file) => inputsByTest.get(file)?.has(path))
              .map((file) => repoPath(root, file)),
          ]),
        ),
        // 記録がないqualityは、変更入力を読むか分からないため常に選びます。
        unrecorded: testFiles
          .filter((file) => !inputsByTest.has(file))
          .map((file) => repoPath(root, file)),
      };
    },
  });
  if (selected.all) {
    console.log(`quality全件の理由: ${selected.reasons.join(', ')}`);
  }
  const comparison = mergeBase(root, base);
  const dir = await mkdtemp(join(tmpdir(), 'feedback-loop-'));
  // npm/Vitestの実行にはBunを要求しません。記録器はBunの分岐でだけ読み込みます。
  const recorderFile = join(root, 'scripts/feedback-loop/record-modules.ts');
  const recorder: unknown = await import(pathToFileURL(recorderFile).href);
  recorderModule(recorder);
  const states = new Map<string, BunTestState>();
  let succeeded = false;
  try {
    const runBatch = async (files: string[], changed: boolean, index: number) => {
      for (const file of files) {
        states.set(join(root, file), { status: 'running' });
      }
      const results = await runBunBatch(ctx, {
        files: files,
        comparison: changed ? comparison : undefined,
        dir: join(dir, String(index)),
        recorderFile,
        recorder,
      });
      for (const file of files) {
        const owner = join(root, file);
        const result = results.get(owner);
        states.set(
          owner,
          result === undefined
            ? { status: 'excluded' }
            : result.count > 0
              ? { status: 'passed', modules: result.modules }
              : { status: 'skipped' },
        );
      }
    };
    await runBatch(quality, !selected.all, 0);
    if (!selected.all) {
      const remaining = selected.files.filter(
        (file) => states.get(join(root, file))?.status === 'excluded',
      );
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
    succeeded = true;
  } finally {
    saveRecords({ root, ...bunRecordUpdates(states, succeeded) });
    await rm(dir, { recursive: true, force: true });
  }
}
