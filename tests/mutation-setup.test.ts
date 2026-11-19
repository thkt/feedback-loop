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
import { oxcParserVersion } from './support/feedback-loop-skill.ts';
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

async function applyWithFakeNpm(f: Fixture) {
  const { log, env } = await fakeManager(f, 'npm');
  const result = applyFeedback(f, 'npm run check:affected', (target, args) =>
    run(target, args, env),
  );
  return { result, log };
}

for (const { runner, config, expected } of [
  {
    runner: '--no-env-fileを付けるBunテスト',
    config: cliConfig,
    expected: 'bun --no-env-file scripts/feedback-loop/runtime.mjs mutation',
  },
  {
    runner: 'Vitest',
    config: vitestConfig(cliConfig),
    expected: 'node scripts/feedback-loop/runtime.mjs mutation',
  },
]) {
  test(`mutationを省略した${runner}のrepoでは、applyがoxc-parserをfeedback-loopのpackage.jsonと同じ固定版で入れ、check:affectedと同じ実行系でmutationを接続し、改善の手順を生成した写しのまま置く`, async () => {
    await fixture(npmRepo(config), async (f) => {
      const { result, log } = await applyWithFakeNpm(f);
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(await readFile(log, 'utf8'))).toEqual([
        'install',
        '--save-dev',
        '--save-exact',
        `oxc-parser@${oxcParserVersion}`,
      ]);
      const pkg = await packageJson(f);
      expect(pkg.devDependencies).toEqual({ 'oxc-parser': oxcParserVersion });
      expect(pkg.scripts.mutation).toBe(expected);
      expect(result.output).toContain(`"mutation":${JSON.stringify(expected)}`);
      expect(await placedProcedure(f)).toBe(generatedProcedure);
    });
  });
}

for (const field of ['devDependencies', 'dependencies']) {
  test(`oxc-parserが${field}に同じ版で入っていれば、applyはpackage managerを起動せずにmutationを接続する`, async () => {
    await fixture(
      npmRepo(cliConfig, { [field]: { 'oxc-parser': oxcParserVersion } }),
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

for (const installed of [`^${oxcParserVersion}`, '0.1.0']) {
  test(`oxc-parserが${installed}で入っていれば、applyはどのファイルも変えずに止まり、版をそろえるかmutationをfalseにするよう示す`, async () => {
    await fixture(
      npmRepo(cliConfig, { devDependencies: { 'oxc-parser': installed } }),
      async (f) => {
        const before = await snapshot(f.repo);
        const { result, log } = await applyWithFakeNpm(f);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(
          `setup-feedback-loop未完了: 既存のバージョンを置換しません: oxc-parser=${installed}。${oxcParserVersion}にそろえるか、.feedback-loop.jsonのmutationをfalseにしてください`,
        );
        expect(existsSync(log)).toBe(false);
        expect(await snapshot(f.repo)).toEqual(before);
      },
    );
  });
}

test('mutationがfalseなら、applyはoxc-parserを入れず、mutationを接続せず、改善の手順を置かない', async () => {
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

test('改善の手順を置いていない導入済みのrepoで、apply --updateが手順を生成した写しのまま置く', async () => {
  await fixture(cliFiles, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected', run);
    expect(applied.code, applied.output).toBe(0);
    await unlink(join(f.repo, improveTestsPath));
    commitFixture(f.repo, 'installed before the procedure');
    const updated = run(f, [setup, 'apply', '--update', '--repo', f.repo]);
    expect(updated.code, updated.output).toBe(0);
    expect(updated.output).toContain(`配置: ${improveTestsPath}`);
    expect(await placedProcedure(f)).toBe(generatedProcedure);
  });
});

test('oxc-parserがdevDependenciesに同じ版、dependenciesに違う版で入っていれば、applyはどのファイルも変えずに止まる', async () => {
  await fixture(
    npmRepo(cliConfig, {
      devDependencies: { 'oxc-parser': oxcParserVersion },
      dependencies: { 'oxc-parser': '^0.150.0' },
    }),
    async (f) => {
      const before = await snapshot(f.repo);
      const { result, log } = await applyWithFakeNpm(f);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('既存のバージョンを置換しません: oxc-parser=^0.150.0。');
      expect(existsSync(log)).toBe(false);
      expect(await snapshot(f.repo)).toEqual(before);
    },
  );
});

test('既存のscriptと衝突して止まるapplyは、oxc-parserを入れず、どのファイルも変えない', async () => {
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

test('pnpmのworkspaceのrootでは、applyはworkspaceのrootへの追加を指定してoxc-parserを入れる', async () => {
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
        `oxc-parser@${oxcParserVersion}`,
      ]);
    },
  );
});

test('mutationを接続していない導入済みのrepoで、applyを同じ引数で再実行すると、oxc-parserを入れてmutationを接続する', async () => {
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
      `oxc-parser@${oxcParserVersion}`,
    ]);
    expect((await packageJson(f)).scripts.mutation).toBe(
      'bun --no-env-file scripts/feedback-loop/runtime.mjs mutation',
    );
  });
});
