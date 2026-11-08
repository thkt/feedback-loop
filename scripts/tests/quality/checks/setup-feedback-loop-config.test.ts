import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyFeedback,
  cliFiles as files,
  cliConfig,
  runSetup as run,
  snapshot,
} from '../../support/feedback-loop-batch.ts';
import { fixture } from '../../support/runner-affected.ts';

const config = {
  runner: cliConfig.runner,
  base: cliConfig.base,
  testGlobs: cliConfig.testGlobs,
};

test('必須の3項目だけで分類検査と関連テストを実行する', async () => {
  await fixture({ ...files, '.feedback-loop.json': JSON.stringify(config) }, async (f) => {
    const applied = applyFeedback(f, 'bun run test:affected', run);
    expect(applied.code, applied.output).toBe(0);
    const classified = run(f, ['run', 'check:classification']);
    expect(classified.code, classified.output).toBe(0);
    expect(JSON.parse(classified.stdout)).toEqual({
      all: ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'],
      quality: ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'],
      assurance: [],
    });
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const affected = run(f, ['run', 'test:affected']);
    expect(affected.code, affected.output).toBe(0);
    for (const marker of ['QUALITY_A', 'QUALITY_B', 'ASSURANCE_RAN']) {
      expect(affected.output).toContain(marker);
    }
  });
});

test('未知のキーは導入・分類検査・関連実行のどれでも、収集とテストの前に拒否する', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run test:affected', run);
    expect(applied.code, applied.output).toBe(0);
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({
        ...config,
        version: 1,
        fullCheck: ['bun', 'run', 'check'],
        globalChange: [],
      }),
    );
    await writeFile(join(f.repo, 'scripts/collect.ts'), "throw new Error('COLLECT_RAN');\n");
    const before = await snapshot(f.repo);
    for (const result of [
      applyFeedback(f, 'bun run test:affected', run),
      run(f, ['run', 'check:classification']),
      run(f, ['run', 'test:affected']),
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

test('必須の3項目がないか、収集とテストglobが空なら拒否する', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(f, 'bun run test:affected', run);
    expect(applied.code, applied.output).toBe(0);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...config, runner: undefined }, 'runnerはbunまたはvitestです'],
      [{ ...config, base: undefined }, '比較元baseが必要です'],
      [{ ...config, runner: 'vitest' }, '文字列配列が必要です'],
      [{ ...config, testGlobs: undefined }, '文字列配列が必要です'],
      [{ ...config, collect: [] }, '収集コマンドは空にできません'],
      [{ ...config, testGlobs: [] }, 'テストglobは必須です'],
    ];
    for (const [changed, diagnostic] of cases) {
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(changed));
      const result = run(f, ['run', 'check:classification']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(diagnostic);
    }
  });
});
