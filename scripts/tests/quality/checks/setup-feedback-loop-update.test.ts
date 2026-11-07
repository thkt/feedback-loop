import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import { skillSetup } from '../../support/feedback-loop-skill.ts';
import { baseEnv, fixture, git, header } from '../../support/runner-affected.ts';
import type { Fixture } from '../../support/runner-affected.ts';

const setup = await skillSetup();
const runtimePath = 'scripts/feedback-loop/runtime.mjs';
const recorderPath = 'scripts/feedback-loop/record-modules.ts';
const recordPath = 'scripts/feedback-loop/generated.json';
const placed = [runtimePath, recorderPath, 'package.json', '.feedback-loop.json'];

const files = {
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'bun@1.4.4',
    scripts: { check: 'bun test test' },
  }),
  '.feedback-loop.json': JSON.stringify({
    version: 1,
    runner: 'bun',
    base: 'main',
    collect: [process.execPath, 'scripts/collect.ts'],
    testGlobs: ['test/*.test.ts'],
    assurance: [],
    fullCheck: [process.execPath, 'run', 'check'],
    prepare: [],
    bunArgs: [],
    testArgs: [],
    globalChanges: [],
    dependencies: [],
  }),
  'scripts/collect.ts':
    "import { readdirSync } from 'node:fs'; console.log(JSON.stringify(readdirSync('test').map(p => 'test/' + p)));\n",
  'test/a.test.ts': header + "test('a', () => { expect(1).toBe(1); });\n",
};

function run(f: Fixture, args: string[]) {
  const result = spawnSync(process.execPath, [setup, ...args, '--repo', f.repo], {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 30000,
    env: baseEnv(f),
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: result.stdout + result.stderr };
}

async function contents(f: Fixture) {
  const entries = await Promise.all(
    placed.map(async (path) => [path, await readFile(join(f.repo, path), 'utf8')] as const),
  );
  return Object.fromEntries(entries);
}

async function installedFromOlderVersion(f: Fixture) {
  const applied = run(f, ['apply', '--feedback-command', 'bun run test:affected']);
  expect(applied.code, applied.output).toBe(0);
  const current = await contents(f);
  for (const path of [runtimePath, recorderPath]) {
    const older = `${current[path] ?? ''}// older version\n`;
    await writeFile(join(f.repo, path), older);
  }
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-m', 'installed from an older version');
  return current;
}

test('apply --updateはコミット済みの古い生成物を最新へ置き換え、再実行では変更しない', async () => {
  await fixture(files, async (f) => {
    const current = await installedFromOlderVersion(f);
    const before = await contents(f);

    const conflict = run(f, ['apply', '--feedback-command', 'bun run test:affected']);
    expect(conflict.code, conflict.output).not.toBe(0);
    expect(conflict.output).toContain('配置済みファイルと衝突しています');
    expect(await contents(f)).toEqual(before);

    const updated = run(f, ['apply', '--update']);
    expect(updated.code, updated.output).toBe(0);
    expect(await contents(f)).toEqual(current);

    const repeated = run(f, ['apply', '--update']);
    expect(repeated.code, repeated.output).toBe(0);
    expect(repeated.output).toContain('生成物は最新です');
    expect(await contents(f)).toEqual(current);
  });
});

test('apply --updateは未コミットの変更がある生成物があれば、どのファイルも変更せず対象を示す', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    await writeFile(join(f.repo, runtimePath), '// edited by hand\n');
    const before = await contents(f);

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(runtimePath);
    expect(result.output).not.toContain(recorderPath);
    expect(await contents(f)).toEqual(before);
  });
});

test('apply --updateは未追跡の生成物があれば全体を止め、存在しなければ配置する', async () => {
  await fixture(files, async (f) => {
    const current = await installedFromOlderVersion(f);
    git(f.repo, 'rm', '--cached', recorderPath);
    const before = await contents(f);
    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(recorderPath);
    expect(await contents(f)).toEqual(before);
    await unlink(join(f.repo, recorderPath));
    expect(run(f, ['apply', '--update']).code).toBe(0);
    expect(await contents(f)).toEqual(current);
    await writeFile(join(f.repo, recordPath), 'invalid legacy JSON');
    const legacy = run(f, ['apply', '--update']);
    expect(legacy.code, legacy.output).toBe(0);
    expect(legacy.output).toContain('削除して構いません');
    expect(await readFile(join(f.repo, recordPath), 'utf8')).toBe('invalid legacy JSON');
  });
});

test('apply --updateはpackage scriptsを変更せず差分だけを表示する', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    const pkg: unknown = JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'));
    assert(isRecord(pkg));
    const changedPackage = `${JSON.stringify({
      ...pkg,
      scripts: { check: 'bun test test', 'test:affected': 'echo custom' },
    })}\n`;
    await writeFile(join(f.repo, 'package.json'), changedPackage);

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('test:affected: echo custom →');
    expect(result.output).toContain('check:classification: (未定義) →');
    expect(result.output).toContain('check:feedback: (未定義)');
    expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(changedPackage);
  });
});

test('--updateはapply以外と--feedback-commandとの併用を、変更前に拒否する', async () => {
  await fixture(files, async (f) => {
    const before = await readFile(join(f.repo, 'package.json'), 'utf8');
    for (const args of [
      ['inspect', '--update'],
      ['install', '--update', '--package', 'oxlint@1.89.0'],
      ['apply', '--update', '--feedback-command', 'bun run test:affected'],
    ]) {
      const result = run(f, args);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('--update');
    }
    expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(before);
  });
});

test('runnerをBunからVitestへ変えて更新しても配置済みの記録器を残す', async () => {
  await fixture(files, async (f) => {
    const applied = run(f, ['apply', '--feedback-command', 'bun run test:affected']);
    expect(applied.code, applied.output).toBe(0);
    const recorder = await readFile(join(f.repo, recorderPath), 'utf8');
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'Bun runner installed');
    const config: unknown = JSON.parse(files['.feedback-loop.json']);
    assert(isRecord(config));
    config.runner = 'vitest';
    Reflect.deleteProperty(config, 'bunArgs');
    await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(config));
    const updated = run(f, ['apply', '--update']);
    expect(updated.code, updated.output).toBe(0);
    expect(await readFile(join(f.repo, recorderPath), 'utf8')).toBe(recorder);
  });
});
