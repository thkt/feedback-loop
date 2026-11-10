import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord } from '../src/values.ts';
import { skillSetup } from './support/feedback-loop-skill.ts';
import { baseEnv, commitFixture, fixture } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

// 偽のVitestでは依存グラフの到達先を確かめられないため、固定版のVitestを実行する。
const setup = await skillSetup();
const installed = resolve(import.meta.dir, '../node_modules');

function quality(name: string, imports = '') {
  return `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
${imports}
test('${name}', () => {
  writeFileSync(join(process.env.RAN_DIR, '${name}'), '');
  expect(1).toBe(1);
});
`;
}

const sharedImport = "import '../src/shared.ts';";

const files = {
  '.gitignore': 'node_modules\n',
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'npm@11.0.0',
    scripts: { check: 'vitest run' },
  }),
  '.feedback-loop.json': JSON.stringify({
    runner: 'vitest',
    base: 'main',
    collect: [process.execPath, 'scripts/collect.ts'],
    testGlobs: ['test/*.test.ts'],
    assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放の確認' }],
    prepare: [],
    testArgs: [],
    globalChanges: [],
    dependencies: [
      { inputs: ['src/shared.ts'], tests: ['test/explicit.test.ts'] },
      { inputs: ['data/mapped.json'], tests: ['test/data.test.ts'] },
    ],
  }),
  'scripts/collect.ts':
    "import { readdirSync } from 'node:fs'; console.log(JSON.stringify(readdirSync('test').filter(p => p.endsWith('.test.ts')).map(p => 'test/' + p)));\n",
  'src/shared.ts': 'export const value = 1;\n',
  'src/orphan.ts': 'export const orphan = 1;\n',
  'data/mapped.json': '{"value":1}\n',
  'test/imported.test.ts': quality('imported', sharedImport),
  'test/explicit.test.ts': quality('explicit'),
  'test/data.test.ts': quality('data'),
  'test/unrelated.test.ts': quality('unrelated'),
  'test/assurance.test.ts': quality('assurance', `${sharedImport}\nimport './explicit.test.ts';`),
};

async function runAffected(f: Fixture) {
  await rm(f.signals, { recursive: true });
  await mkdir(f.signals);
  const result = spawnSync('npm', ['run', 'test:affected'], {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...baseEnv(f), RAN_DIR: f.signals },
  });
  expect(result.error).toBeUndefined();
  return {
    code: result.status,
    output: result.stdout + result.stderr,
    ran: (await readdir(f.signals)).sort(),
  };
}

async function affected(f: Fixture) {
  const result = await runAffected(f);
  expect(result.code, result.output).toBe(0);
  return result;
}

async function configured(f: Fixture) {
  await symlink(installed, join(f.repo, 'node_modules'));
  const applied = spawnSync(
    process.execPath,
    [setup, 'apply', '--repo', f.repo, '--feedback-command', 'npm run test:affected'],
    { cwd: f.repo, encoding: 'utf8', timeout: 30000, env: baseEnv(f) },
  );
  expect(applied.status, applied.stdout + applied.stderr).toBe(0);
  commitFixture(f.repo, 'configured');
}

test('Vitestの明示依存はimportの到達先に追加され、assuranceと無関係なqualityは選ばれない', async () => {
  await fixture(files, async (f) => {
    await configured(f);
    await writeFile(join(f.repo, 'src/shared.ts'), 'export const value = 2;\n');
    const { output, ran } = await affected(f);
    expect(ran, output).toEqual(['explicit', 'imported']);
    expect(output).not.toContain('quality全件の理由:');
  });
}, 120000);

test('Vitestの到達先が0件でも、対応付けのある入力は全qualityへ広げない', async () => {
  await fixture(files, async (f) => {
    await configured(f);
    await writeFile(join(f.repo, 'data/mapped.json'), '{"value":2}\n');
    const { output, ran } = await affected(f);
    expect(ran, output).toEqual(['data']);
    expect(output).not.toContain('quality全件の理由:');
  });
}, 120000);

test('Vitestの到達先が0件で対応付けのない入力は全qualityへ広げる', async () => {
  await fixture(files, async (f) => {
    await configured(f);
    await writeFile(join(f.repo, 'src/orphan.ts'), 'export const orphan = 2;\n');
    const { output, ran } = await affected(f);
    expect(ran, output).toEqual(['data', 'explicit', 'imported', 'unrelated']);
    expect(output).toContain('quality全件の理由:');
  });
}, 120000);

test('Vitestの到達先にcollect外のテストがあれば、未実行を成功にせず止める', async () => {
  await fixture(
    { ...files, 'other/outside.test.ts': quality('outside', "import '../src/shared.ts';") },
    async (f) => {
      await configured(f);
      await writeFile(join(f.repo, 'src/shared.ts'), 'export const value = 2;\n');
      const { code, output, ran } = await runAffected(f);
      expect(code, output).not.toBe(0);
      expect(output).toContain('Vitestの到達先がquality集合と一致しません: other/outside.test.ts');
      expect(ran).toEqual([]);
    },
  );
}, 120000);

function withConfig(extra: Record<string, unknown>) {
  const config: unknown = JSON.parse(files['.feedback-loop.json']);
  assert(isRecord(config));
  return { ...files, '.feedback-loop.json': JSON.stringify({ ...config, ...extra }) };
}

