import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from './support/json.ts';
import {
  cliConfig,
  cliFiles,
  fixture,
  runSetup as run,
  setup,
  snapshot,
} from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { baseEnv, commitFixture, git } from './support/runner-affected.ts';
import { vitestConfig, vitestHeader, vitestModules } from './support/vitest.ts';

// Gitのルートにはscriptsのないpackage.jsonだけがあり、導入先のpackageはworkspace/にある。
function nested(files: Record<string, string>, directory = 'workspace') {
  return {
    'package.json': '{"private":true}\n',
    'CLAUDE.md': '# Claude\n',
    'eslint.config.js': 'export default [];\n',
    '.github/workflows/ci.yml': 'name: CI\n',
    'other/file.txt': 'outside\n',
    ...Object.fromEntries(
      Object.entries(files).map(([path, body]) => [`${directory}/${path}`, body]),
    ),
  };
}

function inWorkspace(f: Fixture, directory = 'workspace'): Fixture {
  return { ...f, repo: join(f.repo, directory) };
}

function apply(f: Fixture, manager: string, directory = 'workspace') {
  const result = run(f, [
    setup,
    'apply',
    '--repo',
    join(f.repo, directory),
    '--feedback-command',
    `${manager} run check:affected`,
  ]);
  expect(result.code, result.output).toBe(0);
}

test('inspectはGitのルートより下のpackageを調べ、設定ファイルとCI定義をGitのルートからも返す', async () => {
  await fixture(nested(cliFiles), async (f) => {
    const before = await snapshot(f.repo);
    const result = run(f, [setup, 'inspect', '--repo', join(f.repo, 'workspace')]);
    expect(result.code, result.output).toBe(0);
    const report: unknown = JSON.parse(result.stdout);
    assert(isRecord(report) && Array.isArray(report.configFiles));
    expect(report).toMatchObject({
      packageManager: 'bun',
      scripts: { check: 'bun test test' },
    });
    expect(report.configFiles).toContain('../.github/workflows/ci.yml');
    expect(report.configFiles).toContain('../eslint.config.js');
    expect(report.configFiles).toContain('.feedback-loop.json');
    expect(await snapshot(f.repo)).toEqual(before);
  });
});

