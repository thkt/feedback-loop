import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, snapshot } from './support/feedback-loop-batch.ts';
import { baseEnv, commitFixture, fixture, git, header } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';
import { pluginManifest } from './support/feedback-loop-skill.ts';

const runtimePath = 'scripts/feedback-loop/runtime.mjs';
const recorderPath = 'scripts/feedback-loop/record-modules.ts';
const placed = [runtimePath, recorderPath, 'package.json', '.feedback-loop.json'];

// 生成物の2行目にある版の行。apply --updateは、配置済みの版をこの行から読む。
const versionLine = /^\/\/ 版: (\d+)\.(\d+)\.(\d+)$/m;

const pluginVersion = pluginManifest().version;

const packageWithoutScripts = { private: true, type: 'module', packageManager: 'bun@1.4.4' };
const feedbackConfig = {
  runner: 'bun',
  base: 'main',
  collect: [process.execPath, 'scripts/collect.ts'],
  testGlobs: ['test/*.test.ts'],
};
const files = {
  'package.json': JSON.stringify({ ...packageWithoutScripts, scripts: { check: 'bun test test' } }),
  '.feedback-loop.json': JSON.stringify(feedbackConfig),
  'scripts/collect.ts':
    "import { readdirSync } from 'node:fs'; console.log(JSON.stringify(readdirSync('test').map(p => 'test/' + p)));\n",
  'test/a.test.ts': header + "test('a', () => { expect(1).toBe(1); });\n",
};

