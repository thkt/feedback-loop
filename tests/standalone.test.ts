import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, sync } from '../scripts/feedback-loop/build.ts';
import { isRecord } from '../scripts/shared/values.ts';
import { skillDir, skillSetup } from './support/feedback-loop-skill.ts';
import { applyFeedback, files, fixture, run } from './support/feedback-loop-batch.ts';
import { git } from './support/runner-affected.ts';

test('スキルはgitとこのrepoのnode_modulesがない場所から起動できる', async () => {
  const dir = await skillDir();
  const git = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' });
  expect(git.status, 'スキルがGit checkout内にあります').not.toBe(0);
  expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  expect((await readdir(join(dir, 'scripts'))).sort()).toEqual([
    'record-modules.ts',
    'runtime.mjs',
    'setup.mjs',
  ]);
});

test('スキルはapplyの完了表示が求めるAGENTS.mdの手順を同梱し、手順書間のリンクは同梱先で解決する', async () => {
  const files = await generate();
  expect([...files.keys()].filter((path) => path.startsWith('references/')).sort()).toEqual([
    'references/agents.md',
    'references/contract.md',
    'references/runners.md',
    'references/tools.md',
  ]);
  expect(files.get('references/agents.md')).toContain('## AGENTS.mdの節');

  const links = [...files]
    .filter(([path]) => path.startsWith('references/'))
    .flatMap(([path, body]) =>
      [...body.matchAll(/\]\(([\w-]+\.md)(?:#[^)]*)?\)/g)].map((match) => ({
        path,
        target: `references/${String(match[1])}`,
      })),
    );
  expect(links.map((link) => link.target)).toContain('references/agents.md');
  for (const { path, target } of links) {
    expect(files.has(target), `${path} -> ${target}`).toBe(true);
  }
});

test('手順書とこのrepoのcheck:feedbackは関連テストへ接続し、全体checkには分類検査を残す', async () => {
  const plugin = await generate();
  const root = join(import.meta.dir, '..');
  const pkg: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert(isRecord(pkg) && isRecord(pkg.scripts));
  expect(pkg.scripts['check:feedback']).toEndWith('&& bun run test:affected');
  expect(pkg.scripts['check:feedback']).not.toContain('check:classification');
  expect(pkg.scripts.check).toContain('bun run check:classification');
  expect(plugin.get('references/contract.md')).toContain(
    "--feedback-command 'bun run lint:feedback && bun run format:feedback && bun run check:unused && bun run test:affected'",
  );
});

test('スキルの手順はClaude CodeとCodexの接続先を案内し、READMEはCodexの導入コマンドを示す', async () => {
  const root = join(import.meta.dir, '..');
  const skill = join(root, 'plugins/setup-feedback-loop/skills/setup-feedback-loop');
  const body = await readFile(join(skill, 'SKILL.md'), 'utf8');
  expect(body).toContain('](references/agents.md)');
  expect(existsSync(join(skill, 'references/agents.md'))).toBe(true);
  const completion = body.slice(body.indexOf('## 完了と引き継ぎ'));
  expect(completion).toContain('`AGENTS.md`に[エージェントへの指示](references/agents.md)');
  expect(completion).toContain('`@AGENTS.md`');
  const marketplace: unknown = JSON.parse(
    await readFile(join(root, '.claude-plugin/marketplace.json'), 'utf8'),
  );
  assert(isRecord(marketplace) && Array.isArray(marketplace.plugins));
  const [plugin] = marketplace.plugins as unknown[];
  assert(isRecord(plugin));
  expect(await readFile(join(root, 'README.md'), 'utf8')).toContain(
    `codex plugin add ${String(plugin.name)}@${String(marketplace.name)}`,
  );
});