test('applyは補助ファイルをpackageのディレクトリへ、エージェントの指示をGitのルートへ置く', async () => {
  await fixture(nested(cliFiles), async (f) => {
    const rootPackage = await readFile(join(f.repo, 'package.json'), 'utf8');
    apply(f, 'bun');
    expect(existsSync(join(f.repo, 'workspace/scripts/feedback-loop/runtime.mjs'))).toBe(true);
    expect(existsSync(join(f.repo, 'scripts'))).toBe(false);
    expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(rootPackage);
    const pkg: unknown = JSON.parse(await readFile(join(f.repo, 'workspace/package.json'), 'utf8'));
    assert(isRecord(pkg) && isRecord(pkg.scripts));
    expect(pkg.scripts['check:feedback']).toBe('bun run check:affected');
    expect(await readFile(join(f.repo, 'AGENTS.md'), 'utf8')).toBe(
      '## 変更後の確認\n\n`workspace/`のコードやテストを変更したら、作業を終える前に`cd workspace && bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では`cd workspace && bun run check`も実行する。`check:feedback`の成功を全体checkの成功として報告しない。\n',
    );
    expect(await readFile(join(f.repo, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n# Claude\n');
    expect(existsSync(join(f.repo, 'workspace/AGENTS.md'))).toBe(false);
    const installed = await snapshot(f.repo);
    apply(f, 'bun');
    expect(await snapshot(f.repo)).toEqual(installed);
  });
});

test('空白と引用符を含むディレクトリは、節のcdで引用する', async () => {
  const directory = "web app's";
  await fixture(nested(cliFiles, directory), async (f) => {
    const result = run(f, [
      setup,
      'apply',
      '--repo',
      join(f.repo, directory),
      '--feedback-command',
      'bun run check:affected',
    ]);
    expect(result.code, result.output).toBe(0);
    const agents = await readFile(join(f.repo, 'AGENTS.md'), 'utf8');
    expect(agents).toContain("`web app's/`のコードやテストを変更したら");
    expect(agents).toContain("`cd 'web app'\\''s' && bun run check:feedback`");
  });
});

test('packageのディレクトリの中の変更で関連qualityを選び、外だけの変更は変更なしと扱う', async () => {
  await fixture(nested(cliFiles), async (f) => {
    apply(f, 'bun');
    commitFixture(f.repo, 'configured');
    const workspace = inWorkspace(f);
    const classified = run(workspace, ['run', 'check:classification']);
    expect(classified.code, classified.output).toBe(0);
    expect(JSON.parse(classified.stdout)).toEqual({
      all: ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'],
      quality: ['test/a.test.ts', 'test/b.test.ts'],
      assurance: ['test/assurance.test.ts'],
    });
    await writeFile(join(f.repo, 'other/file.txt'), 'changed outside\n');
    const outside = run(workspace, ['run', 'check:affected']);
    expect(outside.code, outside.output).not.toBe(0);
    expect(outside.output).toContain('変更なし: テストを実行しません');
    await writeFile(join(f.repo, 'workspace/src/input.ts'), 'export const value = 2;\n');
    const first = run(workspace, ['run', 'check:affected']);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain('quality選択: 2');
    expect(first.output).not.toContain('ASSURANCE_RAN');
    await writeFile(join(f.repo, 'workspace/src/input.ts'), 'export const value = 1.5;\n');
    const related = run(workspace, ['run', 'check:affected']);
    expect(related.code, related.output).toBe(0);
    expect(related.output).toContain('QUALITY_A');
    expect(related.output).not.toContain('QUALITY_B');
    expect(related.output).toContain('quality選択: 1');
    expect(related.output).not.toContain('quality全件の理由:');
    expect(existsSync(join(f.repo, 'workspace/.feedback-loop-records/records.json'))).toBe(true);
    expect(existsSync(join(f.repo, '.feedback-loop-records'))).toBe(false);
  });
});

test('gitのdiff.relativeが有効でも、packageのディレクトリの中の変更を数える', async () => {
  await fixture(nested(cliFiles), async (f) => {
    apply(f, 'bun');
    commitFixture(f.repo, 'configured');
    git(f.repo, 'config', 'diff.relative', 'true');
    await writeFile(join(f.repo, 'workspace/src/input.ts'), 'export const value = 2;\n');
    const result = run(inWorkspace(f), ['run', 'check:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('QUALITY_A');
    expect(result.output).toContain('quality選択: 2');
  });
});

test('apply --updateはpackageのディレクトリの生成物をgitの状態で判定して置き換える', async () => {
  await fixture(nested(cliFiles), async (f) => {
    apply(f, 'bun');
    const runtime = join(f.repo, 'workspace/scripts/feedback-loop/runtime.mjs');
    const current = await readFile(runtime, 'utf8');
    await appendFile(runtime, '// older version\n');
    const update = [setup, 'apply', '--update', '--repo', join(f.repo, 'workspace')];
    const uncommitted = run(f, update);
    expect(uncommitted.code, uncommitted.output).not.toBe(0);
    expect(uncommitted.output).toContain('scripts/feedback-loop/runtime.mjs');
    commitFixture(f.repo, 'installed from an older version');
    const updated = run(f, update);
    expect(updated.code, updated.output).toBe(0);
    expect(await readFile(runtime, 'utf8')).toBe(current);
  });
});

test('Vitestはpackageの外の変更を、importでつながるテストにだけ反映する', async () => {
  const files = {
    ...cliFiles,
    'package.json': JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'npm@11.0.0',
      scripts: { check: 'vitest run' },
    }),
    '.feedback-loop.json': JSON.stringify(vitestConfig(cliConfig)),
    '.gitignore': 'node_modules\n',
    'test/a.test.ts': `${vitestHeader}import { value } from '../src/input.ts';\ntest('a', () => { console.log('QUALITY_A'); expect(value).toBeLessThan(3); });\n`,
    'test/b.test.ts': `${vitestHeader}import { shared } from '../../shared/util.ts';\ntest('b', () => { console.log('QUALITY_B'); expect(shared).toBeLessThan(3); });\n`,
    'test/assurance.test.ts': `${vitestHeader}test('cleanup', () => { console.log('ASSURANCE_RAN'); expect(1).toBe(1); });\n`,
  };
  await fixture({ ...nested(files), 'shared/util.ts': 'export const shared = 1;\n' }, async (f) => {
    await symlink(vitestModules, join(f.repo, 'workspace/node_modules'));
    apply(f, 'npm');
    commitFixture(f.repo, 'configured');
    expect(await readFile(join(f.repo, 'AGENTS.md'), 'utf8')).toContain(
      '`cd workspace && npm run check:feedback`',
    );
    const affected = () => {
      const result = spawnSync('npm', ['run', 'check:affected'], {
        cwd: join(f.repo, 'workspace'),
        encoding: 'utf8',
        timeout: 60000,
        env: baseEnv(f),
      });
      return { code: result.status, output: result.stdout + result.stderr };
    };

    await writeFile(join(f.repo, 'other/file.txt'), 'changed outside\n');
    const unrelated = affected();
    expect(unrelated.code, unrelated.output).not.toBe(0);
    expect(unrelated.output).toContain('変更なし: テストを実行しません');

    await writeFile(join(f.repo, 'shared/util.ts'), 'export const shared = 2;\n');
    const outsideOnly = affected();
    expect(outsideOnly.code, outsideOnly.output).toBe(0);
    expect(outsideOnly.output).toContain('QUALITY_B');
    expect(outsideOnly.output).not.toContain('QUALITY_A');
    expect(outsideOnly.output).toContain('quality選択: 1');
    expect(outsideOnly.output).not.toContain('quality全件の理由:');

    await writeFile(join(f.repo, 'workspace/src/input.ts'), 'export const value = 2;\n');
    const both = affected();
    expect(both.code, both.output).toBe(0);
    expect(both.output).toContain('QUALITY_A');
    expect(both.output).toContain('QUALITY_B');
    expect(both.output).not.toContain('ASSURANCE_RAN');
    expect(both.output).not.toContain('quality全件の理由:');

    // 外の共有コードが壊れたら、中の変更と同時でも失敗として返す。
    await writeFile(join(f.repo, 'shared/util.ts'), 'export const shared = 3;\n');
    const broken = affected();
    expect(broken.code, broken.output).not.toBe(0);
    expect(broken.output).toContain('QUALITY_B');

    await writeFile(join(f.repo, 'shared/util.ts'), 'export const shared = 1;\n');
    const insideOnly = affected();
    expect(insideOnly.code, insideOnly.output).toBe(0);
    expect(insideOnly.output).toContain('QUALITY_A');
    expect(insideOnly.output).not.toContain('QUALITY_B');
    expect(insideOnly.output).toContain('quality選択: 1');
    expect(insideOnly.output).not.toContain('quality全件の理由:');

    // 外の共有コードを削除しても、importしているテストを選んで失敗として返す。
    await rm(join(f.repo, 'shared/util.ts'));
    const deleted = affected();
    expect(deleted.code, deleted.output).not.toBe(0);
    expect(deleted.output).toContain('test/b.test.ts');
    expect(deleted.output).not.toContain('quality全件の理由:');
  });
}, 180000);

// lockfileをGitのルートに置き、packageの側にはpackageManagerもlockfileも置かないworkspace構成。
const unmanagedPackage = JSON.stringify({
  private: true,
  type: 'module',
  scripts: { check: 'bun test test', 'lint:fix': 'echo explicit-fix' },
});

function inspected(f: Fixture, directory = 'workspace') {
  const result = run(f, [setup, 'inspect', '--repo', join(f.repo, directory)]);
  expect(result.code, result.output).toBe(0);
  const value: unknown = JSON.parse(result.stdout);
  assert(isRecord(value));
  return value;
}

test('packageにlockfileもpackageManagerもなければ、祖先のいちばん近いlockfileからpackage managerを判定する', async () => {
  const files = { ...cliFiles, 'package.json': unmanagedPackage };
  await fixture({ ...nested(files), 'bun.lock': '{}\n' }, async (f) => {
    // 祖先で判定したときは、判定に使ったlockfileを返す。
    expect(inspected(f)).toMatchObject({
      packageManager: 'bun',
      packageManagerFrom: ['../bun.lock'],
      diagnostics: [],
    });
    // packageのpackage.jsonを変えずに導入できる。
    apply(f, 'bun');
    expect(await readFile(join(f.repo, 'workspace/package.json'), 'utf8')).not.toContain(
      'packageManager',
    );
  });
  // Gitのルートより近い祖先にlockfileがあれば、近い方を使う。
  await fixture(
    {
      ...nested(files, 'apps/web'),
      'bun.lock': '{}\n',
      'apps/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    },
    async (f) => {
      const result = inspected(f, 'apps/web');
      expect(result).toMatchObject({
        packageManager: 'pnpm',
        packageManagerFrom: ['../pnpm-lock.yaml'],
        diagnostics: [],
      });
      // 判定に使ったlockfileは、Gitのルートより近い祖先にあっても返す。
      expect(result.configFiles).toContain('../pnpm-lock.yaml');
    },
  );
  // packageにruntimeの指定がなければ、判定に使った祖先のpackageManagerを返す。
  await fixture(
    {
      ...nested(files),
      'package.json': '{"private":true,"packageManager":"pnpm@9.12.0"}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    },
    async (f) => {
      expect(inspected(f)).toMatchObject({ packageManager: 'pnpm', runtime: 'pnpm@9.12.0' });
    },
  );
});

test('祖先のlockfileの指定が競合すれば、競合する指定を診断に表示して判定しない', async () => {
  const files = { ...cliFiles, 'package.json': unmanagedPackage };
  await fixture(
    { ...nested(files), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'package-lock.json': '{}\n' },
    async (f) => {
      expect(inspected(f)).toMatchObject({
        packageManager: null,
        diagnostics: ['package managerの指定が競合しています: npm, pnpm（..で判定）'],
      });
    },
  );
  // 祖先のpackage.jsonのpackageManagerも、同じディレクトリのlockfileと突き合わせる。
  await fixture(
    {
      ...nested(files),
      'package.json': '{"private":true,"packageManager":"npm@11.0.0"}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    },
    async (f) => {
      expect(inspected(f)).toMatchObject({
        packageManager: null,
        diagnostics: ['package managerの指定が競合しています: npm, pnpm（..で判定）'],
      });
    },
  );
  // 祖先のpackageManagerから名前を読めなければ、lockfileだけで決めずに診断する。
  await fixture(
    {
      ...nested(files),
      'package.json': '{"private":true,"packageManager":"@9.0.0"}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    },
    async (f) => {
      expect(inspected(f)).toMatchObject({
        packageManager: null,
        diagnostics: [
          '../package.jsonのpackageManagerの値「@9.0.0」からpackage managerを読み取れません',
        ],
      });
    },
  );
});

test('packageにpackageManagerかlockfileがあれば、祖先のlockfileを判定に使わない', async () => {
  // cliFilesのpackage.jsonはpackageManagerにbunを指定している。
  await fixture(
    { ...nested(cliFiles), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
    async (f) => {
      expect(inspected(f)).toMatchObject({
        packageManager: 'bun',
        packageManagerFrom: null,
        diagnostics: [],
      });
    },
  );
  await fixture(
    {
      ...nested({ ...cliFiles, 'package.json': unmanagedPackage, 'package-lock.json': '{}\n' }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    },
    async (f) => {
      expect(inspected(f)).toMatchObject({ packageManager: 'npm', diagnostics: [] });
    },
  );
});

test('Bunは祖先のlockfileの変更で全qualityを実行し、lockfileの内容が違う時点の依存記録を使わない', async () => {
  await fixture({ ...nested(cliFiles), 'bun.lock': '{}\n' }, async (f) => {
    apply(f, 'bun');
    commitFixture(f.repo, 'configured');
    const workspace = inWorkspace(f);
    await writeFile(join(f.repo, 'workspace/src/input.ts'), 'export const value = 2;\n');
    expect(run(workspace, ['run', 'check:affected']).code).toBe(0);
    await writeFile(join(f.repo, 'workspace/src/input.ts'), 'export const value = 1;\n');

    // packageのpackage.jsonがpackageManagerを指定していても、使うlockfileは祖先にある。
    await writeFile(join(f.repo, 'bun.lock'), '{"changed":true}\n');
    const changed = run(workspace, ['run', 'check:affected']);
    expect(changed.code, changed.output).toBe(0);
    expect(changed.output).toContain('quality全件の理由: ../bun.lock');
    expect(changed.output).toContain('quality選択: 2');

    // lockfileを戻すと差分には出ない。記録した時点とlockfileの内容が違うため、記録を使わない。
    await writeFile(join(f.repo, 'bun.lock'), '{}\n');
    await writeFile(join(f.repo, 'workspace/src/input.ts'), 'export const value = 2;\n');
    const restored = run(workspace, ['run', 'check:affected']);
    expect(restored.code, restored.output).toBe(0);
    expect(restored.output).toContain('依存記録が古いため採用しません');
  });
});

test('Gitのルートより近い祖先のlockfileの変更と削除でも、全qualityを実行する', async () => {
  await fixture({ ...nested(cliFiles, 'apps/web'), 'apps/bun.lock': '{}\n' }, async (f) => {
    apply(f, 'bun', 'apps/web');
    commitFixture(f.repo, 'configured');
    const workspace = inWorkspace(f, 'apps/web');
    await writeFile(join(f.repo, 'apps/bun.lock'), '{"changed":true}\n');
    const changed = run(workspace, ['run', 'check:affected']);
    expect(changed.code, changed.output).toBe(0);
    expect(changed.output).toContain('quality全件の理由: ../bun.lock');

    await rm(join(f.repo, 'apps/bun.lock'));
    const deleted = run(workspace, ['run', 'check:affected']);
    expect(deleted.code, deleted.output).toBe(0);
    expect(deleted.output).toContain('quality全件の理由: ../bun.lock');
  });
});

test('未追跡の祖先のlockfileでも全qualityを実行し、いちばん近いlockfileより遠い祖先のlockfileは外の変更として扱う', async () => {
  // cliFilesのpackage.jsonはpackageManagerにbunを指定している。
  await fixture(nested(cliFiles), async (f) => {
    apply(f, 'bun');
    commitFixture(f.repo, 'configured');
    // workspaceのルートに、はじめてlockfileができた。git addする前である。
    await writeFile(join(f.repo, 'bun.lock'), '{}\n');
    const result = run(inWorkspace(f), ['run', 'check:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('quality全件の理由: ../bun.lock');
  });
  await fixture(
    { ...nested(cliFiles, 'apps/web'), 'apps/bun.lock': '{}\n', 'bun.lock': '{}\n' },
    async (f) => {
      apply(f, 'bun', 'apps/web');
      commitFixture(f.repo, 'configured');
      // apps/webが使うのはapps/bun.lockである。Gitのルートのlockfileは別のworkspaceのものである。
      await writeFile(join(f.repo, 'bun.lock'), '{"changed":true}\n');
      const result = run(inWorkspace(f, 'apps/web'), ['run', 'check:affected']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('変更なし: テストを実行しません');
    },
  );
});

test('導入時に判定したpackage managerと違うlockfileが祖先にあっても、その変更は外の変更として扱う', async () => {
  // cliFilesのpackage.jsonはpackageManagerにbunを指定している。祖先のpnpm-lock.yamlは、このpackageのlockfileではない。
  await fixture(
    { ...nested(cliFiles), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
    async (f) => {
      apply(f, 'bun');
      commitFixture(f.repo, 'configured');
      await writeFile(join(f.repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.1'\n");
      const result = run(inWorkspace(f), ['run', 'check:affected']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('変更なし: テストを実行しません');
    },
  );
});

test('worktreeでも、祖先のlockfileから判定し、その変更で全qualityを実行する', async () => {
  const files = { ...cliFiles, 'package.json': unmanagedPackage };
  await fixture({ ...nested(files), 'bun.lock': '{}\n' }, async (f) => {
    apply(f, 'bun');
    commitFixture(f.repo, 'configured');
    // worktreeでは、.gitはディレクトリではなくファイルである。
    const tree = join(f.repo, '..', 'tree');
    git(f.repo, 'worktree', 'add', '-q', '-b', 'tree', tree);
    const linked = { ...f, repo: tree };
    expect(inspected(linked)).toMatchObject({ packageManager: 'bun', diagnostics: [] });
    await writeFile(join(tree, 'bun.lock'), '{"changed":true}\n');
    const result = run(inWorkspace(linked), ['run', 'check:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('quality全件の理由: ../bun.lock');
  });
});

test('packageにlockfileがあれば、同じpackage managerの祖先のlockfileの変更も外の変更として扱う', async () => {
  await fixture(
    { ...nested({ ...cliFiles, 'bun.lock': '{}\n' }), 'bun.lock': '{}\n' },
    async (f) => {
      apply(f, 'bun');
      commitFixture(f.repo, 'configured');
      await writeFile(join(f.repo, 'bun.lock'), '{"changed":true}\n');
      const result = run(inWorkspace(f), ['run', 'check:affected']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('変更なし: テストを実行しません');
    },
  );
});

test('Vitestは祖先のlockfileの変更で全qualityを実行する', async () => {
  const files = {
    ...cliFiles,
    'package.json': JSON.stringify({
      private: true,
      type: 'module',
      scripts: { check: 'vitest run' },
    }),
    '.feedback-loop.json': JSON.stringify(vitestConfig(cliConfig)),
    '.gitignore': 'node_modules\n',
    'test/a.test.ts': `${vitestHeader}import { value } from '../src/input.ts';\ntest('a', () => { console.log('QUALITY_A'); expect(value).toBeLessThan(3); });\n`,
    'test/b.test.ts': `${vitestHeader}test('b', () => { console.log('QUALITY_B'); expect(1).toBe(1); });\n`,
    'test/assurance.test.ts': `${vitestHeader}test('cleanup', () => { console.log('ASSURANCE_RAN'); expect(1).toBe(1); });\n`,
  };
  await fixture({ ...nested(files), 'package-lock.json': '{}\n' }, async (f) => {
    await symlink(vitestModules, join(f.repo, 'workspace/node_modules'));
    apply(f, 'npm');
    commitFixture(f.repo, 'configured');
    await writeFile(join(f.repo, 'package-lock.json'), '{"changed":true}\n');
    const result = spawnSync('npm', ['run', 'check:affected'], {
      cwd: join(f.repo, 'workspace'),
      encoding: 'utf8',
      timeout: 60000,
      env: baseEnv(f),
    });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);
    expect(output).toContain(
      'quality全件の理由: 設定変更、削除、または依存先不明: ../package-lock.json',
    );
    expect(output).toContain('QUALITY_A');
    expect(output).toContain('QUALITY_B');
    expect(output).not.toContain('ASSURANCE_RAN');
  });
}, 120000);

test('Git checkoutの外と、package.jsonのないディレクトリは変更前に拒否する', async () => {
  await fixture(nested(cliFiles), async (f) => {
    const before = await snapshot(f.repo);
    const missing = run(f, [setup, 'inspect', '--repo', join(f.repo, 'other')]);
    expect(missing.code, missing.output).not.toBe(0);
    expect(missing.stderr).toContain('--repoはpackage.jsonがあるディレクトリを指定してください');
    const outside = await mkdtemp(join(tmpdir(), 'feedback-loop-outside-'));
    try {
      await writeFile(join(outside, 'package.json'), '{}\n');
      const rejected = run(f, [setup, 'inspect', '--repo', outside]);
      expect(rejected.code, rejected.output).not.toBe(0);
      expect(rejected.stderr).toContain('--repoはGit checkoutの中のディレクトリを指定してください');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    expect(await snapshot(f.repo)).toEqual(before);
  });
});