function run(f: Fixture, args: string[]) {
  const result = spawnSync(process.execPath, [setup, ...args, '--repo', f.repo], {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 30000,
    env: baseEnv(f),
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: result.stdout + result.stderr };
}

async function contents(f: Fixture) {
  const entries = await Promise.all(
    placed.map(async (path) => [path, await readFile(join(f.repo, path), 'utf8')] as const),
  );
  return Object.fromEntries(entries);
}

async function installedFromOlderVersion(f: Fixture) {
  const applied = run(f, ['apply', '--feedback-command', 'bun run check:affected']);
  expect(applied.code, applied.output).toBe(0);
  const current = await contents(f);
  for (const path of [runtimePath, recorderPath]) {
    const older = `${current[path] ?? ''}// older version\n`;
    await writeFile(join(f.repo, path), older);
  }
  commitFixture(f.repo, 'installed from an older version');
  return current;
}

test('applyは関連実行をcheck:affectedの名前で接続し、test:affectedを接続しない', async () => {
  await fixture(files, async (f) => {
    const applied = run(f, ['apply', '--feedback-command', 'bun run check:affected']);
    expect(applied.code, applied.output).toBe(0);
    expect(JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'))).toHaveProperty(
      'scripts',
      {
        check: 'bun test test',
        'check:affected': 'bun scripts/feedback-loop/runtime.mjs affected',
        'check:classification': 'bun scripts/feedback-loop/runtime.mjs classification',
        'check:feedback': 'bun run check:affected',
      },
    );
  });
});

test('apply --updateはコミット済みの古い生成物を最新へ置き換え、再実行では変更しない', async () => {
  await fixture(files, async (f) => {
    const current = await installedFromOlderVersion(f);
    const before = await contents(f);

    const conflict = run(f, ['apply', '--feedback-command', 'bun run check:affected']);
    expect(conflict.code, conflict.output).not.toBe(0);
    expect(conflict.output).toContain(
      `配置済みファイルと衝突しています: ${runtimePath}, ${recorderPath}`,
    );
    expect(await contents(f)).toEqual(before);

    const updated = run(f, ['apply', '--update']);
    expect(updated.code, updated.output).toBe(0);
    expect(await contents(f)).toEqual(current);

    const repeated = run(f, ['apply', '--update']);
    expect(repeated.code, repeated.output).toBe(0);
    // 版も内容も同じなら、その版を添えて表示する。
    expect(repeated.output).toContain(`生成物は最新です（${pluginVersion}）。変更しません`);
    expect(await contents(f)).toEqual(current);
  });
});

test('applyが配置する実行部と記録器の先頭に、plugin.jsonのversionと同じ版がある', async () => {
  await fixture(files, async (f) => {
    const applied = run(f, ['apply', '--feedback-command', 'bun run check:affected']);
    expect(applied.code, applied.output).toBe(0);
    const current = await contents(f);
    const version = pluginVersion;
    for (const path of [runtimePath, recorderPath]) {
      expect((current[path] ?? '').split('\n').slice(0, 2), path).toContain(`// 版: ${version}`);
    }
  });
});

test('apply --updateは、配置済みの版がプラグインの版より新しければ、どのファイルも書き換えず、プラグインの更新を案内して非ゼロ終了する', async () => {
  await fixture(files, async (f) => {
    const current = await installedFromOlderVersion(f);
    // 桁の増えた版。文字列として比べると、プラグインの版より古く見える。
    const newer = (current[runtimePath] ?? '').replace(
      versionLine,
      (_, major: string, minor: string, patch: string) =>
        `// 版: ${major}.${minor}.${Number(patch) + 10}`,
    );
    expect(newer).not.toBe(current[runtimePath]);
    await writeFile(join(f.repo, runtimePath), newer);
    commitFixture(f.repo, 'installed from a newer version');
    const before = await contents(f);

    const updated = run(f, ['apply', '--update']);
    expect(updated.code, updated.output).not.toBe(0);
    const installed = versionLine.exec(newer)?.slice(1).join('.');
    expect(updated.output).toContain(
      `配置済みの生成物が、このプラグインの版（${pluginVersion}）より新しいため、どのファイルも更新しません。プラグインを更新してから再実行してください: ${runtimePath}（${installed}）`,
    );
    // 内容だけが古い記録器も、書き換えない。
    expect(await contents(f)).toEqual(before);
  });
});

for (const { name, rewrite } of [
  { name: '古ければ', rewrite: (body: string) => body.replace(versionLine, '// 版: 0.0.1') },
  // リリース済みの0.4.2までの生成物には、版の行がない。
  { name: 'なければ', rewrite: (body: string) => body.replace(/^\/\/ 版: .*\n/m, '') },
  // 版は2行目からだけ読む。3行目以降の同じ形の行を、配置済みの版にしない。
  {
    name: '2行目になければ',
    rewrite: (body: string) => body.replace(versionLine, '//\n// 版: 99.0.0'),
  },
]) {
  test(`apply --updateは、配置済みの版が${name}、生成物を置き換える`, async () => {
    await fixture(files, async (f) => {
      const applied = run(f, ['apply', '--feedback-command', 'bun run check:affected']);
      expect(applied.code, applied.output).toBe(0);
      const current = await contents(f);
      for (const path of [runtimePath, recorderPath]) {
        const rewritten = rewrite(current[path] ?? '');
        expect(rewritten, path).not.toBe(current[path]);
        await writeFile(join(f.repo, path), rewritten);
      }
      commitFixture(f.repo, 'installed from another version');

      const updated = run(f, ['apply', '--update']);
      expect(updated.code, updated.output).toBe(0);
      expect(updated.output).toContain('生成物を更新しました');
      expect(await contents(f)).toEqual(current);
    });
  });
}

test('applyは内容が食い違う生成物を拒否し、不足する生成物もpackage.jsonも変更しない', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    await unlink(join(f.repo, runtimePath));
    await writeFile(join(f.repo, 'package.json'), files['package.json']);
    const before = await snapshot(f.repo);

    const result = run(f, ['apply', '--feedback-command', 'bun run check:affected']);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(`配置済みファイルと衝突しています: ${recorderPath}`);
    expect(await snapshot(f.repo)).toEqual(before);
  });
});

test('apply --updateは未コミットの変更がある生成物があれば、どのファイルも変更せず対象を示す', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    await writeFile(join(f.repo, runtimePath), '// edited by hand\n');
    const before = await contents(f);

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(runtimePath);
    expect(result.output).not.toContain(recorderPath);
    expect(await contents(f)).toEqual(before);
  });
});

