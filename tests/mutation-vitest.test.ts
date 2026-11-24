import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, installed } from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { isRecord } from './support/json.ts';
import {
  keyOf,
  linkModules,
  listed,
  narrowingItem,
  parseReport,
  prepareCount,
  withoutKeys,
} from './support/mutator.ts';
import { baseEnv, git } from './support/runner-affected.ts';
import { vitestConfig, vitestHeader } from './support/vitest.ts';

const rulesSource = `export function label(value: unknown): string {
  if (typeof value !== 'string') {
    return 'none';
  }
  return value.toUpperCase();
}

export function isAdult(age: number) {
  return age >= 18;
}

export function sum(a: number, b: number) {
  return a + b;
}
`;

const importsAndFails = `${vitestHeader}import { isAdult } from '../src/rules.ts';
test('must-not-run', () => expect(isAdult(1)).toBe('never'));
`;

const repoConfig = {
  ...vitestConfig(config),
  testArgs: [],
  assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放の確認' }],
  prepare: [process.execPath, 'scripts/prepare.ts'],
};

const excludingConfig = `import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { exclude: ['other/**', '**/node_modules/**'] } });
`;

const vitestFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  '.feedback-loop.json': JSON.stringify(repoConfig),
  'vitest.config.ts': excludingConfig,
  'scripts/prepare.ts':
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PREPARE_LOG ?? '/dev/null', 'prepared\\n');\n",
  'src/rules.ts': rulesSource,
  'test/a.test.ts': `${vitestHeader}test('a', () => expect(1).toBe(1));\n`,
  'test/b.test.ts': `${vitestHeader}test('b', () => expect(1).toBe(1));\n`,
  'test/rules.test.ts': `${vitestHeader}import { isAdult, label } from '../src/rules.ts';
test('upper', () => expect(label('ab')).toBe('AB'));
test('adult', () => expect(isAdult(30)).toBe(true));
`,
  'test/assurance.test.ts': importsAndFails,
  'other/excluded.test.ts': importsAndFails,
};

function mutation(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('node', ['scripts/feedback-loop/runtime.mjs', 'mutation', ...args], {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...baseEnv(f), PREPARE_LOG: join(f.signals, 'prepare.log'), ...env },
  });
  expect(result.error).toBeUndefined();
  return {
    code: result.status,
    output: result.stdout + result.stderr,
    stdout: result.stdout,
    stderr: result.stderr,
    report: parseReport(result.stdout),
  };
}

const sumItem = {
  path: 'src/rules.ts',
  line: 13,
  rule: 'ArithmeticOperator',
  original: 'a + b',
  replacement: 'a - b',
};

test('Vitestの導入先で、nodeで起こしたmutationは、assuranceと設定のexcludeだけで外したテストを走らせずに壊し方を判定し、Bunの導入先と同じ形のJSONと--keyの結果を書く', async () => {
  await fixture(vitestFiles, async (f) => {
    await linkModules(f.repo);
    installed(f);

    const result = mutation(f, ['src/rules.ts']);
    expect(result.code, result.output).toBe(0);
    expect(prepareCount(f)).toBe(1);
    expect(listed(result.report, 'errors')).toEqual([]);
    expect(withoutKeys(listed(result.report, 'survived'))).toContainEqual(narrowingItem);
    const uncovered = listed(result.report, 'uncovered');
    expect(withoutKeys(uncovered)).toContainEqual(sumItem);
    expect(result.stderr).not.toContain('must-not-run');
    const sumKey = keyOf(uncovered, sumItem.original, sumItem.replacement);

    const notCaught = mutation(f, ['src/rules.ts', '--key', sumKey]);
    expect(notCaught.code, notCaught.output).not.toBe(0);
    assert(isRecord(notCaught.report));
    expect([notCaught.report.key, notCaught.report.verdict]).toEqual([sumKey, 'uncovered']);

    await writeFile(
      join(f.repo, 'test/sum.test.ts'),
      `${vitestHeader}import { sum } from '../src/rules.ts';\ntest('sum', () => expect(sum(2, 1)).toBe(3));\n`,
    );
    const caught = mutation(f, ['src/rules.ts', '--key', sumKey]);
    expect(caught.code, caught.output).toBe(0);
    expect(caught.report).toEqual({ key: sumKey, ...sumItem, verdict: 'killed' });
    expect(git(f.repo, 'status', '--porcelain')).toBe('?? test/sum.test.ts');
  });
}, 300000);

