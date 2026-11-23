import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyFeedback,
  cliConfig,
  cliFiles,
  fakeManager,
  runSetup as run,
  setup,
  snapshot,
} from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { mutatorVersion } from './support/feedback-loop-skill.ts';
import { isRecord } from './support/json.ts';
import { commitFixture, fixture } from './support/runner-affected.ts';
import { vitestConfig } from './support/vitest.ts';

function npmRepo(config: Record<string, unknown>, dependencies: Record<string, unknown> = {}) {
  return {
    ...cliFiles,
    'package.json': JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'npm@11.0.0',
      scripts: { check: 'bun test test' },
      ...dependencies,
    }),
    '.feedback-loop.json': JSON.stringify(config),
  };
}

async function packageJson(f: Fixture) {
  const pkg: unknown = JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'));
  assert(isRecord(pkg) && isRecord(pkg.scripts));
  return { scripts: pkg.scripts, devDependencies: pkg.devDependencies };
}

const improveTestsPath = 'scripts/feedback-loop/improve-tests.md';
const generatedProcedure = await readFile(join(setup, '../../references/improve-tests.md'), 'utf8');

async function placedProcedure(f: Fixture) {
  return readFile(join(f.repo, improveTestsPath), 'utf8');
}

const preloadPath = 'scripts/feedback-loop/mutation-preload.ts';
const generatedPreload = await readFile(join(setup, '../mutation-preload.ts'), 'utf8');

async function placedPreload(f: Fixture) {
  return readFile(join(f.repo, preloadPath), 'utf8');
}

async function applyWithFakeNpm(f: Fixture) {
  const { log, env } = await fakeManager(f, 'npm');
  const result = applyFeedback(f, 'npm run check:affected', (target, args) =>
    run(target, args, env),
  );
  return { result, log };
}

test('mutationを省略したBunテストのrepoでは、applyが@mizchi/mutatorをfeedback-loopのpackage.jsonと同じ固定版で入れ、check:affectedと同じ実行系でmutationを接続し、preloadと改善の手順を生成した写しのまま置く', async () => {
  await fixture(npmRepo(cliConfig), async (f) => {
    const { result, log } = await applyWithFakeNpm(f);
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual([
      'install',
      '--save-dev',
      '--save-exact',
      `@mizchi/mutator@${mutatorVersion}`,
    ]);
    const pkg = await packageJson(f);
    const expected = 'bun --no-env-file scripts/feedback-loop/runtime.mjs mutation';
    expect(pkg.devDependencies).toEqual({ '@mizchi/mutator': mutatorVersion });
    expect(pkg.scripts.mutation).toBe(expected);
    expect(result.output).toContain(`"mutation":${JSON.stringify(expected)}`);
    expect(await placedProcedure(f)).toBe(generatedProcedure);
    expect(await placedPreload(f)).toBe(generatedPreload);
  });
});

test('mutationを省略したVitestのrepoでは、applyは@mizchi/mutatorを入れず、mutationを接続せず、preloadと改善の手順を置かない', async () => {
  await fixture(npmRepo(vitestConfig(cliConfig)), async (f) => {
    const { result, log } = await applyWithFakeNpm(f);
    expect(result.code, result.output).toBe(0);
    expect(existsSync(log)).toBe(false);
    const pkg = await packageJson(f);
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.scripts).not.toHaveProperty('mutation');
    expect(pkg.scripts).toHaveProperty('check:affected');
    expect(existsSync(join(f.repo, improveTestsPath))).toBe(false);
    expect(existsSync(join(f.repo, preloadPath))).toBe(false);
  });
});

test('Vitestのrepoでmutationをtrueと明示すると、applyとapply --updateは、mutationを使えないことを示してどのファイルも変えずに止まる', async () => {
  await fixture(npmRepo({ ...vitestConfig(cliConfig), mutation: true }), async (f) => {
    const before = await snapshot(f.repo);
    const { result, log } = await applyWithFakeNpm(f);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('Vitestのrepoでは、mutationを使えません');
    expect(existsSync(log)).toBe(false);
    expect(await snapshot(f.repo)).toEqual(before);
    const updated = run(f, [setup, 'apply', '--update', '--repo', f.repo]);
    expect(updated.code, updated.output).not.toBe(0);
    expect(updated.output).toContain('Vitestのrepoでは、mutationを使えません');
    expect(await snapshot(f.repo)).toEqual(before);
  });
});

for (const field of ['devDependencies', 'dependencies']) {
  test(`@mizchi/mutatorが${field}に同じ版で入っていれば、applyはpackage managerを起動せずにmutationを接続する`, async () => {
    await fixture(
      npmRepo(cliConfig, { [field]: { '@mizchi/mutator': mutatorVersion } }),
      async (f) => {
        const { result, log } = await applyWithFakeNpm(f);
        expect(result.code, result.output).toBe(0);
        expect(existsSync(log)).toBe(false);
        expect((await packageJson(f)).scripts.mutation).toBe(
          'bun --no-env-file scripts/feedback-loop/runtime.mjs mutation',
        );
      },
    );
  });
}

