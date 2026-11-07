import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, sync } from '../../../feedback-loop/build.ts';
import { isRecord } from '../../../shared/values.ts';
import { skillDir, skillSetup } from '../../support/feedback-loop-skill.ts';
import { files, fixture, run } from '../../support/feedback-loop-batch.ts';
import { git } from '../../support/runner-affected.ts';

test('スキルはgitとこのrepoのnode_modulesがない場所から起動できる', async () => {
  const dir = await skillDir();
  const git = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' });
  expect(git.status, 'スキルがGit checkout内にあります').not.toBe(0);
  expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  expect((await readdir(join(dir, 'scripts'))).sort()).toEqual([
    'record-modules.ts',
    'runtime.mjs',
    'setup.mjs',
    'source.json',
  ]);
});

test('スキルはapplyの完了表示が求めるAGENTS.mdの手順を同梱し、手順書間のリンクは同梱先で解決する', async () => {
  const files = await generate();
  expect(files.get('scripts/setup.mjs')).toContain('AGENTS.md');
  expect(files.get('references/agents-md.md')).toContain('## AGENTS.mdの節');

  const links = [...files]
    .filter(([path]) => path.startsWith('references/'))
    .flatMap(([path, body]) =>
      [...body.matchAll(/\]\(([\w-]+\.md)(?:#[^)]*)?\)/g)].map((match) => ({
        path,
        target: `references/${String(match[1])}`,
      })),
    );
  expect(links.map((link) => link.target)).toContain('references/codex.md');
  for (const { path, target } of links) {
    expect(files.has(target), `${path} -> ${target}`).toBe(true);
  }
});

test('手順書とこのrepoのcheck:feedbackは分類検査をテストの前に置き、指示はCLIが出す未完了の表示を指す', async () => {
  const plugin = await generate();
  const root = join(import.meta.dir, '../../../..');
  const stage = 'bun run check:classification > /dev/null && bun run test:affected';
  expect(plugin.get('references/contract.md')).toContain(stage);
  expect(await readFile(join(root, 'package.json'), 'utf8')).toContain(stage);

  const notice = '分類の確認記録が未完了です';
  expect(plugin.get('scripts/runtime.mjs')).toContain(notice);
  for (const path of [
    'AGENTS.md',
    'plugins/setup-feedback-loop/skills/setup-feedback-loop/references/agents-md.md',
  ]) {
    const body = await readFile(join(root, path), 'utf8');
    expect(body, path).toContain(notice);
    // check:feedbackはJSONを捨てるので、記録へ転記する値の取得元を指示に書く。
    expect(body, path).toContain('`bun run check:classification`が出力する`sha256`');
  }
});

test('スキルの手順はClaude CodeとCodexの接続先を案内し、READMEはCodexの導入コマンドを示す', async () => {
  const root = join(import.meta.dir, '../../../..');
  const skill = join(root, 'plugins/setup-feedback-loop/skills/setup-feedback-loop');
  const body = await readFile(join(skill, 'SKILL.md'), 'utf8');
  for (const reference of [
    'references/agents-md.md',
    'references/claude-code.md',
    'references/codex.md',
  ]) {
    expect(body).toContain(`](${reference})`);
    expect(existsSync(join(skill, reference)), reference).toBe(true);
  }
  const completion = body.slice(body.indexOf('## 完了と引き継ぎ'));
  expect(completion).toContain('`AGENTS.md`に[エージェントへの指示](references/agents-md.md)');
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

test('Bunのテスト一覧の手順は、bun testが実行したファイルと一覧の一致と食い違いを判定できる', async () => {
  const guide = await readFile(join(import.meta.dir, '../../../../references/collect.md'), 'utf8');
  const [list, compare] = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]);
  expect(list).toBeDefined();
  expect(compare).toBeDefined();
  const passing = "import { test } from 'bun:test'; test('ok', () => {});\n";
  await fixture(
    {
      'package.json': '{"private":true,"type":"module"}\n',
      'scripts/list-tests.ts': list ?? '',
      'compare-collect.ts': compare ?? '',
      'test/a.test.ts': passing,
      'test/nested/b_spec.ts': passing,
      'test/helper.ts': 'export const helper = 1;\n',
      'node_modules/pkg/c.test.ts': passing,
      'src/d.test.ts': passing,
    },
    async (f) => {
      const report = join(f.reports, 'junit.xml');
      const executed = run(f, [
        'test',
        './test',
        '--reporter=junit',
        `--reporter-outfile=${report}`,
      ]);
      expect(executed.code, executed.output).toBe(0);
      const listed = run(f, ['scripts/list-tests.ts', './test']);
      expect(JSON.parse(listed.stdout)).toEqual(['test/a.test.ts', 'test/nested/b_spec.ts']);
      const matched = run(f, [
        'compare-collect.ts',
        report,
        process.execPath,
        'scripts/list-tests.ts',
        './test',
      ]);
      expect(matched.code, matched.output).toBe(0);
      expect(JSON.parse(matched.stdout)).toEqual({ missing: [], extra: [] });
      const widened = run(f, [
        'compare-collect.ts',
        report,
        process.execPath,
        'scripts/list-tests.ts',
        '.',
      ]);
      expect(widened.code).toBe(1);
      expect(JSON.parse(widened.stdout)).toEqual({ missing: ['src/d.test.ts'], extra: [] });
    },
  );
});

test('旧入口の正本setup.tsを直接実行すると、生成したCLIへの移行を示してrepoを変更しない', async () => {
  const legacy = join(import.meta.dir, '../../../feedback-loop/setup.ts');
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