test('apply --updateは未追跡の生成物があれば全体を止め、存在しなければ配置する', async () => {
  await fixture(files, async (f) => {
    const current = await installedFromOlderVersion(f);
    git(f.repo, 'rm', '--cached', recorderPath);
    const before = await contents(f);
    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(recorderPath);
    expect(await contents(f)).toEqual(before);
    await unlink(join(f.repo, recorderPath));
    expect(run(f, ['apply', '--update']).code).toBe(0);
    expect(await contents(f)).toEqual(current);
  });
});

test('apply --updateはpackage scriptsを変更せず差分だけを表示する', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    const changedPackage = await withScripts(f, {
      check: 'bun test test',
      'check:affected': 'echo custom',
    });

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('check:affected: echo custom →');
    expect(result.output).toContain('check:classification: (未定義) →');
    expect(result.output).toContain('check:feedback: (未定義)');
    expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(changedPackage);
  });
});

const legacyScripts = {
  check: 'bun test test',
  'check:classification': 'bun scripts/feedback-loop/runtime.mjs classification',
  'check:feedback': 'bun run lint && bun run test:affected',
};

async function withScripts(f: Fixture, scripts: Record<string, string>) {
  const body = `${JSON.stringify({ ...packageWithoutScripts, scripts })}\n`;
  await writeFile(join(f.repo, 'package.json'), body);
  return body;
}

for (const { wrapping, affected } of [
  { wrapping: '包んでいない', affected: 'bun scripts/feedback-loop/runtime.mjs affected' },
  {
    wrapping: '環境変数の読み込みで包んだ',
    affected: 'dotenv -e .env.sample -- bun scripts/feedback-loop/runtime.mjs affected',
  },
]) {
  test(`apply --updateは${wrapping}改名前のtest:affectedを変更せず、check:affectedへ移す差分を表示する`, async () => {
    await fixture(files, async (f) => {
      await installedFromOlderVersion(f);
      const legacyPackage = await withScripts(f, { ...legacyScripts, 'test:affected': affected });

      const result = run(f, ['apply', '--update']);
      expect(result.code, result.output).toBe(0);
      const lines = result.output.split('\n');
      expect(lines).toContain(
        `package.jsonは変更しません。差分: check:affected: (未定義) → ${affected}`,
      );
      expect(lines).toContain(
        `改名前のscriptは変更しません。差分: test:affected: ${affected} → (削除。check:affectedへ改名)`,
      );
      expect(lines).toContain(
        '改名前のscriptは変更しません。差分: check:feedback: bun run lint && bun run test:affected → bun run lint && bun run check:affected',
      );
      expect(result.output).not.toContain('check:classification:');
      expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(legacyPackage);
    });
  });
}

test('apply --updateは、test:affectedを呼ぶscriptをすべて示し、名前の一部が重なるだけの呼出しは示さない', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    await withScripts(f, {
      check: 'bun test test',
      'check:classification': 'bun scripts/feedback-loop/runtime.mjs classification',
      'check:feedback': 'bun run lint',
      'check:quick': 'bun run test:affected && echo done',
      'test:affected': 'bun scripts/feedback-loop/runtime.mjs affected',
      'test:unit': 'bun run test:affected:unit && bun run e2e-test:affected',
    });

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).toBe(0);
    expect(result.output.split('\n')).toContain(
      '改名前のscriptは変更しません。差分: check:quick: bun run test:affected && echo done → bun run check:affected && echo done',
    );
    expect(result.output).not.toContain('差分: check:feedback');
    expect(result.output).not.toContain('差分: test:unit');
  });
});

test('apply --updateは、生成するコマンドを含まないcheck:affectedがあっても、包んだ改名前の値を移す先に示す', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    const wrapped = 'dotenv -e .env.sample -- bun scripts/feedback-loop/runtime.mjs affected';
    await withScripts(f, {
      ...legacyScripts,
      'check:affected': 'echo todo',
      'test:affected': wrapped,
    });

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).toBe(0);
    expect(result.output.split('\n')).toContain(
      `package.jsonは変更しません。差分: check:affected: echo todo → ${wrapped}`,
    );
  });
});

