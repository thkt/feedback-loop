import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyFeedback,
  cliConfig,
  cliFiles,
  fakeManager,
  runSetup as run,
  snapshot,
} from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { oxcParserVersion } from './support/feedback-loop-skill.ts';
import { isRecord } from './support/json.ts';
import { fixture } from './support/runner-affected.ts';
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
  test(`mutationを省略した${runner}のrepoでは、applyがoxc-parserをfeedback-loopのpackage.jsonと同じ固定版で入れ、check:affectedと同じ実行系でmutationを接続する`, async () => {
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

test('mutationがfalseなら、applyはoxc-parserを入れず、mutationを接続しない', async () => {
  await fixture(npmRepo({ ...cliConfig, mutation: false }), async (f) => {
    const { result, log } = await applyWithFakeNpm(f);
    expect(result.code, result.output).toBe(0);
    expect(existsSync(log)).toBe(false);
    const pkg = await packageJson(f);
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.scripts).not.toHaveProperty('mutation');
    expect(pkg.scripts).toHaveProperty('check:affected');
  });
});
