import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  // 実行部が標準出力をため込める上限（64MiB）を超えて書くテスト。
  // Bunは、書き終わる前に終わったテストの標準出力を捨てるため、書き終わりを待ちながら1MiBずつ書く。
  'test/noisy.test.ts': `${header}test('noisy', async () => {
  for (let i = 0; i < 70; i++) {
    await new Promise((done) => process.stdout.write('x'.repeat(1024 * 1024), () => done(undefined)));
  }
  expect(1).toBe(1);
}, 30000);\n`,
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

test('テストが標準出力へ64MiBを超えて書いても、実行を止めずに結果を判定する', async () => {
  await fixture(files, async (f) => {
    const { verdict } = await runMutationTests(context(f), ['test/noisy.test.ts']);
    expect(verdict).toEqual({ kind: 'survived' });
  });
}, 30000);

test('報告の失敗の件数が欠けているか数字でないと、すり抜けではなくエラーと判定する', async () => {
  await fixture(files, async (f) => {
    const ctx = context(f);
    // 本物のBunが書いた報告の、最初のfailures（全体の件数）を書き換える。
    const corrupted = (to: string) => ({
      ...ctx,
      run: async (argv: string[], options: Parameters<typeof ctx.run>[1] = {}) => {
        const output = await ctx.run(argv, options);
        const report = argv[argv.indexOf('--reporter-outfile') + 1] ?? '';
        writeFileSync(report, readFileSync(report, 'utf8').replace(/ failures="0"/, to));
        return output;
      },
    });
    for (const to of ['', ' failures="x"']) {
      const { verdict } = await runMutationTests(corrupted(to), ['test/pass.test.ts']);
      expect(verdict).toEqual({
        kind: 'error',
        reason: 'テストの結果の報告を読めません: JUnitのfailuresが不正です',
      });
    }
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

test('上限より前に終わったコマンドは、標準出力を開いたままの孫のプロセスが残っていても、時間切れにしない', async () => {
  await fixture(files, async (f) => {
    // 孫は別のプロセスグループで4秒眠り、その間、受け取る側の標準出力を開いたままにする。
    const script =
      "require('node:child_process').spawn('sleep', ['4'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref()";
    const output = await context(f).run([process.execPath, '-e', script], {
      stdout: 'capture',
      timeoutMs: 2000,
    });
    expect(output.stdout).toBe('');
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