test('applyは、包んだ改名前のtest:affectedの値をcheck:affectedへ接続し、残る名前を示す', async () => {
  const wrapped = 'dotenv -e .env.sample -- bun scripts/feedback-loop/runtime.mjs affected';
  await fixture(
    {
      ...files,
      'package.json': JSON.stringify({
        private: true,
        type: 'module',
        packageManager: 'bun@1.4.4',
        scripts: { check: 'bun test test', 'test:affected': wrapped },
      }),
    },
    async (f) => {
      const applied = run(f, ['apply', '--feedback-command', 'bun run check:affected']);
      expect(applied.code, applied.output).toBe(0);
      expect(JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'))).toMatchObject({
        scripts: { 'check:affected': wrapped, 'test:affected': wrapped },
      });
      expect(applied.output.split('\n')).toContain(
        `改名前のscriptは変更しません。差分: test:affected: ${wrapped} → (削除。check:affectedへ改名)`,
      );
    },
  );
});

test('apply --updateは、test:affectedを呼ぶだけのcheck:affectedを書き換えの差分に出さず、前後のhookの改名を示す', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    const affected = 'bun scripts/feedback-loop/runtime.mjs affected';
    await withScripts(f, {
      check: 'bun test test',
      'check:affected': 'bun run test:affected',
      'check:classification': 'bun scripts/feedback-loop/runtime.mjs classification',
      'check:feedback': 'bun run check:affected',
      'pretest:affected': 'bun run codegen',
      'test:affected': affected,
    });

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).toBe(0);
    const lines = result.output.split('\n');
    expect(lines).toContain(
      `package.jsonは変更しません。差分: check:affected: bun run test:affected → ${affected}`,
    );
    expect(lines).toContain(
      '改名前のscriptは変更しません。差分: pretest:affected: bun run codegen → (precheck:affectedへ改名)',
    );
    expect(result.output).not.toContain('→ bun run check:affected');
  });
});

test('applyは、--feedback-commandがtest:affectedを呼んでいれば、書き換えの差分を示す', async () => {
  await fixture(files, async (f) => {
    const applied = run(f, [
      'apply',
      '--feedback-command',
      'bun run lint && bun run test:affected',
    ]);
    expect(applied.code, applied.output).toBe(0);
    expect(applied.output.split('\n')).toContain(
      '改名前のscriptは変更しません。差分: check:feedback: bun run lint && bun run test:affected → bun run lint && bun run check:affected',
    );
  });
});

test('apply --updateは生成するコマンドを含まないtest:affectedを、改名の差分に出さない', async () => {
  await fixture(files, async (f) => {
    await installedFromOlderVersion(f);
    const ownPackage = await withScripts(f, {
      check: 'bun test test',
      'check:affected': 'bun scripts/feedback-loop/runtime.mjs affected',
      'check:classification': 'bun scripts/feedback-loop/runtime.mjs classification',
      'check:feedback': 'bun run check:affected',
      'test:affected': 'vitest related',
    });

    const result = run(f, ['apply', '--update']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('test:affected');
    expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(ownPackage);
  });
});

test('runnerをBunからVitestへ変えて更新しても配置済みの記録器を残す', async () => {
  await fixture(files, async (f) => {
    const applied = run(f, ['apply', '--feedback-command', 'bun run check:affected']);
    expect(applied.code, applied.output).toBe(0);
    const recorder = await readFile(join(f.repo, recorderPath), 'utf8');
    commitFixture(f.repo, 'Bun runner installed');
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({ ...feedbackConfig, runner: 'vitest' }),
    );
    const updated = run(f, ['apply', '--update']);
    expect(updated.code, updated.output).toBe(0);
    expect(await readFile(join(f.repo, recorderPath), 'utf8')).toBe(recorder);
  });
});