test('Vitestの導入先で、tsconfig.jsonがあれば型検査に通らない壊し方を一覧から外し、--keyではerrorと型検査に通らないことを書く', async () => {
  await fixture(
    {
      ...vitestFiles,
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true },
        include: ['src'],
      }),
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/rules.ts']);
      expect(result.code, result.output).toBe(0);
      expect(withoutKeys(listed(result.report, 'survived'))).not.toContainEqual(narrowingItem);
      expect(withoutKeys(listed(result.report, 'uncovered'))).toContainEqual(sumItem);
      expect(listed(result.report, 'errors')).toEqual([]);

      await unlink(join(f.repo, 'tsconfig.json'));
      await rm(join(f.repo, '.mutator'), { recursive: true, force: true });
      const untyped = mutation(f, ['src/rules.ts']);
      expect(untyped.code, untyped.output).toBe(0);
      const narrowingKey = keyOf(
        listed(untyped.report, 'survived'),
        narrowingItem.original,
        narrowingItem.replacement,
      );

      git(f.repo, 'checkout', 'tsconfig.json');
      await rm(join(f.repo, '.mutator'), { recursive: true, force: true });
      const typeError = mutation(f, ['src/rules.ts', '--key', narrowingKey]);
      expect(typeError.code, typeError.output).not.toBe(0);
      expect(typeError.report).toEqual({
        key: narrowingKey,
        ...narrowingItem,
        verdict: 'error',
        reason: '型検査に通りません',
      });
    },
  );
}, 300000);

const modeProbe = `${vitestHeader}import { isAdult } from '../src/rules.ts';
test('mode', () => {
  expect(isAdult(20)).toBe(true);
  expect(process.env.SEEN_MODE).toBe('test');
});
`;

const outerMutatorVariables = {
  MUTATOR_ACTIVE: 'outer-mutant',
  MUTATOR_BUN_MANIFEST: 'outer-manifest.json',
  MUTATOR_BUN_OUT: 'outer-out',
  MUTATOR_HIT_LIMIT: '1',
  MUTATOR_WATCH_PARENT: '1',
};

const outerVariablesProbe = `${vitestHeader}import { isAdult } from '../src/rules.ts';
test('outer-variables-absent', () => {
  expect(isAdult(20)).toBe(true);
  expect(${JSON.stringify(Object.keys(outerMutatorVariables))}.filter((name) => process.env[name] !== undefined)).toEqual([]);
});
`;

const knownNarrowingKey = '27of6fwbp8o';

const survivedNarrowing = { key: knownNarrowingKey, ...narrowingItem, verdict: 'survived' };

test('Vitestの導入先の設定が関数なら、Vitestが渡すenvで呼んだ結果を使い、外側のmutatorが起こしたテストの中から起こしても、外側の壊し方の環境変数をテストのプロセスへ渡さない', async () => {
  await fixture(
    {
      ...vitestFiles,
      'vitest.config.ts': `import { defineConfig } from 'vitest/config';
export default defineConfig(async (env) => ({
  test: { exclude: ['other/**', '**/node_modules/**'], env: { SEEN_MODE: env.mode } },
}));
`,
      'test/mode.test.ts': modeProbe,
      'test/env.test.ts': outerVariablesProbe,
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/rules.ts'], outerMutatorVariables);
      expect(result.code, result.output).toBe(0);
      const survived = listed(result.report, 'survived');
      expect(withoutKeys(survived)).toContainEqual(narrowingItem);
      expect(keyOf(survived, narrowingItem.original, narrowingItem.replacement)).toBe(
        knownNarrowingKey,
      );
      expect(result.stderr).not.toContain('must-not-run');
    },
  );
}, 300000);

test('Vitestの導入先のtestArgsが--config <パス>、--config=<パス>、-c <パス>、-c=<パス>で設定を指せば、最後に指した設定でqualityだけを走らせる', async () => {
  await fixture(
    {
      ...vitestFiles,
      'vitest.config.ts': "export default { test: { setupFiles: ['./missing-setup.ts'] } };\n",
      'configs/mutation.config.ts': `import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { exclude: ['other/**'], env: { SEEN_MODE: 'test' } } });
`,
      'test/mode.test.ts': modeProbe,
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      for (const testArgs of [
        ['--config', 'configs/mutation.config.ts', '--pool', 'forks'],
        ['--config=configs/mutation.config.ts'],
        ['--config', 'vitest.config.ts', '-c', 'configs/mutation.config.ts'],
        [`-c=${join(f.repo, 'configs/mutation.config.ts')}`],
      ]) {
        await writeFile(
          join(f.repo, '.feedback-loop.json'),
          JSON.stringify({ ...repoConfig, testArgs }),
        );
        await rm(join(f.repo, '.mutator'), { recursive: true, force: true });
        const result = mutation(f, ['src/rules.ts', '--key', knownNarrowingKey]);
        expect(result.report, `${testArgs.join(' ')}\n${result.output}`).toEqual(survivedNarrowing);
      }
    },
  );
}, 300000);

