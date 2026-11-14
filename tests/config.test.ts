import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyFeedback,
  cliFiles as files,
  cliConfig,
  runSetup as run,
  snapshot,
} from './support/feedback-loop-batch.ts';
import { fixture } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

const config = {
  runner: cliConfig.runner,
  testGlobs: cliConfig.testGlobs,
};

for (const collect of [undefined, cliConfig.collect]) {
  // collectを省略した場合は、必須の2項目（runnerとtestGlobs）だけの設定になる。
  test(`testGlobs外の読めないディレクトリがあっても分類と関連実行が通る（collect=${collect !== undefined}）`, async () => {
    await fixture(
      {
        ...files,
        '.gitignore': 'dist/\n',
        '.feedback-loop.json': JSON.stringify({ ...config, collect }),
      },
      async (f) => {
        const applied = applyFeedback(f, 'bun run check:affected', run);
        expect(applied.code, applied.output).toBe(0);
        const blocked = join(f.repo, 'dist');
        await mkdir(blocked);
        await chmod(blocked, 0o000);
        try {
          expect(() => readdirSync(blocked)).toThrow('EACCES');
          const classified = run(f, ['run', 'check:classification', '--json']);
          expect(classified.code, classified.output).toBe(0);
          expect(JSON.parse(classified.stdout)).toEqual({
            all: ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'],
            quality: ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'],
            assurance: [],
          });
          await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
          const affected = run(f, ['run', 'check:affected']);
          expect(affected.code, affected.output).toBe(0);
          expect(affected.output).toContain('QUALITY_A');
          expect(affected.output).toContain('quality選択: 3件');
        } finally {
          await chmod(blocked, 0o755);
        }
      },
    );
  });
}

for (const { collect, expected } of [
  { collect: undefined, expected: [] },
  {
    collect: [process.execPath, '-e', 'console.log(JSON.stringify(["test/.hidden/a.test.ts"]))'],
    expected: ['test/.hidden/a.test.ts'],
  },
]) {
  test(`固定部分が隠しディレクトリでも収集方法ごとの扱いを保つ（collect=${collect !== undefined}）`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({
          ...config,
          testGlobs: ['test/.hidden/*.test.ts'],
          collect,
        }),
        'test/.hidden/a.test.ts': files['test/a.test.ts'],
      },
      async (f) => {
        const applied = applyFeedback(f, 'bun run check:affected', run);
        expect(applied.code, applied.output).toBe(0);
        const classified = run(f, ['run', 'check:classification', '--json']);
        expect(classified.code, classified.output).toBe(0);
        expect(JSON.parse(classified.stdout)).toEqual({
          all: expected,
          quality: expected,
          assurance: [],
        });
      },
    );
  });
}

