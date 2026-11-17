import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commandRunner } from '../src/command.ts';
import type { FeedbackConfig } from '../src/config.ts';
import { runMutationTests } from '../src/mutation-run.ts';
import { alive, waitFor } from './support/feedback-loop-cancellation.ts';
import { baseEnv, fixture, header } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

const config: FeedbackConfig = {
  runner: 'bun',
  base: undefined,
  collect: undefined,
  testGlobs: ['test/*.test.ts'],
  assurance: [],
  prepare: [],
  bunArgs: ['--no-env-file'],
  bunWorkers: 2,
  testArgs: ['--timeout', '30000'],
  allowSkipped: true,
  globalChanges: [],
  ignoredChanges: [],
  dependencies: [],
};

// 監視プロセスは、正本のruntimeをBunで直接起動する。
const runtime = resolve(import.meta.dir, '../src/runtime.ts');

function context(f: Fixture, env: NodeJS.ProcessEnv = {}) {
  const run = commandRunner(runtime, 'mutation-run.test.ts');
  return {
    root: f.repo,
    config,
    run: (argv: string[], options: Parameters<typeof run>[1] = {}) =>
      run(argv, { ...options, env: { ...baseEnv(f), ...env } }),
  };
}

const files = {
  'test/pass.test.ts': `${header}test('pass', () => expect(1).toBe(1));\n`,
  'test/mismatch.test.ts': `${header}test('mismatch', () => expect(1).toBe(2));\n`,
  'test/load.test.ts': `${header}throw new Error('読み込みの失敗');\n`,
  'test/empty.test.ts': 'export {};\n',
  'test/skipped.test.ts': `${header}test.skip('skipped', () => expect(1).toBe(2));\n`,
  'test/hang.test.ts': `${header}import { writeFileSync } from 'node:fs';
test('hang', async () => {
  writeFileSync(process.env.HANG_PID ?? '', String(process.pid));
  await new Promise(() => {});
}, 30000);\n`,
};

test('渡したテストが期待値の不一致で落ちると拾ったと判定し、すべて通るとすり抜けたと判定する', async () => {
  await fixture(files, async (f) => {
    const ctx = context(f);
    expect(
      (await runMutationTests(ctx, ['test/pass.test.ts', 'test/mismatch.test.ts'])).verdict,
    ).toEqual({
      kind: 'killed',
    });
    expect((await runMutationTests(ctx, ['test/pass.test.ts'])).verdict).toEqual({
      kind: 'survived',
    });
  });
}, 30000);

test('読み込みが失敗するテストと1件も実行されないテストは、拾ったではなくエラーと判定する', async () => {
  await fixture(files, async (f) => {
    const ctx = context(f);
    // 読み込みの失敗は、ほかのテストの失敗と同時でも、拾ったに数えない。
    const load = await runMutationTests(ctx, ['test/mismatch.test.ts', 'test/load.test.ts']);
    expect(load.verdict.kind).toBe('error');
    expect(load.verdict.kind === 'error' ? load.verdict.reason : '').toContain('test/load.test.ts');
    // テストを持たないファイルについて、Bunは報告を書かない。
    const empty = await runMutationTests(ctx, ['test/empty.test.ts']);
    expect(empty.verdict).toEqual({ kind: 'error', reason: 'テストの結果の報告がありません' });
    // 全件がskipのファイルについて、Bunは報告を書くが、実行したテストは0件である。
    const skipped = await runMutationTests(ctx, ['test/skipped.test.ts']);
    expect(skipped.verdict).toEqual({ kind: 'error', reason: '実行したテストが0件です' });
  });
}, 30000);

test('渡したテストが上限の時間を過ぎても終わらないと、プロセスを止めて時間切れと判定する', async () => {
  await fixture(files, async (f) => {
    const pidFile = join(f.signals, 'hang.pid');
    const result = await runMutationTests(
      context(f, { HANG_PID: pidFile }),
      ['test/hang.test.ts'],
      1000,
    );
    expect(result.verdict).toEqual({ kind: 'timedOut' });
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitFor(
      () => !alive(pid),
      () => `時間切れの後もテストのプロセスが残っています: ${pid}`,
      2000,
    );
  });
}, 30000);
