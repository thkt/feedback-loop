import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { versionAtLeast } from '../src/values.ts';
import { isRecord } from './support/json.ts';
import { skillSetup } from './support/feedback-loop-skill.ts';
import { applyFeedback, files, fixture, run } from './support/feedback-loop-batch.ts';
import { commitFixture, git } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

const repoRoot = resolve(import.meta.dir, '..');

test('スキルはapplyの完了表示が求めるAGENTS.mdの手順を同梱し、手順書間のリンクは同梱先で解決する', async () => {
  const skill = join(import.meta.dir, '../plugins/setup-feedback-loop/skills/setup-feedback-loop');
  const references = await readdir(join(skill, 'references'));
  const bundled = new Map<string, string>(
    await Promise.all(
      references.map(
        async (name) =>
          [`references/${name}`, await readFile(join(skill, 'references', name), 'utf8')] as const,
      ),
    ),
  );
  expect(bundled.get('references/agents.md')).toContain('## AGENTS.mdの節');

  const links = [...bundled]
    .filter(([path]) => path.startsWith('references/'))
    .flatMap(([path, body]) =>
      [...body.matchAll(/\]\(([\w-]+\.md)(?:#[^)]*)?\)/g)].map((match) => ({
        path,
        target: `references/${String(match[1])}`,
      })),
    );
  expect(links.map((link) => link.target)).toContain('references/agents.md');
  for (const { path, target } of links) {
    expect(bundled.has(target), `${path} -> ${target}`).toBe(true);
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

test('スキルの手順はClaude CodeとCodexの接続先を案内し、READMEは導入と更新のコマンドをmarketplaceの定義どおりに示す', async () => {
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
  const plugins: unknown[] = marketplace.plugins;
  const [plugin] = plugins;
  assert(isRecord(plugin));
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const id = `${String(plugin.name)}@${String(marketplace.name)}`;
  for (const command of [
    `claude plugin install ${id}`,
    `codex plugin add ${id}`,
    `claude plugin marketplace update ${String(marketplace.name)}`,
    `claude plugin update ${id}`,
    `codex plugin marketplace upgrade ${String(marketplace.name)}`,
  ]) {
    expect(readme).toContain(command);
  }
});

test('変更履歴の先頭の版は、プラグインの版と同じで、releaseへのリンクを持つ', async () => {
  const root = join(import.meta.dir, '..');
  const plugin: unknown = JSON.parse(
    await readFile(join(root, 'plugins/setup-feedback-loop/.claude-plugin/plugin.json'), 'utf8'),
  );
  assert(
    isRecord(plugin) && typeof plugin.version === 'string' && typeof plugin.repository === 'string',
    'plugin.jsonのversionとrepositoryを文字列で書いてください',
  );
  const lines = (await readFile(join(root, 'CHANGELOG.md'), 'utf8')).split('\n');
  // 版の見出しは「## [0.4.0] - 2026-11-12」の形で、新しい版を上に書く。
  const latest = lines.find((line) => line.startsWith('## '));
  expect(
    latest?.replace(/\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    `CHANGELOG.mdの先頭の版の見出しを「## [${plugin.version}] - 日付」の形にし、この版の変更を書いてください`,
  ).toBe(`## [${plugin.version}] - YYYY-MM-DD`);
  expect(
    lines,
    'CHANGELOG.mdの末尾に、この版の見出しが指すreleaseへのリンクの定義を足してください',
  ).toContain(`[${plugin.version}]: ${plugin.repository}/releases/tag/v${plugin.version}`);
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

for (const args of [['--help'], ['-h'], ['apply', '--help']]) {
  test(`「${args.join(' ')}」は操作と引数の一覧を表示して終了0になり、repoを要求しない`, async () => {
    const setup = await skillSetup();
    const result = spawnSync(process.execPath, [setup, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toStartWith('使い方: bun setup.mjs <操作> --repo ');
    expect(result.stdout).toMatch(/^  inspect /m);
    expect(result.stdout).toMatch(/^  install /m);
    expect(result.stdout).toMatch(/^  apply /m);
    expect(result.stdout).toMatch(/^  compare-tests /m);
    expect(result.stdout).toContain('--package <oxlint|oxfmt|fallow>@<版>');
    expect(result.stdout).toContain('--feedback-command <check:feedbackに設定する診断用コマンド>');
    expect(result.stderr).toBe('');
  });
}

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

test('collectを省略すると、testGlobsに合わない名前のテストも拾い、分類検査を止める', async () => {
  await fixture(builtinFiles, async (f) => {
    expect(applyFeedback(f, 'bun run check:affected').code).toBe(0);
    await writeFile(join(f.repo, 'test/nested/f_spec.ts'), passing);
    const result = run(f, ['run', 'check:classification']);
    expect(result.code, result.output).toBe(1);
    expect(result.stderr).toContain(
      'feedback-loop未完了: 通常収集とtestGlobsの集合が一致しません\n収集にあってtestGlobsに当たらない: ["test/nested/f_spec.ts"]\n',
    );
  });
});

function compareTests(f: Fixture, setup: string, paths: string[]) {
  return run(f, [setup, 'compare-tests', '--repo', f.repo, '--', 'bun', 'test', ...paths]);
}

for (const { scenario, paths, missing, extra, code, additions } of [
  { scenario: 'matched', paths: ['./test'], missing: [], extra: [], code: 0, additions: {} },
  {
    scenario: 'missing',
    paths: ['./test/a.test.ts'],
    missing: ['test/nested/b.test.ts'],
    extra: [],
    code: 1,
    additions: {},
  },
  {
    scenario: 'extra',
    paths: ['./test', './src'],
    missing: [],
    extra: ['src/e.test.ts'],
    code: 1,
    additions: {},
  },
  {
    scenario: 'empty',
    paths: ['./test'],
    missing: ['test/empty.test.ts'],
    extra: [],
    code: 1,
    additions: { 'test/empty.test.ts': 'export const empty = 1;\n' },
  },
]) {
  test(`compare-testsは通常checkの実行ファイルと一覧を照合する: ${scenario}`, async () => {
    const setup = await skillSetup();
    await fixture({ ...builtinFiles, ...additions }, async (f) => {
      const result = compareTests(f, setup, paths);
      expect(result.code, result.output).toBe(code);
      expect(JSON.parse(result.stdout)).toEqual({ missing, extra });
    });
  });
}

test('compare-testsはテストが失敗しても、実行したファイルと一覧を照合し、失敗の出力を表示する', async () => {
  const setup = await skillSetup();
  const failing =
    "import { test } from 'bun:test'; test('failed', () => { throw new Error('EXPECTED_FAILURE'); });\n";
  await fixture({ ...builtinFiles, 'test/a.test.ts': failing }, async (f) => {
    const result = compareTests(f, setup, ['./test']);
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ missing: [], extra: [] });
    expect(result.stderr).toContain('EXPECTED_FAILURE');
  });
});

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

// build.tsは、自身を置いたcheckoutを正本と生成先にする。このrepoを書き換えないよう、作業ツリーの写しで起動する。
async function buildCheckout(body: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-loop-build-')));
  try {
    // 無視されていないファイルをすべて写す。作業ツリーで消した追跡済みのファイルは除く。
    // gitは、未追跡の入れ子のrepoを/で終わるディレクトリとして返す。build.tsは読まないので除く。
    const paths = git(repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
      .split('\0')
      .filter((path) => path !== '' && !path.endsWith('/') && existsSync(join(repoRoot, path)));
    await Promise.all(paths.map((path) => cp(join(repoRoot, path), join(root, path))));
    git(root, 'init', '-b', 'main');
    // apply --updateは、gitが変更なしと見るファイルだけを置き換える。
    commitFixture(root, 'copy');
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function build(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/build.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return { code: result.status, stderr: result.stderr };
}

// AGENTS.mdの手順で生成物を作り、このcheckoutへ導入版を配置する。
function generateAndInstall(root: string) {
  expect(build(root).code).toBe(0);
  const setup = join(
    root,
    'plugins/setup-feedback-loop/skills/setup-feedback-loop/scripts/setup.mjs',
  );
  const updated = spawnSync(process.execPath, [setup, 'apply', '--update', '--repo', root], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(updated.status, updated.stdout + updated.stderr).toBe(0);
}

const skillPath = 'plugins/setup-feedback-loop/skills/setup-feedback-loop';

test('生成物が正本と食い違うと、checkは書き換えずに食い違いと余分なファイルを示して失敗する', async () => {
  await buildCheckout(async (root) => {
    generateAndInstall(root);
    expect(build(root, '--check')).toEqual({ code: 0, stderr: '' });

    await writeFile(join(root, skillPath, 'scripts/runtime.mjs'), '// 手で編集した\n');
    await writeFile(join(root, skillPath, 'references/tools.md'), '手で編集した\n');
    await writeFile(join(root, skillPath, 'scripts/extra.mjs'), '\n');
    await writeFile(join(root, skillPath, 'references/collect.md'), '<!-- 生成元 -->\n');
    const checked = build(root, '--check');
    expect(checked.code).toBe(1);
    const checkedLines = checked.stderr.split('\n');
    expect(checkedLines).toContain('正本と食い違う生成物: scripts/runtime.mjs');
    expect(checkedLines).toContain('正本と食い違う生成物: references/tools.md');
    expect(checkedLines).toContain('生成対象外のファイル: scripts/extra.mjs');
    expect(checkedLines).toContain('生成対象外のファイル: references/collect.md');
    expect(checkedLines).toContain(
      '生成物が正本と一致しません。bun run build:feedback-loopで再生成してください',
    );
    expect(await readFile(join(root, skillPath, 'scripts/runtime.mjs'), 'utf8')).toBe(
      '// 手で編集した\n',
    );

    // 再生成は、正本から外れたreferences/を消し、scripts/の余分なファイルは報告だけする。
    const regenerated = build(root);
    expect(regenerated.code).toBe(1);
    expect(regenerated.stderr.split('\n')).toContain('生成対象外のファイル: scripts/extra.mjs');
    expect(existsSync(join(root, skillPath, 'references/collect.md'))).toBe(false);
  });
});

test('導入版が生成物と食い違うと、checkは食い違うパスと更新のコマンドを示して失敗する', async () => {
  await buildCheckout(async (root) => {
    generateAndInstall(root);
    await writeFile(join(root, 'scripts/feedback-loop/runtime.mjs'), '// 手で編集した\n');
    await rm(join(root, 'scripts/feedback-loop/record-modules.ts'));
    const checked = build(root, '--check');
    expect(checked.code).toBe(1);
    const checkedLines = checked.stderr.split('\n');
    expect(checkedLines).toContain('生成物と食い違う導入版: scripts/feedback-loop/runtime.mjs');
    expect(checkedLines).toContain(
      '生成物と食い違う導入版: scripts/feedback-loop/record-modules.ts',
    );
    expect(checkedLines).toContain(
      `導入版を更新してください: bun ${skillPath}/scripts/setup.mjs apply --update --repo ${root}`,
    );
  });
});