const ignoredOnly = '変更なし: ignoredChangesに当たる変更だけのため、テストを実行していません';

test('VitestはignoredChangesに当たる届かない変更だけなら、テストを実行せず終了0で終える', async () => {
  await fixture(withConfig({ ignoredChanges: ['docs/**', '*.md'] }), async (f) => {
    await configured(f);
    await mkdir(join(f.repo, 'docs'));
    await writeFile(join(f.repo, 'docs/note.md'), 'memo\n');
    await writeFile(join(f.repo, 'README.md'), 'readme\n');
    const { output, ran } = await affected(f);
    expect(output).toContain(ignoredOnly);
    expect(output).not.toContain('quality全件の理由:');
    expect(output).not.toContain('選択したqualityが成功しました');
    expect(ran).toEqual([]);
  });
}, 120000);

test('VitestはignoredChangesに当たる変更と届くソースを同時に変えたら、届くテストだけを実行する', async () => {
  await fixture(withConfig({ ignoredChanges: ['docs/**'] }), async (f) => {
    await configured(f);
    await mkdir(join(f.repo, 'docs'));
    await writeFile(join(f.repo, 'docs/note.md'), 'memo\n');
    await writeFile(join(f.repo, 'src/shared.ts'), 'export const value = 2;\n');
    const { output, ran } = await affected(f);
    expect(ran, output).toEqual(['explicit', 'imported']);
    expect(output).not.toContain('quality全件の理由:');
  });
}, 120000);

test('VitestはignoredChangesに当たっても、globalChangesと明示依存の対応を優先する', async () => {
  const config = { ignoredChanges: ['docs/**', 'data/**'], globalChanges: ['docs/**'] };
  await fixture(withConfig(config), async (f) => {
    await configured(f);
    await writeFile(join(f.repo, 'data/mapped.json'), '{"value":2}\n');
    const mapped = await affected(f);
    expect(mapped.ran, mapped.output).toEqual(['data']);
    expect(mapped.output).not.toContain('quality全件の理由:');
    await mkdir(join(f.repo, 'docs'));
    await writeFile(join(f.repo, 'docs/note.md'), 'memo\n');
    const global = await affected(f);
    expect(global.ran, global.output).toEqual(['data', 'explicit', 'imported', 'unrelated']);
    expect(global.output).toContain('docs/note.md');
  });
}, 120000);

test('VitestはignoredChangesに当たっても、明示依存の先がassuranceだけの変更は全qualityへ広げる', async () => {
  const base: unknown = JSON.parse(files['.feedback-loop.json']);
  assert(isRecord(base) && Array.isArray(base.dependencies));
  const dependencies: unknown[] = base.dependencies;
  const config = {
    ignoredChanges: ['docs/**'],
    dependencies: [...dependencies, { inputs: ['docs/**'], tests: ['test/assurance.test.ts'] }],
  };
  await fixture(withConfig(config), async (f) => {
    await configured(f);
    await mkdir(join(f.repo, 'docs'));
    await writeFile(join(f.repo, 'docs/note.md'), 'memo\n');
    const { output, ran } = await affected(f);
    expect(ran, output).toEqual(['data', 'explicit', 'imported', 'unrelated']);
    expect(output).toContain('docs/note.md');
  });
}, 120000);

test('VitestはignoredChangesに当たる追跡済みファイルの削除も、全qualityへ広げない', async () => {
  await fixture(
    { ...withConfig({ ignoredChanges: ['docs/**'] }), 'docs/old.md': 'old\n' },
    async (f) => {
      await configured(f);
      await rm(join(f.repo, 'docs/old.md'));
      const { output, ran } = await affected(f);
      expect(output).toContain(ignoredOnly);
      expect(ran).toEqual([]);
    },
  );
}, 120000);

test('Vitestは明示依存で届くpnpm-lock.yamlの変更でも全qualityへ広げる', async () => {
  const config: unknown = JSON.parse(files['.feedback-loop.json']);
  assert(isRecord(config) && Array.isArray(config.dependencies));
  const dependencies: unknown[] = config.dependencies;
  const mapped = {
    ...config,
    dependencies: [...dependencies, { inputs: ['pnpm-lock.yaml'], tests: ['test/data.test.ts'] }],
  };
  await fixture({ ...files, '.feedback-loop.json': JSON.stringify(mapped) }, async (f) => {
    await configured(f);
    // 導入時の判定をnpmに保つため、lockfileは導入後に置く。
    await writeFile(join(f.repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    commitFixture(f.repo, 'lockfile');
    await writeFile(join(f.repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\n");
    const { output, ran } = await affected(f);
    expect(ran, output).toEqual(['data', 'explicit', 'imported', 'unrelated']);
    expect(output).toContain('quality全件の理由: 設定変更、削除、または依存先不明: pnpm-lock.yaml');
  });
}, 120000);

test('Vitestは明示依存で届く入力でも、削除されていれば全qualityへ広げる', async () => {
  await fixture(files, async (f) => {
    await configured(f);
    await rm(join(f.repo, 'data/mapped.json'));
    const { output, ran } = await affected(f);
    expect(ran, output).toEqual(['data', 'explicit', 'imported', 'unrelated']);
    expect(output).toContain(
      'quality全件の理由: 設定変更、削除、または依存先不明: data/mapped.json',
    );
  });
}, 120000);
