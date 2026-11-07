import { commitFixture } from './runner-affected.ts';
import { expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, fixture, header, recordFile } from './runner-affected.ts';
import type { Fixture } from './runner-affected.ts';
import { skillSetup } from './feedback-loop-skill.ts';

export { baseEnv, fixture, header, recordFile };
export type { Fixture };
export const setup = await skillSetup();
export const config = {
  version: 1,
  runner: 'bun',
  base: 'main',
  collect: [process.execPath, 'scripts/collect.ts'],
  testGlobs: ['test/*.test.ts'],
  assurance: [],
  fullCheck: [process.execPath, 'run', 'check'],
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
  const applied = applyFeedback(f, 'bun run test:affected');
  expect(applied.code, applied.output).toBe(0);
  commitFixture(f.repo, 'configured');
}

export async function seed(f: Fixture) {
  await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
  const result = run(f, ['run', 'test:affected']);
  expect(result.code, result.output).toBe(0);
  return readFile(recordFile(f.repo), 'utf8');
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
  'scripts/probe.ts':
    "console.error('PROBE_DIAGNOSTIC scripts/probe.ts; rerun: bun run check:feedback'); process.exit(process.env.PROBE_FAIL === '1' ? 7 : 0);\n",
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
  const files = entries.filter(
    (entry) => entry.isFile() && !join(entry.parentPath, entry.name).includes('/.git/'),
  );
  return Object.fromEntries(
    await Promise.all(
      files.map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(repo.length + 1), await readFile(path, 'utf8')] as const;
      }),
    ),
  );
}

export function runSetup(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  if (args.includes(setup)) {
    expect(existsSync(setup), '公開入口が未実装です。入力拒否の成功とは扱いません').toBe(true);
  }
  return run(f, args, env, 30000);
}
