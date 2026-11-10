import {
  applyFeedback,
  applyWithProbe as apply,
  cliConfig as config,
  cliFiles as files,
  runSetup as run,
  setup,
  snapshot,
} from './support/feedback-loop-batch.ts';
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../src/values.ts';
import { baseEnv, fixture } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

function object(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  assert(isRecord(parsed));
  return parsed;
}

for (const { operation, args, option, value, trailing } of [
  {
    operation: 'inspect',
    args: ['inspect'],
    option: '--feedback-command',
    value: 'x',
    trailing: [],
  },
  { operation: 'inspect', args: ['inspect'], option: '--check-command', value: 'x', trailing: [] },
  {
    operation: 'inspect',
    args: ['inspect'],
    option: '--package',
    value: 'oxlint@1.89.0',
    trailing: [],
  },
  {
    operation: 'install',
    args: ['install', '--package', 'oxlint@1.89.0'],
    option: '--feedback-command',
    value: 'x',
    trailing: [],
  },
  {
    operation: 'install',
    args: ['install', '--package', 'oxlint@1.89.0'],
    option: '--check-command',
    value: 'x',
    trailing: [],
  },
  {
    operation: 'apply',
    args: ['apply', '--feedback-command', 'bun run test:affected'],
    option: '--package',
    value: 'oxlint@1.89.0',
    trailing: [],
  },
  {
    operation: 'apply --update',
    args: ['apply', '--update'],
    option: '--package',
    value: 'oxlint@1.89.0',
    trailing: [],
  },
  {
    operation: 'compare-tests',
    args: ['compare-tests'],
    option: '--feedback-command',
    value: 'x',
    trailing: ['--', 'bun', 'test', './test'],
  },
  {
    operation: 'compare-tests',
    args: ['compare-tests'],
    option: '--check-command',
    value: 'x',
    trailing: ['--', 'bun', 'test', './test'],
  },
  {
    operation: 'compare-tests',
    args: ['compare-tests'],
    option: '--package',
    value: 'oxlint@1.89.0',
    trailing: ['--', 'bun', 'test', './test'],
  },
]) {
  test(`setupの${operation}は無関係な${option}を変更前に拒否する`, async () => {
    await fixture(
      {
        ...files,
        'package.json': JSON.stringify({
          packageManager: 'bun@1.4.4',
          scripts: { check: 'bun test test' },
          devDependencies: { oxlint: '1.89.0' },
        }),
      },
      async (f) => {
        const before = await snapshot(f.repo);
        const result = run(f, [setup, ...args, '--repo', f.repo, option, value, ...trailing]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.stderr).toContain(`${operation}では${option}を指定できません`);
        expect(await snapshot(f.repo)).toEqual(before);
      },
    );
  });
}