for (const command of ['check:classification', 'check:affected']) {
  test(`collect省略では存在しない探索場所を診断して${command}を止める`, async () => {
    await fixture(files, async (f) => {
      const applied = applyFeedback(f, 'bun run check:affected', run);
      expect(applied.code, applied.output).toBe(0);
      await writeFile(
        join(f.repo, '.feedback-loop.json'),
        JSON.stringify({ ...config, testGlobs: [...config.testGlobs, 'absent/**/*.test.ts'] }),
      );
      const result = run(f, ['run', command]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(
        'feedback-loop未完了: testGlobsの探索場所がありません: absent/',
      );
      expect(result.output).not.toContain('QUALITY_A');
    });
  });
}

// 実在するテストがtestGlobsの外に増えた場合を確かめるため、収集だけに出すファイルも置く。
const outsideTests = { ...files, 'other/a.test.ts': '', 'other/c.test.ts': '' };

// 導入の変更をcommitしない。関連実行は、導入の変更を理由に全qualityを実行する。
function applyUncommitted(f: Fixture) {
  const applied = applyFeedback(f, 'bun run check:affected', run);
  expect(applied.code, applied.output).toBe(0);
}

/** 収集用コマンドがcollectedを出すようにして、package scriptを通さずに実行部を起動する。 */
async function runWithCollected(f: Fixture, collected: string[], operation: string) {
  await writeFile(
    join(f.repo, 'scripts/collect.ts'),
    `console.log(${JSON.stringify(JSON.stringify(collected))});\n`,
  );
  return run(f, ['--no-env-file', 'scripts/feedback-loop/runtime.mjs', operation]);
}

// 収集用コマンドを指定したrepoで、収集にあってtestGlobsに当たらないパスに続けて表示する直し方。
const globGuidance =
  '直し方: 上のパスがテストなら、.feedback-loop.jsonのtestGlobsへ、そのパスに当たるglobを足してください。globに当たるテストは、同じファイルのassuranceへ登録しなければqualityになります。テストでなければ、収集用コマンドの出力から外してください';

// 診断は向きごとの行だけで、両方にあるパスを出さない。診断の全文が出力の末尾に来ることで確かめる。

for (const { name, collected, operation, diagnostic } of [
  {
    name: '収集だけにtestGlobs外のテストがある',
    collected: [
      'test/a.test.ts',
      'test/assurance.test.ts',
      'test/b.test.ts',
      'other/c.test.ts',
      'other/a.test.ts',
    ],
    operation: 'classification',
    diagnostic: `収集にあってtestGlobsに当たらない: ["other/a.test.ts","other/c.test.ts"]\n${globGuidance}`,
  },
  {
    name: 'testGlobsに当たるテストが収集にない',
    collected: ['test/a.test.ts', 'test/assurance.test.ts'],
    operation: 'classification',
    diagnostic: 'testGlobsに当たって収集にない: ["test/b.test.ts"]',
  },
  {
    name: '両方の向きに食い違う',
    collected: ['test/a.test.ts', 'test/assurance.test.ts', 'other/c.test.ts'],
    operation: 'classification',
    diagnostic: `収集にあってtestGlobsに当たらない: ["other/c.test.ts"]\n${globGuidance}\ntestGlobsに当たって収集にない: ["test/b.test.ts"]`,
  },
  {
    name: '両方の向きに食い違う',
    collected: ['test/a.test.ts', 'test/assurance.test.ts', 'other/c.test.ts'],
    operation: 'affected',
    diagnostic: `収集にあってtestGlobsに当たらない: ["other/c.test.ts"]\n${globGuidance}\ntestGlobsに当たって収集にない: ["test/b.test.ts"]`,
  },
]) {
  test(`${name}と、${operation}は片方にしかないパスだけを向きごとに示して止める`, async () => {
    await fixture(outsideTests, async (f) => {
      applyUncommitted(f);
      const result = await runWithCollected(f, collected, operation);
      expect(result.code, result.output).not.toBe(0);
      expect(result.stderr).toEndWith(
        `feedback-loop未完了: 通常収集とtestGlobsの集合が一致しません\n${diagnostic}\n`,
      );
      expect(result.output).not.toContain('QUALITY_A');
    });
  });
}

test('収集だけにあるパスを、実在しない・testGlobsに当たらない・探索で見つからないに分けて示す', async () => {
  await fixture({ ...files, 'other/c.test.ts': '' }, async (f) => {
    applyUncommitted(f);
    // 探索はシンボリックリンクをたどらない。導入の後に置き、導入時の収集と探索をそろえる。
    await symlink('../other/c.test.ts', join(f.repo, 'test/link.test.ts'));
    await symlink('../other/nowhere.test.ts', join(f.repo, 'test/dangling.test.ts'));
    const result = await runWithCollected(
      f,
      [
        'test/a.test.ts',
        'test/assurance.test.ts',
        'test/b.test.ts',
        'test/nonexistent.test.ts',
        'other/gone.test.ts',
        'other/c.test.ts',
        'test/link.test.ts',
        'test/dangling.test.ts',
      ],
      'classification',
    );
    expect(result.code, result.output).not.toBe(0);
    expect(result.stderr).toEndWith(
      'feedback-loop未完了: 通常収集とtestGlobsの集合が一致しません\n' +
        '収集にあって実在しない: ["other/gone.test.ts","test/nonexistent.test.ts"]\n' +
        `収集にあってtestGlobsに当たらない: ["other/c.test.ts"]\n${globGuidance}\n` +
        '収集にあってtestGlobsに当たるが、探索で見つからない（シンボリックリンク、ディレクトリ、node_modules・.gitの下、表記の違いなど）: ["test/dangling.test.ts","test/link.test.ts"]\n',
    );
  });
});

test('collect指定では存在しない固定ディレクトリのglobを空集合として扱う', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected', run);
    expect(applied.code, applied.output).toBe(0);
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({
        ...cliConfig,
        testGlobs: [...config.testGlobs, 'absent/**/*.test.ts'],
      }),
    );
    const classified = run(f, ['run', 'check:classification', '--json']);
    expect(classified.code, classified.output).toBe(0);
    expect(JSON.parse(classified.stdout)).toEqual({
      all: ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'],
      quality: ['test/a.test.ts', 'test/b.test.ts'],
      assurance: ['test/assurance.test.ts'],
    });
  });
});

