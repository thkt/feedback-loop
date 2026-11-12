import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, commitFixture, fixture, header, recordFile } from './runner-affected.ts';
import type { Fixture } from './runner-affected.ts';
import { skillSetup } from './feedback-loop-skill.ts';

export { baseEnv, fixture, header, recordFile };
export type { Fixture };
export const setup = await skillSetup();
// 導入がこのconfigから生成するcheck:affectedのうち、bunへ渡す引数。
export const affectedArgs = ['--no-env-file', 'scripts/feedback-loop/runtime.mjs', 'affected'];

export const config = {
  runner: 'bun',
  base: 'main',
  collect: [process.execPath, 'scripts/collect.ts'],
  testGlobs: ['test/*.test.ts'],
  assurance: [],
  prepare: [],
  bunArgs: ['--no-env-file'],
  testArgs: ['--timeout', '3000'],
  globalChanges: ['scripts/**'],
  dependencies: [],
};
export const files = {
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'bun@1.4.4',
    scripts: { check: 'bun test ./test' },
  }),
  '.feedback-loop.json': JSON.stringify(config),
  'scripts/collect.ts':
    "import { readdirSync } from 'node:fs'; console.log(JSON.stringify(readdirSync('test').filter(p => p.endsWith('.test.ts')).map(p => 'test/' + p)));\n",
  'src/input.ts': 'export const value = 1;\n',
  'test/a.test.ts':
    header +
    "import { value } from '../src/input.ts'; test('a', () => expect(value).toBeGreaterThan(0));\n",
  'test/b.test.ts': header + "test('b', () => expect(1).toBe(1));\n",
};

export function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 15000) {
  const result = spawnSync(process.execPath, args, {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...baseEnv(f), ...env },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return {
    code: result.status,
    output: result.stdout + result.stderr,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function installed(f: Fixture) {
  const applied = applyFeedback(f, 'bun run check:affected');
  expect(applied.code, applied.output).toBe(0);
  commitFixture(f.repo, 'configured');
}

/** 全qualityを実行して依存記録を作る。記録を作るためのsrc/input.tsの変更は、戻さずに残す。 */
export async function seed(f: Fixture) {
  await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
  const result = run(f, ['run', 'check:affected']);
  expect(result.code, result.output).toBe(0);
}

export function applyFeedback(
  f: Fixture,
  feedbackCommand: string,
  execute: (f: Fixture, args: string[]) => { code: number | null; output: string } = run,
) {
  return execute(f, [setup, 'apply', '--repo', f.repo, '--feedback-command', feedbackCommand]);
}

export const cliConfig = {
  ...config,
  assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放の確認' }],
  testArgs: ['--timeout', '15000'],
  dependencies: [{ inputs: ['data/*.json'], tests: ['test/a.test.ts'] }],
};

export const cliFiles = {
  ...files,
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'bun@1.4.4',
    scripts: { check: 'bun test test', 'lint:fix': 'echo explicit-fix' },
  }),
  '.feedback-loop.json': JSON.stringify(cliConfig),
  // check:feedbackの前段に置く、何もしない検査。
  'scripts/probe.ts': '\n',
  'data/value.json': '{"value":1}\n',
  'test/a.test.ts':
    header +
    "import { value } from '../src/input.ts'; test('value', () => { console.log('QUALITY_A'); expect(value).toBeLessThan(3); });\n",
  'test/b.test.ts':
    header + "test('normal', () => { console.log('QUALITY_B'); expect(1).toBe(1); });\n",
  'test/assurance.test.ts':
    header + "test('cleanup', () => { console.log('ASSURANCE_RAN'); expect(1).toBe(1); });\n",
};

export async function snapshot(repo: string) {
  const entries = await readdir(repo, { recursive: true, withFileTypes: true });
  const tracked = entries.filter(
    (entry) => entry.isFile() && !join(entry.parentPath, entry.name).includes('/.git/'),
  );
  return Object.fromEntries(
    await Promise.all(
      tracked.map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(repo.length + 1), await readFile(path, 'utf8')] as const;
      }),
    ),
  );
}

export function runSetup(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  return run(f, args, env, 30000);
}

export function applyWithProbe(f: Fixture, bunArgs: string[] = []) {
  const result = applyFeedback(
    f,
    'bun scripts/probe.ts && bun run check:affected',
    (target, args) => runSetup(target, [...bunArgs, ...args]),
  );
  expect(result.code, result.output).toBe(0);
}

// テストがFEEDBACK_TRACEへ1行ずつ書いた実行の記録を、書かれた順に返す。
export function traceFile(f: Fixture) {
  return join(f.signals, 'executed.log');
}

export async function observations(f: Fixture) {
  return (await readFile(traceFile(f), 'utf8')).trim().split('\n').filter(Boolean);
}
