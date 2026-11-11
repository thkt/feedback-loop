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
          const classified = run(f, ['run', 'check:classification']);
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
        const classified = run(f, ['run', 'check:classification']);
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

test('collect省略では存在しない探索場所を診断して分類検査と関連実行を止める', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected', run);
    expect(applied.code, applied.output).toBe(0);
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({ ...config, testGlobs: [...config.testGlobs, 'absent/**/*.test.ts'] }),
    );
    for (const command of ['check:classification', 'check:affected']) {
      const result = run(f, ['run', command]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('testGlobsの探索場所がありません: absent/');
      expect(result.output).not.toContain('ENOENT');
      expect(result.output).not.toContain('QUALITY_A');
    }
  });
});

test('収集とtestGlobsの集合が食い違うと、片方にしかないパスだけを向きごとに示して止める', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected', run);
    expect(applied.code, applied.output).toBe(0);
    // 実在するテストがtestGlobsの外に増えた場合を確かめるため、収集だけに出すファイルも作る。
    await mkdir(join(f.repo, 'other'));
    for (const name of ['a', 'c']) {
      await writeFile(join(f.repo, `other/${name}.test.ts`), '');
    }
    for (const { collected, diagnostics, absent, shared } of [
      {
        collected: [
          'test/a.test.ts',
          'test/assurance.test.ts',
          'test/b.test.ts',
          'other/c.test.ts',
          'other/a.test.ts',
        ],
        diagnostics: ['収集にあってtestGlobsに当たらない: ["other/a.test.ts","other/c.test.ts"]'],
        absent: ['testGlobsに当たって収集にない'],
        shared: ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'],
      },
      {
        collected: ['test/a.test.ts', 'test/assurance.test.ts'],
        diagnostics: ['testGlobsに当たって収集にない: ["test/b.test.ts"]'],
        absent: ['収集にあって'],
        shared: ['test/a.test.ts', 'test/assurance.test.ts'],
      },
      {
        collected: ['test/a.test.ts', 'test/assurance.test.ts', 'other/c.test.ts'],
        diagnostics: [
          '収集にあってtestGlobsに当たらない: ["other/c.test.ts"]',
          'testGlobsに当たって収集にない: ["test/b.test.ts"]',
        ],
        absent: [],
        shared: ['test/a.test.ts', 'test/assurance.test.ts'],
      },
    ]) {
      await writeFile(
        join(f.repo, 'scripts/collect.ts'),
        `console.log(${JSON.stringify(JSON.stringify(collected))});\n`,
      );
      for (const command of ['check:classification', 'check:affected']) {
        const result = run(f, ['run', command]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain('通常収集とtestGlobsの集合が一致しません');
        for (const diagnostic of diagnostics) {
          expect(result.output).toContain(diagnostic);
        }
        for (const text of [...absent, ...shared]) {
          expect(result.output).not.toContain(text);
        }
      }
    }
  });
});

test('収集だけにあるパスを、実在しない・testGlobsに当たらない・探索で見つからないに分けて示す', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected', run);
    expect(applied.code, applied.output).toBe(0);
    await mkdir(join(f.repo, 'other'));
    await writeFile(join(f.repo, 'other/c.test.ts'), '');
    await symlink('../other/c.test.ts', join(f.repo, 'test/link.test.ts'));
    await symlink('../other/nowhere.test.ts', join(f.repo, 'test/dangling.test.ts'));
    const collected = [
      'test/a.test.ts',
      'test/assurance.test.ts',
      'test/b.test.ts',
      'test/nonexistent.test.ts',
      'other/gone.test.ts',
      'other/c.test.ts',
      'test/link.test.ts',
      'test/dangling.test.ts',
    ];
    await writeFile(
      join(f.repo, 'scripts/collect.ts'),
      `console.log(${JSON.stringify(JSON.stringify(collected))});\n`,
    );
    for (const command of ['check:classification', 'check:affected']) {
      const result = run(f, ['run', command]);
      expect(result.code, result.output).not.toBe(0);
      const lines = result.output.split('\n');
      expect(lines).toContain(
        '収集にあって実在しない: ["other/gone.test.ts","test/nonexistent.test.ts"]',
      );
      expect(lines).toContain('収集にあってtestGlobsに当たらない: ["other/c.test.ts"]');
      expect(lines).toContain(
        '収集にあってtestGlobsに当たるが、探索で見つからない（シンボリックリンク、ディレクトリ、node_modules・.gitの下、表記の違いなど）: ["test/dangling.test.ts","test/link.test.ts"]',
      );
      expect(result.output).not.toContain('testGlobsに当たって収集にない');
    }
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
    const classified = run(f, ['run', 'check:classification']);
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
    for (const result of [
      applyFeedback(f, 'bun run check:affected', run),
      run(f, ['run', 'check:classification']),
      run(f, ['run', 'check:affected']),
    ]) {
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(
        '.feedback-loop.jsonの未知のキーです: version, fullCheck, globalChange',
      );
      expect(result.output).not.toContain('COLLECT_RAN');
      expect(result.output).not.toContain('QUALITY_A');
    }
    expect(await snapshot(f.repo)).toEqual(before);
  });
});

test('必須の2項目がないか、base・ignoredChangesが不正か、収集とテストglobが空なら拒否する', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run check:affected', run);
    expect(applied.code, applied.output).toBe(0);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...config, runner: undefined }, 'runnerはbunまたはvitestです'],
      [{ ...config, base: '' }, '比較元baseが必要です'],
      [{ ...config, base: null }, '比較元baseが必要です'],
      [{ ...config, base: 1 }, '比較元baseが必要です'],
      [{ ...config, runner: 'vitest' }, '文字列配列が必要です'],
      [{ ...config, testGlobs: undefined }, '文字列配列が必要です'],
      [{ ...config, collect: [] }, '収集コマンドは空にできません'],
      [{ ...config, testGlobs: [] }, 'テストglobは必須です'],
      [{ ...config, ignoredChanges: 'docs/**' }, '文字列配列が必要です'],
      [{ ...config, ignoredChanges: ['../docs/**'] }, 'repo相対パスが必要です'],
    ];
    for (const [changed, diagnostic] of cases) {
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(changed));
      const result = run(f, ['run', 'check:classification']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(diagnostic);
    }
  });
});