for (const { args, diagnostic } of [
  { args: ['install'], diagnostic: '--package NAME@固定版を指定してください' },
  { args: ['apply'], diagnostic: '--feedback-commandに診断用コマンドを指定してください' },
  { args: ['inspect', '--'], diagnostic: 'inspectでは--を指定できません' },
  {
    args: ['install', '--package', 'oxlint@1.89.0', '--'],
    diagnostic: 'installでは--を指定できません',
  },
  {
    args: ['apply', '--feedback-command', 'x', '--'],
    diagnostic: 'applyでは--を指定できません',
  },
  { args: ['apply', '--update', '--'], diagnostic: 'apply --updateでは--を指定できません' },
  { args: ['compare-tests'], diagnostic: '--の後にbun testのargvが必要です' },
  { args: ['compare-tests', '--'], diagnostic: '--の後にbun testのargvが必要です' },
  { args: ['compare-tests', '--', 'node', 'test'], diagnostic: '--の後にbun testのargvが必要です' },
  { args: ['inspect', '--repo', '/duplicate'], diagnostic: '--repoが重複しています' },
  {
    args: ['apply', '--feedback-command', 'x', '--feedback-command', 'y'],
    diagnostic: '--feedback-commandが重複しています',
  },
  { args: ['inspect', '--update'], diagnostic: 'inspectでは--updateを指定できません' },
  { args: ['inspect', '--unknown', 'x'], diagnostic: 'inspectでは--unknownを指定できません' },
  { args: ['inspect', '--unknown'], diagnostic: 'inspectでは--unknownを指定できません' },
  {
    args: ['inspect', '--feedback-command'],
    diagnostic: 'inspectでは--feedback-commandを指定できません',
  },
  { args: ['unknown'], diagnostic: '操作はinspect・install・apply・compare-testsです' },
  { args: ['update'], diagnostic: '操作はinspect・install・apply・compare-testsです' },
  { args: ['inspect', ''], diagnostic: '空の引数は指定できません' },
  { args: ['inspect', '--', '-h'], diagnostic: 'inspectでは--を指定できません' },
  {
    args: ['apply', '--feedback-command', '--update'],
    diagnostic: 'apply --updateでは--feedback-commandを指定できません',
  },
]) {
  test(`setupは${args.join(' ')}を診断付きで変更前に拒否する`, async () => {
    await fixture(files, async (f) => {
      const before = await snapshot(f.repo);
      const [operation = '', ...options] = args;
      const result = run(f, [setup, operation, '--repo', f.repo, ...options]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stderr).toContain(diagnostic);
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

for (const args of [[], ['--repo', 'relative']]) {
  test(`setupは絶対パスのrepoがない${args.join(' ')}を拒否する`, async () => {
    await fixture(files, async (f) => {
      const before = await snapshot(f.repo);
      const result = run(f, [setup, 'inspect', ...args]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stderr).toContain('--repoにGit checkoutの絶対パスが必要です');
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

for (const { manager, expectedManager } of [
  { manager: 'bun@1.4.4', expectedManager: 'bun' },
  { manager: 'npm@11.0.0', expectedManager: 'npm' },
  { manager: 'pnpm@10.0.0', expectedManager: 'pnpm' },
]) {
  test(`inspectは${manager}の公開項目を読み、ローカル差分を書き換えない`, async () => {
    const pkg = {
      packageManager: manager,
      scripts: { check: 'echo existing' },
      devDependencies: { eslint: '9.0.0' },
    };
    const toolConfigs = { '.oxlintrc.json': '{}', '.oxfmtrc.json': '{}' };
    const tracked = { 'package.json': JSON.stringify(pkg), 'notes.txt': 'local', ...toolConfigs };
    await fixture(tracked, async (f) => {
      await writeFile(join(f.repo, 'notes.txt'), 'uncommitted');
      const before = await snapshot(f.repo);
      const result = run(f, [setup, 'inspect', '--repo', f.repo]);
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        packageManager: expectedManager,
        scripts: pkg.scripts,
        devDependencies: pkg.devDependencies,
      });
      const inspected = object(result.stdout);
      assert(Array.isArray(inspected.configFiles));
      for (const path of Object.keys(toolConfigs)) {
        expect(inspected.configFiles).toContain(path);
      }
      for (const path of inspected.configFiles) {
        assert(typeof path === 'string');
        expect(Object.hasOwn(before, path)).toBe(true);
      }
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

test('installは同じ固定版を更新せず、別版と範囲指定を変更前に拒否する', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({
        packageManager: 'bun@1.4.4',
        devDependencies: { oxlint: '1.89.0' },
      }),
    },
    async (f) => {
      const before = await snapshot(f.repo);
      const same = run(f, [setup, 'install', '--repo', f.repo, '--package', 'oxlint@1.89.0']);
      expect(same.code, same.output).toBe(0);
      expect(await snapshot(f.repo)).toEqual(before);
      for (const { requested, packageName } of [
        { requested: 'oxlint@1.90.0', packageName: 'oxlint' },
        { requested: 'fallow@latest', packageName: 'fallow' },
        { requested: 'fallow@^3.34.1', packageName: 'fallow' },
      ]) {
        const result = run(f, [setup, 'install', '--repo', f.repo, '--package', requested]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(packageName);
        expect(await snapshot(f.repo)).toEqual(before);
      }
    },
  );
});

test('applyは既存check・設定・ローカル差分を保ち、check:feedbackの前段が失敗したらテストへ進まない', async () => {
  await fixture(files, async (f) => {
    await writeFile(join(f.repo, 'local.txt'), 'keep local changes');
    apply(f);
    const pkg = object(await readFile(join(f.repo, 'package.json'), 'utf8'));
    assert(isRecord(pkg.scripts));
    expect(pkg.scripts.check).toBe('bun test test');
    expect(pkg.scripts['lint:fix']).toBe('echo explicit-fix');
    expect(pkg.scripts['check:feedback']).toBe('bun scripts/probe.ts && bun run test:affected');
    expect(await readFile(join(f.repo, '.feedback-loop.json'), 'utf8')).toBe(
      files['.feedback-loop.json'],
    );
    const installed = await snapshot(f.repo);
    expect(Object.keys(installed).some((path) => path.startsWith('scripts/feedback-loop/'))).toBe(
      true,
    );
    apply(f);
    expect(await snapshot(f.repo)).toEqual(installed);
    const classified = run(f, ['run', 'check:classification']);
    expect(classified.code, classified.output).toBe(0);
    expect(JSON.parse(classified.stdout)).toEqual({
      all: ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'],
      quality: ['test/a.test.ts', 'test/b.test.ts'],
      assurance: ['test/assurance.test.ts'],
    });
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const feedback = run(f, ['run', 'check:feedback']);
    expect(feedback.code, feedback.output).toBe(0);
    expect(feedback.output).toContain('QUALITY_A');
    expect(feedback.output).toContain('QUALITY_B');
    expect(feedback.output).not.toContain('ASSURANCE_RAN');
    const failed = run(f, ['run', 'check:feedback'], { PROBE_FAIL: '1' });
    expect(failed.code, failed.output).not.toBe(0);
    expect(failed.output).toContain(
      'PROBE_DIAGNOSTIC scripts/probe.ts; rerun: bun run check:feedback',
    );
    expect(failed.output).not.toContain('QUALITY_A');
    expect(await readFile(join(f.repo, 'local.txt'), 'utf8')).toBe('keep local changes');
  });
});

test('分類検査はすべての引数を診断付きで拒否し、収集とテストへ進まない', async () => {
  await fixture(files, async (f) => {
    apply(f);
    await writeFile(join(f.repo, 'scripts/collect.ts'), "throw new Error('COLLECT_RAN');\n");
    const before = await snapshot(f.repo);
    for (const { args, diagnostic } of [
      { args: ['--unknown'], diagnostic: 'classificationは引数を取りません: --unknown' },
      {
        args: ['unexpected', 'value'],
        diagnostic: 'classificationは引数を取りません: unexpected value',
      },
      { args: ['--'], diagnostic: 'classificationは引数を取りません: --' },
    ]) {
      const result = run(f, ['scripts/feedback-loop/runtime.mjs', 'classification', ...args]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stderr).toContain(diagnostic);
      expect(result.stdout).toBe('');
      expect(result.output).not.toContain('COLLECT_RAN');
      expect(result.output).not.toContain('QUALITY_A');
    }
    expect(await snapshot(f.repo)).toEqual(before);
  });
});

for (const { scenario, changed, diagnostic } of [
  {
    scenario: 'duplicate',
    changed: {
      ...config,
      assurance: [
        { path: 'test/assurance.test.ts', reason: '資源解放の確認' },
        { path: 'test/assurance.test.ts', reason: '資源解放の確認' },
      ],
    },
    diagnostic: 'assurance指定が重複しています',
  },
  {
    scenario: 'outside',
    changed: { ...config, assurance: [{ path: 'src/input.ts', reason: '資源解放の確認' }] },
    diagnostic: '集合外の指定',
  },
  {
    scenario: 'missing',
    changed: { ...config, assurance: [{ path: 'test/missing.test.ts', reason: '資源解放の確認' }] },
    diagnostic: '存在しないテスト',
  },
  {
    scenario: 'empty-reason',
    changed: { ...config, assurance: [{ path: 'test/assurance.test.ts', reason: '   ' }] },
    diagnostic: '指定理由が必要です',
  },
  {
    scenario: 'collection-mismatch',
    changed: { ...config, testGlobs: ['test/a.test.ts'] },
    diagnostic: 'testGlobsの集合が一致しません',
  },
]) {
  test(`導入後の${scenario}は分類検査と関連実行の両方で拒否する`, async () => {
    await fixture(files, async (f) => {
      apply(f);
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(changed));
      const before = await snapshot(f.repo);
      for (const command of ['check:classification', 'test:affected']) {
        const result = run(f, ['run', command]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(diagnostic);
        expect(result.output).not.toContain('QUALITY_A');
        expect(result.output).not.toContain('ASSURANCE_RAN');
        expect(await snapshot(f.repo)).toEqual(before);
      }
    });
  });
}

for (const { name, managers, prepareRepo, connectionScript, checkOutput } of [
  {
    name: '通常パス',
    managers: [
      { manager: 'bun', packageManager: 'bun@1.4.4' },
      { manager: 'npm', packageManager: 'npm@11.0.0' },
    ],
    prepareRepo: async (f: Fixture) => f,
    connectionScript: 'check:feedback',
    checkOutput: (_stdout: string, output: string) => {
      expect(output).toContain("SETUP'S FEEDBACK");
      expect(output).toContain('QUALITY_A');
      expect(output).toContain('QUALITY_B');
    },
  },
  {
    name: '空白・引用符パス',
    managers: [{ manager: 'bun', packageManager: 'bun@1.4.4' }],
    prepareRepo: async (f: Fixture) => {
      const repo = join(f.repo, '..', "project 'quoted' space");
      await rename(f.repo, repo);
      return { ...f, repo };
    },
    connectionScript: 'check:classification',
    checkOutput: (stdout: string, _output: string) => {
      expect(JSON.parse(stdout)).toMatchObject({
        quality: ['test/a.test.ts', 'test/b.test.ts'],
        assurance: ['test/assurance.test.ts'],
      });
    },
  },
]) {
  for (const { manager, packageManager } of managers) {
    test(`初回applyの収集失敗後は${name}でも案内どおりの再実行で${manager}管理の導入が完了する`, async () => {
      const feedback = `printf '%s\\n' "SETUP'S FEEDBACK" && ${manager} run test:affected`;
      await fixture(
        {
          ...files,
          'package.json': JSON.stringify({
            private: true,
            type: 'module',
            packageManager: packageManager,
            scripts: { check: 'bun test test' },
          }),
          'scripts/collect.ts':
            "import { existsSync } from 'node:fs'; if (!existsSync('collection-ready')) { console.error('COLLECTION_NOT_READY'); process.exit(23); }\n" +
            files['scripts/collect.ts'],
        },
        async (initial) => {
          const f = await prepareRepo(initial);
          const repo = f.repo;
          const env = { ...baseEnv(f), npm_config_cache: join(f.reports, 'npm-cache') };
          const before = await snapshot(repo);
          const failed = applyFeedback(f, feedback, run);
          expect(failed.code, failed.output).toBe(1);
          expect(failed.output).toContain('COLLECTION_NOT_READY');
          expect(await snapshot(repo)).toEqual(before);
          const retry = /再実行: ([^\r\n]+)/.exec(failed.output)?.[1];
          assert(retry, failed.output);

          await writeFile(join(repo, 'collection-ready'), 'ready\n');
          const recovered = spawnSync('/bin/sh', ['-c', retry], {
            cwd: repo,
            encoding: 'utf8',
            timeout: 30000,
            env,
          });
          expect(recovered.error).toBeUndefined();
          expect(recovered.signal).toBeNull();
          expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
          const pkg = object(await readFile(join(repo, 'package.json'), 'utf8'));
          assert(isRecord(pkg.scripts));
          expect(pkg.scripts['check:feedback']).toBe(feedback);
          expect(typeof pkg.scripts['test:affected']).toBe('string');
          expect(typeof pkg.scripts['check:classification']).toBe('string');
          expect(
            Object.keys(await snapshot(repo)).some((path) =>
              path.startsWith('scripts/feedback-loop/'),
            ),
          ).toBe(true);
          const connected = spawnSync(manager, ['run', connectionScript], {
            cwd: repo,
            encoding: 'utf8',
            timeout: 30000,
            env,
          });
          expect(connected.error).toBeUndefined();
          expect(connected.signal).toBeNull();
          const output = connected.stdout + connected.stderr;
          expect(connected.status, output).toBe(0);
          checkOutput(connected.stdout, output);
          expect(output).not.toContain('ASSURANCE_RAN');
        },
      );
    });
  }
}

for (const { scenario, changed, packageJson, diagnostic } of [
  {
    scenario: 'duplicate',
    changed: {
      ...config,
      assurance: [
        { path: 'test/assurance.test.ts', reason: '資源解放の確認' },
        { path: 'test/assurance.test.ts', reason: '資源解放の確認' },
      ],
    },
    packageJson: files['package.json'],
    diagnostic: 'assurance指定が重複しています',
  },
  {
    scenario: 'outside',
    changed: { ...config, assurance: [{ path: 'test/missing.test.ts', reason: '資源解放の確認' }] },
    packageJson: files['package.json'],
    diagnostic: '集合外の指定',
  },
  {
    scenario: 'empty-reason',
    changed: { ...config, assurance: [{ path: 'test/assurance.test.ts', reason: '' }] },
    packageJson: files['package.json'],
    diagnostic: '指定理由が必要です',
  },
  {
    scenario: 'collection-mismatch',
    changed: { ...config, testGlobs: ['test/a.test.ts'] },
    packageJson: files['package.json'],
    diagnostic: 'testGlobsの集合が一致しません',
  },
  {
    scenario: 'command-conflict',
    changed: config,
    packageJson: JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'bun@1.4.4',
      scripts: {
        check: 'bun test test',
        'lint:fix': 'echo explicit-fix',
        'test:affected': 'echo local-command',
      },
    }),
    diagnostic: '既存コマンドと衝突しています',
  },
]) {
  test(`applyは${scenario}を配置前に拒否する`, async () => {
    await fixture(files, async (f) => {
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(changed));
      await writeFile(join(f.repo, 'package.json'), packageJson);
      const before = await snapshot(f.repo);
      const result = applyFeedback(f, 'bun scripts/probe.ts', run);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(diagnostic);
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

for (const { runner, runnerConfig } of [
  { runner: 'bun', runnerConfig: config },
  {
    runner: 'vitest',
    runnerConfig: {
      runner: 'vitest',
      base: 'main',
      collect: config.collect,
      testGlobs: config.testGlobs,
      assurance: config.assurance,
      prepare: [],
      testArgs: [],
      globalChanges: config.globalChanges,
      dependencies: config.dependencies,
    },
  },
]) {
  test(`${runner}のallowSkippedはboolean以外を配置前に拒否する`, async () => {
    await fixture(files, async (f) => {
      for (const invalid of ['false', 0, null, [], {}]) {
        const changed = { ...runnerConfig, allowSkipped: invalid };
        await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(changed));
        const before = await snapshot(f.repo);
        const result = applyFeedback(f, 'bun scripts/probe.ts', run);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain('allowSkipped');
        expect(await snapshot(f.repo)).toEqual(before);
      }
    });
  });
}

test('--repoはシンボリックリンクを解決してGitのルートと比べ、ルート以外は拒否する', async () => {
  await fixture(
    {
      ...files,
      'package.json': JSON.stringify({
        private: true,
        type: 'module',
        packageManager: 'bun@1.4.4',
        scripts: { check: 'bun test test' },
        devDependencies: { oxlint: '1.89.0' },
      }),
    },
    async (f) => {
      const link = join(f.signals, 'linked-repo');
      await symlink(f.repo, link);
      const inspected = run(f, [setup, 'inspect', '--repo', link]);
      expect(inspected.code, inspected.output).toBe(0);
      const installed = run(f, [setup, 'install', '--repo', link, '--package', 'oxlint@1.89.0']);
      expect(installed.code, installed.output).toBe(0);
      const applied = run(f, [
        setup,
        'apply',
        '--repo',
        link,
        '--feedback-command',
        'bun run test:affected',
      ]);
      expect(applied.code, applied.output).toBe(0);
      expect(existsSync(join(f.repo, 'scripts/feedback-loop/runtime.mjs'))).toBe(true);

      const subdirectory = join(f.signals, 'linked-subdirectory');
      await symlink(join(f.repo, 'src'), subdirectory);
      for (const path of [subdirectory, join(f.repo, 'src')]) {
        const rejected = run(f, [setup, 'inspect', '--repo', path]);
        expect(rejected.code, rejected.output).not.toBe(0);
        expect(rejected.output).toContain('--repoはGit checkoutのルートを指定してください');
      }
    },
  );
}, 60000);

test('pnpm-lock.yamlだけのrepoはpnpmと判定し、再実行の案内をpnpm runにする', async () => {
  const pnpmFiles = {
    ...files,
    'package.json': JSON.stringify({
      private: true,
      type: 'module',
      scripts: { check: 'bun test test' },
    }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  };
  await fixture(pnpmFiles, async (f) => {
    const inspected = run(f, [setup, 'inspect', '--repo', f.repo]);
    expect(inspected.code, inspected.output).toBe(0);
    expect(object(inspected.stdout)).toMatchObject({ packageManager: 'pnpm', diagnostics: [] });
    const applied = applyFeedback(f, 'pnpm run test:affected', run);
    expect(applied.code, applied.output).toBe(0);
    // pnpmの実行ファイルを要求しないよう、配置された入口を直接起動する。
    const classified = run(f, ['scripts/feedback-loop/runtime.mjs', 'classification']);
    expect(classified.code, classified.output).toBe(0);
    expect(classified.stderr).toContain('再実行: pnpm run test:affected');
  });
});

for (const lockfile of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
  test(`${lockfile}でpackage managerを選択できなければ調査で診断し、導入は変更前に止まる`, async () => {
    await fixture({ ...files, [lockfile]: '{}' }, async (f) => {
      const before = await snapshot(f.repo);
      const inspected = run(f, [setup, 'inspect', '--repo', f.repo]);
      expect(inspected.code, inspected.output).toBe(0);
      expect(object(inspected.stdout)).toMatchObject({
        packageManager: null,
        diagnostics: ['package managerが未指定、競合、または未対応です'],
      });
      expect(await snapshot(f.repo)).toEqual(before);
      for (const args of [
        ['install', '--package', 'oxlint@1.89.0'],
        ['apply', '--feedback-command', 'bun run test:affected'],
      ]) {
        const rejected = run(f, [setup, ...args, '--repo', f.repo]);
        expect(rejected.code, rejected.output).not.toBe(0);
        expect(rejected.output).toContain('package managerを選択できません');
        expect(await snapshot(f.repo)).toEqual(before);
      }
    });
  });
}

for (const { manager, expectedArgs } of [
  { manager: 'bun', expectedArgs: ['add', '--dev', '--exact', 'fallow@3.34.1'] },
  { manager: 'npm', expectedArgs: ['install', '--save-dev', '--save-exact', 'fallow@3.34.1'] },
  { manager: 'pnpm', expectedArgs: ['add', '--save-dev', '--save-exact', 'fallow@3.34.1'] },
]) {
  test(`${manager}で不足依存だけを開発用の固定版として導入し、導入後の不一致も検出する`, async () => {
    await fixture(
      {
        'package.json': JSON.stringify({
          packageManager: `${manager}@1.4.4`,
          devDependencies: { oxlint: '1.89.0' },
        }),
      },
      async (f) => {
        const bin = join(f.signals, 'bin');
        await mkdir(bin);
        const command = join(bin, manager);
        await writeFile(
          command,
          `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.INSTALL_ARGS, JSON.stringify(args));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const spec of args.filter(arg => /^(oxlint|oxfmt|fallow)@/.test(arg))) {
  const [name, version] = spec.split('@');
  pkg.devDependencies[name] = process.env.INSTALL_WRONG === '1' ? '0.0.0' : version;
}
writeFileSync('package.json', JSON.stringify(pkg));
`,
        );
        await chmod(command, 0o755);
        const log = join(f.signals, 'args.json');
        const env = { PATH: bin + ':' + baseEnv(f).PATH, INSTALL_ARGS: log };
        const result = run(
          f,
          [
            setup,
            'install',
            '--repo',
            f.repo,
            '--package',
            'oxlint@1.89.0',
            '--package',
            'fallow@3.34.1',
          ],
          env,
        );
        expect(result.code, result.output).toBe(0);
        expect(JSON.parse(await readFile(log, 'utf8'))).toEqual(expectedArgs);
        expect(object(await readFile(join(f.repo, 'package.json'), 'utf8'))).toMatchObject({
          devDependencies: { oxlint: '1.89.0', fallow: '3.34.1' },
        });
        const mismatch = run(f, [setup, 'install', '--repo', f.repo, '--package', 'oxfmt@0.1.0'], {
          ...env,
          INSTALL_WRONG: '1',
        });
        expect(mismatch.code, mismatch.output).not.toBe(0);
        expect(mismatch.output).toContain('導入後のdevDependenciesが指定した固定版と一致しません');
      },
    );
  });
}
