import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import { skillSetup } from '../../support/feedback-loop-skill.ts';
import { baseEnv, fixture, git, header } from '../../support/runner-affected.ts';

const setup = await skillSetup();
const runtimePath = 'scripts/feedback-loop/runtime.mjs';
const recorderPath = 'scripts/feedback-loop/record-modules.ts';
const recordPath = 'scripts/feedback-loop/generated.json';
const placed = [runtimePath, recorderPath, recordPath, 'package.json', '.feedback-loop.json'];

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

type Fixture = Parameters<Parameters<typeof fixture>[1]>[0];

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

async function readRecord(f: Fixture) {
  const parsed: unknown = JSON.parse(await readFile(join(f.repo, recordPath), 'utf8'));
  assert(isRecord(parsed));
  assert(isRecord(parsed.files));
  return { ...parsed, files: parsed.files };
}

/** 現在の版で導入したあと、古い版の生成物と、その内容を記録したgenerated.jsonの状態へ戻す。 */
async function installedFromOlderVersion(f: Fixture) {
  const applied = run(f, ['apply', '--feedback-command', 'bun run test:affected']);
  expect(applied.code, applied.output).toBe(0);
  const current = await contents(f);
  const record = await readRecord(f);
  for (const path of [runtimePath, recorderPath]) {
    const older = `${current[path] ?? ''}// older version\n`;
    await writeFile(join(f.repo, path), older);
    record.files[path] = createHash('sha256').update(older).digest('hex');
  }
  await writeFile(join(f.repo, recordPath), `${JSON.stringify(record, null, 2)}\n`);
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-m', 'installed from an older version');
  return current;
}

test('apply --updateは記録と一致する古い生成物だけを最新へ置き換え、再実行では変更しない', async () => {
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

test('apply --updateは手で編集した生成物があれば、どのファイルも変更せず対象を示す', async () => {
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

test('apply --updateは記録にない生成物が異なれば変更せず、存在しない生成物は配置する', async () => {
  await fixture(files, async (f) => {
    const current = await installedFromOlderVersion(f);
    const record = await readRecord(f);
    Reflect.deleteProperty(record.files, recorderPath);
    await writeFile(join(f.repo, recordPath), `${JSON.stringify(record, null, 2)}\n`);
    const before = await contents(f);

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(recorderPath);
    expect(await contents(f)).toEqual(before);

    await unlink(join(f.repo, recorderPath));
    const placedAgain = run(f, ['apply', '--update']);
    expect(placedAgain.code, placedAgain.output).toBe(0);
    expect(await contents(f)).toEqual(current);
  });
});

test('apply --updateはgenerated.jsonかfilesがなければ、生成物を区別できないため変更しない', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    const record = await readRecord(f);
    await writeFile(
      join(f.repo, recordPath),
      JSON.stringify({ ...record, files: undefined }, null, 2),
    );
    const withoutFiles = await contents(f);
    const missingFiles = run(f, ['apply', '--update']);
    expect(missingFiles.code, missingFiles.output).not.toBe(0);
    expect(missingFiles.output).toContain('files');
    expect(await contents(f)).toEqual(withoutFiles);

    await unlink(join(f.repo, recordPath));
    const runtime = await readFile(join(f.repo, runtimePath), 'utf8');
    const missingRecord = run(f, ['apply', '--update']);
    expect(missingRecord.code, missingRecord.output).not.toBe(0);
    expect(missingRecord.output).toContain(recordPath);
    expect(await readFile(join(f.repo, runtimePath), 'utf8')).toBe(runtime);
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
