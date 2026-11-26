import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { cancellationSignals } from '../src/command.ts';
import { improveTestsPath } from '../src/installed.ts';
import { versionAtLeast } from '../src/values.ts';
import { isRecord } from './support/json.ts';
import { mutatorVersion, pluginManifest, skillSetup } from './support/feedback-loop-skill.ts';
import { applyFeedback, files, fixture, run } from './support/feedback-loop-batch.ts';
import { cleanRecorderEnv, commitFixture, git } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

const repoRoot = resolve(import.meta.dir, '..');

function headingAnchors(markdown: string) {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    const heading = fenced ? null : /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const slug = String(heading[1])
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
        .replaceAll(' ', '-');
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
  }
  return anchors;
}

async function relativeLinks(file: string) {
  const body = await readFile(file, 'utf8');
  return [...body.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => String(match[1]))
    .filter((link) => !/^[a-z]+:/.test(link))
    .map((link) => {
      const [path = '', anchor] = link.split('#');
      return { file, link, target: path === '' ? file : join(dirname(file), path), anchor };
    });
}

test('見出しのアンカーは、GitHubと同じく小文字にして記号を除き、空白をハイフンにし、コードブロックの行を見出しにしない', () => {
  expect(
    headingAnchors(
      '# `check:affected`の「理由」 A・B\n```sh\n# コメント\n```\n## 同じ見出し\n## 同じ見出し\n',
    ),
  ).toEqual(new Set(['checkaffectedの理由-ab', '同じ見出し', '同じ見出し-1']));
});

const pluginSkills = join(repoRoot, 'plugins/setup-feedback-loop/skills');