test('Bun 1.4.4以外で起動すると、版の不一致を示してrepoを変更しない', async () => {
  const setup = await skillSetup();
  await fixture(files, async (f) => {
    const result = spawnSync('node', [setup, 'inspect', '--repo', f.repo], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Bun 1.4.4で起動してください（現在: Node.js');
    expect(existsSync(join(f.repo, 'scripts/feedback-loop'))).toBe(false);
  });
});

test('--helpは操作と引数の一覧を表示して終了0になり、repoを要求しない', async () => {
  const setup = await skillSetup();
  for (const args of [['--help'], ['-h'], ['apply', '--help']]) {
    const result = spawnSync(process.execPath, [setup, ...args], { encoding: 'utf8' });
    expect(result.status, `${args.join(' ')}\n${result.stderr}`).toBe(0);
    for (const word of [
      'inspect',
      'install',
      'apply',
      '--repo',
      '--package',
      '--feedback-command',
    ]) {
      expect(result.stdout).toContain(word);
    }
    expect(result.stderr).toBe('');
  }
});

test('inspectは比較元の候補を既定ブランチから示し、決められなければnullと診断を返す', async () => {
  const setup = await skillSetup();
  await fixture(files, async (f) => {
    const inspect = (): unknown => {
      const result = run(f, [setup, 'inspect', '--repo', f.repo]);
      expect(result.code, result.output).toBe(0);
      return JSON.parse(result.stdout);
    };
    git(f.repo, 'branch', '-m', 'master');
    expect(inspect()).toMatchObject({ base: 'master', diagnostics: [] });
    git(f.repo, 'branch', 'main');
    expect(inspect()).toMatchObject({
      base: null,
      diagnostics: [expect.stringContaining('比較元')],
    });
    git(f.repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect(inspect()).toMatchObject({ base: 'origin/trunk', diagnostics: [] });
  });
});

const passing = "import { test } from 'bun:test'; test('ok', () => {});\n";
const builtinConfig = { runner: 'bun', base: 'main', testGlobs: ['test/**/*.test.ts'] };
const builtinFiles = {
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'bun@1.4.4',
    scripts: { check: 'bun test ./test' },
  }),
  '.feedback-loop.json': JSON.stringify(builtinConfig),
  'test/a.test.ts': passing,
  'test/nested/b.test.ts': passing,
  'test/helper.ts': 'export const helper = 1;\n',
  'test/node_modules/pkg/c.test.ts': passing,
  'test/.hidden/d.test.ts': passing,
  'src/e.test.ts': passing,
};

for (const testGlobs of [
  ['test/**/*.test.ts', 'test/nested/*_spec.ts', 'test/*.test.ts'],
  ['**/*.test.ts', '**/*_spec.ts'],
  ['test/nested/*.test.ts', 'test/nested/*_spec.ts'],
]) {
  test(`Bunの内蔵一覧は探索場所をまとめ、除外ディレクトリを数えない: ${testGlobs.join(', ')}`, async () => {
    await fixture(
      {
        ...builtinFiles,
        '.feedback-loop.json': JSON.stringify({ ...builtinConfig, testGlobs }),
        'test/nested/f_spec.ts': passing,
      },
      async (f) => {
        const applied = applyFeedback(f, 'bun run test:affected');
        expect(applied.code, applied.output).toBe(0);
        const classified = run(f, ['run', 'check:classification']);
        expect(classified.code, classified.output).toBe(0);
        const expected = ['test/nested/b.test.ts', 'test/nested/f_spec.ts'];
        if (!testGlobs[0]?.startsWith('test/nested/')) {
          expected.push('test/a.test.ts');
        }
        if (testGlobs[0]?.startsWith('**/')) {
          expected.push('src/e.test.ts');
        }
        expect(JSON.parse(classified.stdout)).toEqual({
          all: expected.sort(),
          quality: expected.sort(),
          assurance: [],
        });
        const affected = run(f, ['run', 'test:affected']);
        expect(affected.code, affected.output).toBe(0);
        expect(affected.output).toContain(`quality候補: ${expected.length}件`);
      },
    );
  });
}

test('Bunの内蔵一覧は4つの名前と8つの拡張子を収集する', async () => {
  const paths = ['.test', '_test', '.spec', '_spec']
    .flatMap((suffix) =>
      ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'].map((ext) => `test/a${suffix}.${ext}`),
    )
    .sort();
  const setup = await skillSetup();
  await fixture(
    {
      'package.json': builtinFiles['package.json'],
      '.feedback-loop.json': JSON.stringify({ ...builtinConfig, testGlobs: ['test/*'] }),
      ...Object.fromEntries(paths.map((path) => [path, passing])),
    },
    async (f) => {
      const applied = applyFeedback(f, 'bun run test:affected');
      expect(applied.code, applied.output).toBe(0);
      const classified = run(f, ['run', 'check:classification']);
      expect(classified.code, classified.output).toBe(0);
      expect(JSON.parse(classified.stdout)).toEqual({ all: paths, quality: paths, assurance: [] });
      const compared = run(f, [
        setup,
        'compare-tests',
        '--repo',
        f.repo,
        '--',
        'bun',
        'test',
        './test',
      ]);
      expect(compared.code, compared.output).toBe(0);
      expect(JSON.parse(compared.stdout)).toEqual({ missing: [], extra: [] });
    },
  );
});

