import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleInstalled, sync } from '../scripts/build.ts';
import { isRecord, versionAtLeast } from '../src/values.ts';
import { skillDir, skillSetup } from './support/feedback-loop-skill.ts';
import { applyFeedback, files, fixture, run } from './support/feedback-loop-batch.ts';
import { git } from './support/runner-affected.ts';

test('テストが使うスキルはGit checkoutの外にあり、node_modulesを持たない', async () => {
  const dir = await skillDir();
  const git = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' });
  expect(git.status, 'スキルがGit checkout内にあります').not.toBe(0);
  expect(existsSync(join(dir, 'node_modules'))).toBe(false);
});

test('スキルはapplyの完了表示が求めるAGENTS.mdの手順を同梱し、手順書間のリンクは同梱先で解決する', async () => {
  const skill = join(import.meta.dir, '../plugins/setup-feedback-loop/skills/setup-feedback-loop');
  const references = await readdir(join(skill, 'references'));
  const files = new Map<string, string>(
    await Promise.all(
      references.map(
        async (name) =>
          [`references/${name}`, await readFile(join(skill, 'references', name), 'utf8')] as const,
      ),
    ),
  );
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
  const root = join(import.meta.dir, '..');
  const pkg: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert(isRecord(pkg) && isRecord(pkg.scripts));
  expect(pkg.scripts['check:feedback']).toEndWith('&& bun run check:affected');
  expect(pkg.scripts['check:feedback']).not.toContain('check:classification');
  expect(pkg.scripts.check).toContain('bun run check:classification');
  expect(
    await readFile(
      join(root, 'plugins/setup-feedback-loop/skills/setup-feedback-loop/references/contract.md'),
      'utf8',
    ),
  ).toContain(
    "--feedback-command 'bun run lint:feedback && bun run format:feedback && bun run check:unused && bun run check:affected'",
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

test('プラグインの版と同じ版の見出しが、変更履歴にある', async () => {
  const root = join(import.meta.dir, '..');
  const plugin: unknown = JSON.parse(
    await readFile(join(root, 'plugins/setup-feedback-loop/.claude-plugin/plugin.json'), 'utf8'),
  );
  assert(isRecord(plugin) && typeof plugin.version === 'string');
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  // 「## [0.4.0] - 2026-11-12」の形の見出しから版を取り出す。
  const versions = [...changelog.matchAll(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/gm)].map(
    (match) => match[1],
  );
  expect(
    versions,
    `CHANGELOG.mdに「## [${plugin.version}] - YYYY-MM-DD」の見出しを足し、この版の変更を書いてください`,
  ).toContain(plugin.version);
});

for (const { version, expected } of [
  { version: '1.4.3', expected: false },
  { version: '1.4.4', expected: true },
  { version: '1.4.5', expected: true },
  { version: '1.10.0', expected: true },
  { version: '2.0.0', expected: true },
  { version: '0.9.9', expected: false },
  { version: '1.5.0-canary.1', expected: true },
  { version: undefined, expected: false },
  { version: 'unknown', expected: false },
]) {
  test(`版${String(version)}は1.4.4以上の判定が${String(expected)}になる`, () => {
    expect(versionAtLeast(version, '1.4.4')).toBe(expected);
  });
}

test('Node.jsで起動すると、必要な版と現在の版を示してrepoを変更しない', async () => {
  const setup = await skillSetup();
  await fixture(files, async (f) => {
    const result = spawnSync(
      'node',
      [setup, 'apply', '--repo', f.repo, '--feedback-command', 'bun run check:affected'],
      { encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Bun 1.4.4以上で起動してください（現在: Node.js');
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

test('inspectは比較元の候補を既定ブランチから示し、決められなければnullと、決められない理由を返す', async () => {
  const setup = await skillSetup();
  await fixture(files, async (f) => {
    const inspect = (): unknown => {
      const result = run(f, [setup, 'inspect', '--repo', f.repo]);
      expect(result.code, result.output).toBe(0);
      return JSON.parse(result.stdout);
    };
    git(f.repo, 'checkout', '-b', 'work');
    git(f.repo, 'branch', '-D', 'main');
    expect(inspect()).toMatchObject({
      base: null,
      diagnostics: ['比較元を決められません。origin/HEADがなく、mainもmasterもありません'],
    });
    git(f.repo, 'branch', 'master');
    expect(inspect()).toMatchObject({ base: 'master', diagnostics: [] });
    git(f.repo, 'branch', 'main');
    expect(inspect()).toMatchObject({
      base: null,
      diagnostics: ['比較元を決められません。mainとmasterの両方があります'],
    });
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(f.repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    expect(inspect()).toMatchObject({
      base: null,
      diagnostics: ['比較元を決められません。origin/mainとorigin/masterの両方があります'],
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

for (const { testGlobs, expected, candidateCount } of [
  {
    testGlobs: ['test/**/*.test.ts', 'test/nested/*_spec.ts', 'test/*.test.ts'],
    expected: ['test/a.test.ts', 'test/nested/b.test.ts', 'test/nested/f_spec.ts'],
    candidateCount: 'quality候補: 3件',
  },
  {
    testGlobs: ['**/*.test.ts', '**/*_spec.ts'],
    expected: ['src/e.test.ts', 'test/a.test.ts', 'test/nested/b.test.ts', 'test/nested/f_spec.ts'],
    candidateCount: 'quality候補: 4件',
  },
  {
    testGlobs: ['test/nested/*.test.ts', 'test/nested/*_spec.ts'],
    expected: ['test/nested/b.test.ts', 'test/nested/f_spec.ts'],
    candidateCount: 'quality候補: 2件',
  },
]) {
  test(`collectを省略すると、testGlobsの探索場所をまとめて調べ、除外ディレクトリを数えない: ${testGlobs.join(', ')}`, async () => {
    await fixture(
      {
        ...builtinFiles,
        '.feedback-loop.json': JSON.stringify({ ...builtinConfig, testGlobs }),
        'test/nested/f_spec.ts': passing,
      },
      async (f) => {
        const applied = applyFeedback(f, 'bun run check:affected');
        expect(applied.code, applied.output).toBe(0);
        const classified = run(f, ['run', 'check:classification']);
        expect(classified.code, classified.output).toBe(0);
        expect(JSON.parse(classified.stdout)).toEqual({
          all: expected,
          quality: expected,
          assurance: [],
        });
        const affected = run(f, ['run', 'check:affected']);
        expect(affected.code, affected.output).toBe(0);
        expect(affected.output).toContain(candidateCount);
      },
    );
  });
}

test('collectを省略すると、4つの名前と8つの拡張子のテストを収集する', async () => {
  const paths = [
    'test/a.spec.cjs',
    'test/a.spec.cts',
    'test/a.spec.js',
    'test/a.spec.jsx',
    'test/a.spec.mjs',
    'test/a.spec.mts',
    'test/a.spec.ts',
    'test/a.spec.tsx',
    'test/a.test.cjs',
    'test/a.test.cts',
    'test/a.test.js',
    'test/a.test.jsx',
    'test/a.test.mjs',
    'test/a.test.mts',
    'test/a.test.ts',
    'test/a.test.tsx',
    'test/a_spec.cjs',
    'test/a_spec.cts',
    'test/a_spec.js',
    'test/a_spec.jsx',
    'test/a_spec.mjs',
    'test/a_spec.mts',
    'test/a_spec.ts',
    'test/a_spec.tsx',
    'test/a_test.cjs',
    'test/a_test.cts',
    'test/a_test.js',
    'test/a_test.jsx',
    'test/a_test.mjs',
    'test/a_test.mts',
    'test/a_test.ts',
    'test/a_test.tsx',
  ];
  const setup = await skillSetup();
  await fixture(
    {
      'package.json': builtinFiles['package.json'],
      '.feedback-loop.json': JSON.stringify({
        ...builtinConfig,
        testGlobs: ['test/*.test.*', 'test/*_test.*', 'test/*.spec.*', 'test/*_spec.*'],
      }),
      ...Object.fromEntries(paths.map((path) => [path, passing])),
      'test/helper.ts': 'export const helper = 1;\n',
    },
    async (f) => {
      const applied = applyFeedback(f, 'bun run check:affected');
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

test('collectを省略すると、testGlobsに合わない名前のテストも拾い、分類と関連実行を止める', async () => {
  await fixture(builtinFiles, async (f) => {
    expect(applyFeedback(f, 'bun run check:affected').code).toBe(0);
    await writeFile(join(f.repo, 'test/nested/f_spec.ts'), passing);
    for (const script of ['check:classification', 'check:affected']) {
      const result = run(f, ['run', script]);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('testGlobsの集合が一致しません');
      expect(result.output).toContain(
        '収集にあってtestGlobsに当たらない: ["test/nested/f_spec.ts"]',
      );
    }
  });
});

for (const { scenario, paths, missing, extra, code, additions, diagnostics } of [
  {
    scenario: 'matched',
    paths: ['./test'],
    missing: [],
    extra: [],
    code: 0,
    additions: {},
    diagnostics: [],
  },
  {
    scenario: 'missing',
    additions: {},
    diagnostics: [],
    paths: ['./test/a.test.ts'],
    missing: ['test/nested/b.test.ts'],
    extra: [],
    code: 1,
  },
  {
    scenario: 'extra',
    paths: ['./test', './src'],
    missing: [],
    extra: ['src/e.test.ts'],
    code: 1,
    additions: {},
    diagnostics: [],
  },
  {
    scenario: 'failed',
    paths: ['./test'],
    missing: [],
    extra: [],
    code: 0,
    additions: {
      'test/a.test.ts':
        "import { test } from 'bun:test'; test('failed', () => { throw new Error('EXPECTED_FAILURE'); });\n",
    },
    diagnostics: ['EXPECTED_FAILURE'],
  },
  {
    scenario: 'empty',
    paths: ['./test'],
    missing: ['test/empty.test.ts'],
    extra: [],
    code: 1,
    additions: { 'test/empty.test.ts': 'export const empty = 1;\n' },
    diagnostics: [],
  },
]) {
  test(`compare-testsは通常checkの実行ファイルと一覧を照合する: ${scenario}`, async () => {
    const setup = await skillSetup();
    await fixture({ ...builtinFiles, ...additions }, async (f) => {
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
      for (const diagnostic of diagnostics) {
        expect(result.stderr).toContain(diagnostic);
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

test('applyが配置した導入版は生成物と一致し、手で編集すると食い違いとして検出する', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected');
    expect(applied.code, applied.output).toBe(0);
    expect(await staleInstalled(f.repo)).toEqual([]);
    await writeFile(join(f.repo, 'scripts/feedback-loop/runtime.mjs'), '// 手で編集した\n');
    await rm(join(f.repo, 'scripts/feedback-loop/record-modules.ts'));
    expect(await staleInstalled(f.repo)).toEqual([
      'scripts/feedback-loop/runtime.mjs',
      'scripts/feedback-loop/record-modules.ts',
    ]);
  });
});