async function skillDirectories() {
  const entries = await readdir(pluginSkills, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function frontmatterName(body: string) {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(body)?.[1] ?? '';
  return /^name:\s*(.+?)\s*$/m.exec(frontmatter)?.[1];
}

test('プラグインのスキルは、ディレクトリごとにSKILL.mdを持ち、frontmatterのnameがディレクトリの名前と一致する', async () => {
  const names = await skillDirectories();
  expect(names).toContain('improve-tests');
  expect(names).toContain('setup-feedback-loop');
  for (const name of names) {
    const file = join(pluginSkills, name, 'SKILL.md');
    expect(existsSync(file), `${name}/SKILL.md`).toBe(true);
    expect(frontmatterName(await readFile(file, 'utf8')), `${name}/SKILL.md`).toBe(name);
  }
});

test('improve-testsスキルが従わせる手順のパスは、applyが導入先へ置く改善の手順のパスと一致する', async () => {
  const body = await readFile(join(pluginSkills, 'improve-tests/SKILL.md'), 'utf8');
  const paths = [...body.matchAll(/`([^`]*improve-tests\.md)`/g)].map((match) => String(match[1]));
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    expect(path).toBe(improveTestsPath);
  }
});

test('手順書・SKILL.md・READMEのリンクは、正本でも同梱先でも、実在するファイルとその見出しを指す', async () => {
  const skill = join(pluginSkills, 'setup-feedback-loop');
  const sources = [
    ...(await readdir(join(repoRoot, 'references'))).map((name) =>
      join(repoRoot, 'references', name),
    ),
    ...(await readdir(join(skill, 'references'))).map((name) => join(skill, 'references', name)),
    ...(await skillDirectories()).map((name) => join(pluginSkills, name, 'SKILL.md')),
    join(repoRoot, 'README.md'),
  ];
  const links = (await Promise.all(sources.map(relativeLinks))).flat();
  expect(links.map((link) => relative(repoRoot, link.target))).toContain(
    'plugins/setup-feedback-loop/skills/setup-feedback-loop/references/agent-instructions.md',
  );
  for (const { file, link, target } of links) {
    expect(existsSync(target), `${relative(repoRoot, file)} -> ${link}`).toBe(true);
  }
  const anchored = links.filter((link) => link.anchor !== undefined);
  expect(anchored.length).toBeGreaterThan(0);
  const anchorsOf = new Map(
    await Promise.all(
      [...new Set(anchored.map((link) => link.target))].map(
        async (target) => [target, headingAnchors(await readFile(target, 'utf8'))] as const,
      ),
    ),
  );
  for (const { file, link, target, anchor } of anchored) {
    expect(
      anchorsOf.get(target)?.has(decodeURIComponent(String(anchor))),
      `${relative(repoRoot, file)} -> ${link}`,
    ).toBe(true);
  }
});

async function bundledReference(name: string) {
  return readFile(join(await skillSetup(), '../../references', name), 'utf8');
}

async function improveTestsProcedure() {
  return bundledReference('improve-tests.md');
}

async function mutationUsageForms() {
  const usage = spawnSync(
    process.execPath,
    [join(await skillSetup(), '../runtime.mjs'), 'mutation'],
    {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: cleanRecorderEnv(),
    },
  );
  expect(usage.status).toBe(1);
  const forms = [...usage.stderr.matchAll(/「(mutation [^」]+)」/g)].map((match) =>
    String(match[1]),
  );
  expect(forms, usage.stderr).toHaveLength(3);
  return forms;
}

function formPattern(form: string) {
  const pattern = form
    .split(/(<[^>]+>|\[|\])/)
    .map((part) => {
      if (part === '[') {
        return '(?:';
      }
      if (part === ']') {
        return ')?';
      }
      if (part.startsWith('<')) {
        return '(?!-)\\S+';
      }
      return part
        .replace(/[.*+?^${}()|\\]/g, '\\$&')
        .replace(/^\\\.\\\.\\\./, '(?: \\S+)*')
        .replace(/ $/, '(?: |$)');
    })
    .join('');
  return new RegExp(`^${pattern}$`);
}

test('導入先に置く改善の手順は、ほかの手順書へのリンクを持たず、mutationの呼び方がruntimeの使い方の表示と一致し、鍵を単一引用符で囲む', async () => {
  const procedure = await improveTestsProcedure();
  expect(procedure).toContain('# テストの改善の手順');
  expect(procedure).not.toMatch(/\]\((?!https:)[^)]*\)/);

  const forms = await mutationUsageForms();
  expect(procedure).toMatch(/--key '<[^>]+>'/);
  expect(procedure).not.toMatch(/--key <[^>]+>/);
  const unquoted = procedure.replaceAll(/'(<[^>]+>)'/g, '$1');
  for (const form of forms) {
    expect(unquoted).toContain(`\`${form.replaceAll(/ \[[^\]]+\]/g, '')}\``);
  }
  const written = [...procedure.matchAll(/`(mutation [^`]+)`/g)].map((match) => String(match[1]));
  for (const call of written) {
    expect(
      forms.some((form) => form === call || formPattern(form).test(call)),
      `runtimeの使い方の表示にない呼び方: ${call}`,
    ).toBe(true);
  }
});

function matchesForm(forms: string[], call: string) {
  return forms.some((form) => form === call || formPattern(form).test(call));
}

test('改善のコマンドの呼び方の表は、runtimeの使い方の表示のすべての形を書き、表示にない呼び方を書かない', async () => {
  const mutation = await bundledReference('mutation.md');
  const start = mutation.indexOf('## 改善のコマンド');
  expect(start).toBeGreaterThan(-1);
  const section = mutation.slice(start, mutation.indexOf('\n#', start + 1));
  const rows = [...section.matchAll(/^\| `(mutation [^`]+)` \|/gm)].map((match) =>
    String(match[1]),
  );
  expect(rows.length).toBeGreaterThan(0);
  const forms = await mutationUsageForms();
  for (const row of rows) {
    expect(matchesForm(forms, row), `runtimeの使い方の表示にない呼び方: ${row}`).toBe(true);
  }
  for (const form of forms) {
    expect(
      rows.some((row) => matchesForm([form], row)),
      `契約の呼び方の表にない使い方の形: ${form}`,
    ).toBe(true);
  }
});

test('契約で取消として受けるシグナルを並べた文は1つだけで、実行部とmutationが取消として受けるシグナルと一致する', async () => {
  const contract = await bundledReference('contract.md');
  const sentences = [...contract.matchAll(/取消として受けるシグナルは、([^。]+)です。/g)].map(
    (match) => String(match[1]),
  );
  expect(sentences).toHaveLength(1);
  expect(String(sentences[0]).split('・')).toEqual([...cancellationSignals]);
});

test('このrepoのcheck:feedbackは関連テストへ接続し、全体checkには分類検査を残す', async () => {
  const root = join(import.meta.dir, '..');
  const pkg: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert(isRecord(pkg) && isRecord(pkg.scripts));
  expect(pkg.scripts['check:feedback']).toEndWith('&& bun run check:affected');
  expect(pkg.scripts['check:feedback']).not.toContain('check:classification');
  expect(pkg.scripts.check).toContain('bun run check:classification');
});