test('Bunの内蔵一覧はtestGlobsに合わない名前も拾い、分類と関連実行を止める', async () => {
  await fixture(builtinFiles, async (f) => {
    expect(applyFeedback(f, 'bun run test:affected').code).toBe(0);
    await writeFile(join(f.repo, 'test/nested/f_spec.ts'), passing);
    for (const script of ['check:classification', 'test:affected']) {
      const result = run(f, ['run', script]);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('testGlobsの集合が一致しません');
      expect(result.output).toContain('test/nested/f_spec.ts');
    }
  });
});

for (const { scenario, paths, missing, extra, code, replacement } of [
  { scenario: 'matched', paths: ['./test'], missing: [], extra: [], code: 0 },
  {
    scenario: 'missing',
    paths: ['./test/a.test.ts'],
    missing: ['test/nested/b.test.ts'],
    extra: [],
    code: 1,
  },
  { scenario: 'extra', paths: ['./test', './src'], missing: [], extra: ['src/e.test.ts'], code: 1 },
  {
    scenario: 'failed',
    paths: ['./test'],
    missing: [],
    extra: [],
    code: 0,
    replacement:
      "import { test } from 'bun:test'; test('failed', () => { throw new Error('EXPECTED_FAILURE'); });\n",
  },
  { scenario: 'empty', paths: ['./test'], missing: ['test/empty.test.ts'], extra: [], code: 1 },
]) {
  test(`compare-testsは通常checkの実行ファイルと一覧を照合する: ${scenario}`, async () => {
    const setup = await skillSetup();
    await fixture(builtinFiles, async (f) => {
      if (replacement) {
        await writeFile(join(f.repo, 'test/a.test.ts'), replacement);
      }
      if (scenario === 'empty') {
        await writeFile(join(f.repo, 'test/empty.test.ts'), 'export const empty = 1;\n');
      }
      const result = run(f, [
        setup,
        'compare-tests',
        '--repo',
        f.repo,
        '--',
        'bun',
        'test',
        ...paths,
      ]);
      expect(result.code, result.output).toBe(code);
      expect(JSON.parse(result.stdout)).toEqual({ missing, extra });
      if (scenario === 'failed') {
        expect(result.stderr).toContain('EXPECTED_FAILURE');
      }
    });
  });
}

test('compare-testsはJUnitが出ない実行失敗を照合成功にしない', async () => {
  const setup = await skillSetup();
  await fixture(builtinFiles, async (f) => {
    const result = run(f, [
      setup,
      'compare-tests',
      '--repo',
      f.repo,
      '--',
      'bun',
      'test',
      '--timeout',
      'invalid',
    ]);
    expect(result.code, result.output).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('setup-feedback-loop未完了:');
  });
});

test('旧入口の正本setup.tsを直接実行すると、生成したCLIへの移行を示してrepoを変更しない', async () => {
  const legacy = join(import.meta.dir, '../scripts/feedback-loop/setup.ts');
  await fixture(files, async (f) => {
    const result = run(f, [legacy, 'inspect', '--repo', f.repo]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'plugins/setup-feedback-loop/skills/setup-feedback-loop/scripts/setup.mjs',
    );
    expect(existsSync(join(f.repo, 'scripts/feedback-loop'))).toBe(false);
  });
});

test('生成先が正本と食い違うと、checkは書き換えずに食い違いと余分なファイルを返す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feedback-loop-generated-'));
  try {
    expect((await sync(root, false)).stale).toContain('scripts/runtime.mjs');
    expect(await sync(root, true)).toEqual({ stale: [], extra: [] });
    await writeFile(
      join(root, 'references/collect.md'),
      '<!-- 生成元: references/collect.md -->\n',
    );
    expect((await sync(root, true)).extra).toEqual(['references/collect.md']);
    await sync(root, false);
    expect(existsSync(join(root, 'references/collect.md'))).toBe(false);
    await writeFile(join(root, 'scripts/runtime.mjs'), '// 手で編集した\n');
    await writeFile(join(root, 'references/tools.md'), '手で編集した\n');
    await writeFile(join(root, 'scripts/extra.mjs'), '\n');
    expect(await sync(root, true)).toEqual({
      stale: ['scripts/runtime.mjs', 'references/tools.md'],
      extra: ['scripts/extra.mjs'],
    });
    expect(await readFile(join(root, 'scripts/runtime.mjs'), 'utf8')).toBe('// 手で編集した\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