test('未知のキーは導入・分類検査・関連実行のどれでも、収集とテストの前に拒否する', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected', run);
    expect(applied.code, applied.output).toBe(0);
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({
        ...cliConfig,
        version: 1,
        fullCheck: ['bun', 'run', 'check'],
        globalChange: [],
      }),
    );
    await writeFile(join(f.repo, 'scripts/collect.ts'), "throw new Error('COLLECT_RAN');\n");
    const before = await snapshot(f.repo);
    const unknownKeys = '.feedback-loop.jsonの未知のキーです: version, fullCheck, globalChange';

    const reapplied = applyFeedback(f, 'bun run check:affected', run);
    expect(reapplied.code, reapplied.output).not.toBe(0);
    expect(reapplied.output).toContain(`setup-feedback-loop未完了: ${unknownKeys}`);
    expect(reapplied.output).not.toContain('COLLECT_RAN');

    const classified = run(f, ['run', 'check:classification']);
    expect(classified.code, classified.output).not.toBe(0);
    expect(classified.output).toContain(`feedback-loop未完了: ${unknownKeys}`);
    expect(classified.output).not.toContain('COLLECT_RAN');

    const affected = run(f, ['run', 'check:affected']);
    expect(affected.code, affected.output).not.toBe(0);
    expect(affected.output).toContain(`feedback-loop未完了: ${unknownKeys}`);
    expect(affected.output).not.toContain('COLLECT_RAN');
    expect(affected.output).not.toContain('QUALITY_A');

    expect(await snapshot(f.repo)).toEqual(before);
  });
});

for (const { name, changed, diagnostic } of [
  {
    name: 'runnerがない',
    changed: { ...config, runner: undefined },
    diagnostic: 'runnerはbunまたはvitestです',
  },
  { name: 'baseが空', changed: { ...config, base: '' }, diagnostic: '比較元baseが必要です' },
  {
    name: 'baseが文字列でない',
    changed: { ...config, base: 1 },
    diagnostic: '比較元baseが必要です',
  },
  {
    name: 'Vitestでcollectがない',
    changed: { ...config, runner: 'vitest' },
    diagnostic: 'collectは空でない文字列の配列で指定してください',
  },
  {
    name: 'testGlobsがない',
    changed: { ...config, testGlobs: undefined },
    diagnostic: 'testGlobsは空でない文字列の配列で指定してください',
  },
  {
    name: 'collectが空',
    changed: { ...config, collect: [] },
    diagnostic: '収集コマンドは空にできません',
  },
  {
    name: 'testGlobsが空',
    changed: { ...config, testGlobs: [] },
    diagnostic: 'テストglobは必須です',
  },
  {
    name: 'ignoredChangesが配列でない',
    changed: { ...config, ignoredChanges: 'docs/**' },
    diagnostic: 'ignoredChangesは空でない文字列の配列で指定してください',
  },
  {
    name: 'ignoredChangesがrepoの外を指す',
    changed: { ...config, ignoredChanges: ['../docs/**'] },
    diagnostic: 'repo相対パスが必要です: ../docs/**',
  },
]) {
  test(`${name}設定は分類検査で拒否する`, async () => {
    await fixture(files, async (f) => {
      applyUncommitted(f);
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(changed));
      const result = run(f, ['run', 'check:classification']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(`feedback-loop未完了: ${diagnostic}`);
    });
  });
}