test('スキルの手順はエージェントへの指示の手順書へリンクし、READMEは導入と更新のコマンドをmarketplaceの定義どおりに示す', async () => {
  const root = join(import.meta.dir, '..');
  const skill = join(root, 'plugins/setup-feedback-loop/skills/setup-feedback-loop');
  const body = await readFile(join(skill, 'SKILL.md'), 'utf8');
  expect(body).toContain('](references/agent-instructions.md)');
  expect(existsSync(join(skill, 'references/agent-instructions.md'))).toBe(true);
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

test('変更履歴の先頭のバージョンは、プラグインのバージョンと同じで、releaseへのリンクを持つ', async () => {
  const root = join(import.meta.dir, '..');
  const plugin = pluginManifest();
  const lines = (await readFile(join(root, 'CHANGELOG.md'), 'utf8')).split('\n');
  // バージョンの見出しは「## [0.4.0] - 2026-11-12」の形で、新しいバージョンを上に書く。
  const latest = lines.find((line) => line.startsWith('## '));
  expect(
    latest?.replace(/\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    `CHANGELOG.mdの先頭のバージョンの見出しを「## [${plugin.version}] - 日付」の形にし、このバージョンの変更を書いてください`,
  ).toBe(`## [${plugin.version}] - YYYY-MM-DD`);
  expect(
    lines,
    'CHANGELOG.mdの末尾に、このバージョンの見出しが指すreleaseへのリンクの定義を足してください',
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
  test(`バージョン${String(version)}は1.4.4以上の判定が${String(expected)}になる`, () => {
    expect(versionAtLeast(version, '1.4.4')).toBe(expected);
  });
}

test('Node.jsで起動すると、必要なバージョンと現在のバージョンを示してrepoを変更しない', async () => {
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
    expect(result.stdout).toContain('--package <oxlint|oxfmt|fallow>@<バージョン>');
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
    git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/trunk');
    expect(inspect()).toMatchObject({
      base: null,
      diagnostics: ['比較元を決められません。origin/HEADの指す先のorigin/trunkがありません'],
    });
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
    devDependencies: { '@mizchi/mutator': mutatorVersion },
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
        const classified = run(f, ['run', 'check:classification', '--json']);
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
      const classified = run(f, ['run', 'check:classification', '--json']);
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
      'feedback-loop未完了: 通常収集とtestGlobsの集合が一致しません\n収集にあってtestGlobsに当たらない: ["test/nested/f_spec.ts"]\n直し方: 上のパスがテストなら、.feedback-loop.jsonのtestGlobsへ、そのパスに当たるglobを足してください。globに当たるテストは、同じファイルのassuranceへ登録しなければqualityになります。テストでなければ、拡張子の前が.test・_test・.spec・_specにならない名前へ変えてください\n',
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
    expect(result.stderr).toContain(
      'setup-feedback-loop未完了: 比較のコマンドがJUnitを書かずに終わりました\n',
    );
  });
});

test('compare-testsは、比較のコマンドがシグナルで終わってJUnitが無いと、シグナルを示して非ゼロで終わる', async () => {
  const setup = await skillSetup();
  const killing =
    "import { test } from 'bun:test'; test('killed', () => { process.kill(process.pid, 'SIGKILL'); });\n";
  await fixture({ ...builtinFiles, 'test/a.test.ts': killing }, async (f) => {
    const result = compareTests(f, setup, ['./test/a.test.ts']);
    expect(result.code, result.output).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('コマンドがSIGKILLで終わりました\n');
    expect(result.stderr).toContain(
      'setup-feedback-loop未完了: 比較のコマンドがJUnitを書かずに終わりました\n',
    );
    expect(result.stderr).not.toContain('ENOENT');
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
    env: cleanRecorderEnv(),
  });
  return { code: result.status, stderr: result.stderr };
}

// AGENTS.mdの手順で生成物を作り、このcheckoutへ導入版を配置する。
function generateAndInstall(root: string) {
  const built = build(root);
  expect(built.code, built.stderr).toBe(0);
  const setup = join(
    root,
    'plugins/setup-feedback-loop/skills/setup-feedback-loop/scripts/setup.mjs',
  );
  const updated = spawnSync(process.execPath, [setup, 'apply', '--update', '--repo', root], {
    cwd: root,
    encoding: 'utf8',
    env: cleanRecorderEnv(),
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