for (const installed of [`^${mutatorVersion}`, '0.1.0']) {
  test(`@mizchi/mutatorが${installed}で入っていれば、applyはどのファイルも変えずに止まり、版をそろえるかmutationをfalseにするよう示す`, async () => {
    await fixture(
      npmRepo(cliConfig, { devDependencies: { '@mizchi/mutator': installed } }),
      async (f) => {
        const before = await snapshot(f.repo);
        const { result, log } = await applyWithFakeNpm(f);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(
          `setup-feedback-loop未完了: 既存のバージョンを置換しません: @mizchi/mutator=${installed}。${mutatorVersion}にそろえるか、.feedback-loop.jsonのmutationをfalseにしてください`,
        );
        expect(existsSync(log)).toBe(false);
        expect(await snapshot(f.repo)).toEqual(before);
      },
    );
  });
}

test('mutationがfalseなら、applyは@mizchi/mutatorを入れず、mutationを接続せず、改善の手順を置かない', async () => {
  await fixture(npmRepo({ ...cliConfig, mutation: false }), async (f) => {
    const { result, log } = await applyWithFakeNpm(f);
    expect(result.code, result.output).toBe(0);
    expect(existsSync(log)).toBe(false);
    const pkg = await packageJson(f);
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.scripts).not.toHaveProperty('mutation');
    expect(pkg.scripts).toHaveProperty('check:affected');
    expect(existsSync(join(f.repo, improveTestsPath))).toBe(false);
  });
});

test('改善の手順とpreloadを置いていない導入済みのrepoで、apply --updateが両方を生成した写しのまま置く', async () => {
  await fixture(cliFiles, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected', run);
    expect(applied.code, applied.output).toBe(0);
    await unlink(join(f.repo, improveTestsPath));
    await unlink(join(f.repo, preloadPath));
    commitFixture(f.repo, 'installed before the procedure');
    const updated = run(f, [setup, 'apply', '--update', '--repo', f.repo]);
    expect(updated.code, updated.output).toBe(0);
    expect(updated.output).toContain(`配置: ${improveTestsPath}`);
    expect(updated.output).toContain(`配置: ${preloadPath}`);
    expect(await placedProcedure(f)).toBe(generatedProcedure);
    expect(await placedPreload(f)).toBe(generatedPreload);
  });
});

test('@mizchi/mutatorがdevDependenciesに同じ版、dependenciesに違う版で入っていれば、applyはどのファイルも変えずに止まる', async () => {
  await fixture(
    npmRepo(cliConfig, {
      devDependencies: { '@mizchi/mutator': mutatorVersion },
      dependencies: { '@mizchi/mutator': '^0.150.0' },
    }),
    async (f) => {
      const before = await snapshot(f.repo);
      const { result, log } = await applyWithFakeNpm(f);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('既存のバージョンを置換しません: @mizchi/mutator=^0.150.0。');
      expect(existsSync(log)).toBe(false);
      expect(await snapshot(f.repo)).toEqual(before);
    },
  );
});

test('既存のscriptと衝突して止まるapplyは、@mizchi/mutatorを入れず、どのファイルも変えない', async () => {
  await fixture(
    npmRepo(cliConfig, { scripts: { check: 'bun test test', 'check:affected': 'echo existing' } }),
    async (f) => {
      const before = await snapshot(f.repo);
      const { result, log } = await applyWithFakeNpm(f);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('既存コマンドと衝突しています: check:affected');
      expect(existsSync(log)).toBe(false);
      expect(await snapshot(f.repo)).toEqual(before);
    },
  );
});

test('生成するコマンドを含まないmutation scriptがあれば、applyは止まり、mutationをfalseにすれば接続しないと示す', async () => {
  await fixture(
    npmRepo(cliConfig, { scripts: { check: 'bun test test', mutation: 'stryker run' } }),
    async (f) => {
      const before = await snapshot(f.repo);
      const { result, log } = await applyWithFakeNpm(f);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(
        '既存コマンドと衝突しています: mutation。.feedback-loop.jsonのmutationをfalseにすると、mutationを接続しません',
      );
      expect(existsSync(log)).toBe(false);
      expect(await snapshot(f.repo)).toEqual(before);
    },
  );
});

test('pnpmのworkspaceのrootでは、applyはworkspaceのrootへの追加を指定して@mizchi/mutatorを入れる', async () => {
  await fixture(
    {
      ...npmRepo(cliConfig),
      'package.json': JSON.stringify({
        private: true,
        type: 'module',
        packageManager: 'pnpm@10.0.0',
        scripts: { check: 'bun test test' },
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    },
    async (f) => {
      const { log, env } = await fakeManager(f, 'pnpm');
      const result = applyFeedback(f, 'pnpm run check:affected', (target, args) =>
        run(target, args, env),
      );
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(await readFile(log, 'utf8'))).toEqual([
        'add',
        '--save-dev',
        '--save-exact',
        '--workspace-root',
        `@mizchi/mutator@${mutatorVersion}`,
      ]);
    },
  );
});

test('mutationを接続していない導入済みのrepoで、applyを同じ引数で再実行すると、@mizchi/mutatorを入れてmutationを接続する', async () => {
  await fixture(npmRepo({ ...cliConfig, mutation: false }), async (f) => {
    const { log, env } = await fakeManager(f, 'npm');
    const apply = () =>
      applyFeedback(f, 'npm run check:affected', (target, args) => run(target, args, env));
    const installed = apply();
    expect(installed.code, installed.output).toBe(0);
    await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(cliConfig));
    const again = apply();
    expect(again.code, again.output).toBe(0);
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual([
      'install',
      '--save-dev',
      '--save-exact',
      `@mizchi/mutator@${mutatorVersion}`,
    ]);
    expect((await packageJson(f)).scripts.mutation).toBe(
      'bun --no-env-file scripts/feedback-loop/runtime.mjs mutation',
    );
  });
});