test('Vitestの導入先のtestArgsの--configか-cにパスが無ければ、prepareの前に理由を標準エラーに出し、標準出力に何も書かずに非ゼロで終わる', async () => {
  await fixture(vitestFiles, async (f) => {
    await linkModules(f.repo);
    installed(f);
    for (const [testArgs, flag] of [
      [['--pool', 'forks', '--config'], '--config'],
      [['--config='], '--config'],
      [['-c', '--pool', 'forks'], '-c'],
      [['-c='], '-c'],
    ] as const) {
      await writeFile(
        join(f.repo, '.feedback-loop.json'),
        JSON.stringify({ ...repoConfig, testArgs }),
      );
      const result = mutation(f, ['src/rules.ts']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        `testArgs の ${flag} に、Vitest の設定ファイルのパスがありません`,
      );
    }
    expect(prepareCount(f)).toBe(0);
  });
}, 120000);

test('Vitestの導入先にVitestの設定ファイルが無ければ、Vitestが既定で集めるテストのうちqualityだけを走らせる', async () => {
  await fixture(
    Object.fromEntries(Object.entries(vitestFiles).filter(([path]) => path !== 'vitest.config.ts')),
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/rules.ts', '--key', knownNarrowingKey]);
      expect(result.report, result.output).toEqual(survivedNarrowing);
      expect(result.stderr).not.toContain('must-not-run');
    },
  );
}, 120000);

test('Vitestの導入先の設定がtest.projectsを持てば、理由を標準エラーに出し、標準出力に何も書かずに非ゼロで終わる', async () => {
  await fixture(
    {
      ...vitestFiles,
      'vitest.config.ts': `import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: [{ test: { name: 'unit', include: ['test/**/*.test.ts'] } }] } });
`,
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/rules.ts']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'test.projects を持つ Vitest の設定では、mutation を使えません',
      );
    },
  );
}, 120000);

test('Vitestの導入先の設定がtest.includeSourceを持てば、理由を標準エラーに出し、標準出力に何も書かずに非ゼロで終わる', async () => {
  await fixture(
    {
      ...vitestFiles,
      'vitest.config.ts': `import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { exclude: ['other/**'], includeSource: ['src/**/*.ts'] } });
`,
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/rules.ts']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'test.includeSource を持つ Vitest の設定では、mutation を使えません',
      );
    },
  );
}, 120000);

test('Vitestの導入先で壊す前のテストが落ちると、落ちたテストの名前を標準エラーに出し、標準出力に何も書かずに非ゼロで終わる', async () => {
  await fixture(
    {
      ...vitestFiles,
      'test/broken.test.ts': `${vitestHeader}import { isAdult } from '../src/rules.ts';\ntest('broken-baseline', () => expect(isAdult(1)).toBe(true));\n`,
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/rules.ts']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('broken-baseline');
      expect(prepareCount(f)).toBe(1);
    },
  );
}, 120000);

test('Vitestの導入先でqualityが0件なら、mutatorを起こさずに、標準出力に何も書かず非ゼロで終わる', async () => {
  await fixture(
    {
      ...vitestFiles,
      '.feedback-loop.json': JSON.stringify({
        ...repoConfig,
        assurance: ['a', 'b', 'rules', 'assurance'].map((name) => ({
          path: `test/${name}.test.ts`,
          reason: '全候補をassuranceへ分類する対照',
        })),
      }),
    },
    async (f) => {
      await linkModules(f.repo);
      installed(f);
      const result = mutation(f, ['src/rules.ts']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('候補0件');
      expect(prepareCount(f)).toBe(0);
      expect(existsSync(join(f.repo, '.mutator'))).toBe(false);
    },
  );
}, 120000);

test('Vitestの導入先のpackage.jsonがGitのルートより下にあり、mutatorが親のディレクトリのnode_modulesにあれば最後まで走る', async () => {
  const nested = Object.fromEntries(
    Object.entries(vitestFiles)
      .filter(([path]) => path !== '.gitignore')
      .map(([path, body]) => [`workspace/${path}`, body]),
  );
  await fixture({ ...nested, '.gitignore': 'node_modules\n' }, async (root) => {
    await linkModules(root.repo);
    const f = { ...root, repo: join(root.repo, 'workspace') };
    installed(f);
    const result = mutation(f, ['src/rules.ts']);
    expect(result.code, result.output).toBe(0);
    expect(withoutKeys(listed(result.report, 'survived'))).toContainEqual(narrowingItem);
    expect(prepareCount(f)).toBe(1);
  });
}, 300000);
