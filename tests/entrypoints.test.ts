import {
  vitestConfig as createVitestConfig,
  vitestModules,
  vitestHeader,
} from './support/vitest.ts';
import {
  applyFeedback,
  applyWithProbe as apply,
  cliConfig as config,
  cliFiles as files,
  runSetup as run,
  snapshot,
} from './support/feedback-loop-batch.ts';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, commitFixture, fixture, git, header } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

for (const { manager, runner, packageManager, runnerConfig, testHeader } of [
  {
    manager: 'bun',
    runner: 'bun',
    packageManager: 'bun@1.4.4',
    runnerConfig: config,
    testHeader: header,
  },
  {
    manager: 'npm',
    runner: 'vitest',
    packageManager: 'npm@11.0.0',
    runnerConfig: createVitestConfig(config),
    testHeader: vitestHeader,
  },
  {
    manager: 'npm',
    runner: 'bun',
    packageManager: 'npm@11.0.0',
    runnerConfig: config,
    testHeader: header,
  },
  {
    manager: 'bun',
    runner: 'vitest',
    packageManager: 'bun@1.4.4',
    runnerConfig: createVitestConfig(config),
    testHeader: vitestHeader,
  },
]) {
  test(`生成入口は${manager}管理・${runner} runnerに対応する再実行方法を案内する`, async () => {
    const targetConfig = {
      ...runnerConfig,
      runner,
      prepare: [process.execPath, 'scripts/prepare.ts'],
    };
    await fixture(
      {
        ...files,
        'package.json': JSON.stringify({
          private: true,
          type: 'module',
          packageManager,
          scripts: { check: 'echo existing' },
        }),
        '.feedback-loop.json': JSON.stringify(targetConfig),
        'scripts/prepare.ts': "console.log('PREPARE_RAN');\n",
        '.gitignore': 'node_modules\n',
        'test/a.test.ts': `${testHeader}test('a', () => { console.log('QUALITY_A'); expect(1).toBe(1); });\n`,
        'test/b.test.ts': `${testHeader}test('b', () => { console.log('QUALITY_B'); expect(1).toBe(1); });\n`,
        'test/assurance.test.ts': `${testHeader}test('cleanup', () => { console.log('ASSURANCE_RAN'); expect(1).toBe(1); });\n`,
      },
      async (f) => {
        await symlink(vitestModules, join(f.repo, 'node_modules'));
        const applied = applyFeedback(f, `${manager} run test:affected`, run);
        expect(applied.code, applied.output).toBe(0);
        for (const { script, markers } of [
          { script: 'check:classification', markers: [] },
          { script: 'test:affected', markers: ['PREPARE_RAN', 'QUALITY_A', 'quality選択: 2'] },
        ]) {
          const result = spawnSync(manager, ['run', script], {
            cwd: f.repo,
            encoding: 'utf8',
            timeout: 30000,
            env: baseEnv(f),
          });
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          const output = result.stdout + result.stderr;
          expect(result.status, output).toBe(0);
          const managers = [...output.matchAll(/再実行: (bun|npm) run test:affected/g)].map(
            (match) => match[1],
          );
          expect(managers.length, output).toBeGreaterThanOrEqual(1);
          expect([...new Set(managers)], output).toEqual([manager]);
          for (const marker of markers) {
            expect(output).toContain(marker);
          }
        }
      },
    );
  });
}

test('生成入口は準備を一度だけ完了してからテストを実行し、準備失敗を伝える', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        prepare: [process.execPath, '--no-env-file', 'scripts/prepare.ts'],
      }),
      'scripts/prepare.ts': `import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.PREPARE_LOG!, 'prepare\\n');
if (process.env.PREPARE_FAIL === '1') {
  console.error('PREPARE_DIAGNOSTIC: fixed dependencies or Python syntax; rerun: bun run check:feedback');
  process.exit(9);
}
writeFileSync(process.env.PREPARE_READY!, 'ready');
`,
      'test/a.test.ts':
        header +
        `import { appendFileSync, readFileSync } from 'node:fs';
test('prepared', () => {
  expect(readFileSync(process.env.PREPARE_READY!, 'utf8')).toBe('ready');
  appendFileSync(process.env.PREPARE_LOG!, 'test\\n');
  console.log('PREPARED_QUALITY');
});
`,
    },
    async (f) => {
      const log = join(f.signals, 'prepare.log');
      const ready = join(f.signals, 'ready');
      const env = { PREPARE_LOG: log, PREPARE_READY: ready };
      await writeFile(log, '');
      apply(f);
      const classified = run(f, ['run', 'check:classification'], env);
      expect(classified.code, classified.output).toBe(0);
      expect(await readFile(log, 'utf8')).toBe('');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      for (const { name, prepareFail, code, includes, excludes, expectedLog } of [
        {
          name: '成功',
          prepareFail: '0',
          code: 0,
          includes: ['PREPARED_QUALITY', 'QUALITY_B'],
          excludes: [],
          expectedLog: 'prepare\ntest\n',
        },
        {
          name: '失敗',
          prepareFail: '1',
          code: 1,
          includes: ['PREPARE_DIAGNOSTIC', 'rerun: bun run check:feedback'],
          excludes: ['PREPARED_QUALITY', 'QUALITY_B'],
          expectedLog: 'prepare\n',
        },
        {
          name: '修復',
          prepareFail: '0',
          code: 0,
          includes: ['PREPARED_QUALITY', 'QUALITY_B'],
          excludes: [],
          expectedLog: 'prepare\ntest\n',
        },
      ]) {
        await writeFile(log, '');
        await writeFile(ready, 'not ready');
        const result = run(f, ['run', 'check:feedback'], { ...env, PREPARE_FAIL: prepareFail });
        expect(result.code, `${name}: ${result.output}`).toBe(code);
        for (const marker of includes) {
          expect(result.output, name).toContain(marker);
        }
        for (const marker of excludes) {
          expect(result.output, name).not.toContain(marker);
        }
        expect(await readFile(log, 'utf8'), name).toBe(expectedLog);
      }
    },
  );
});

test('生成入口は新規qualityを収集し、未知入力を既知依存と混ぜても全qualityへ広げる', async () => {
  await fixture(files, async (f) => {
    apply(f);
    commitFixture(f.repo, 'configured');
    const unchanged = run(f, ['run', 'test:affected']);
    expect(unchanged.code, unchanged.output).not.toBe(0);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const control = run(f, ['run', 'test:affected']);
    expect(control.code, control.output).toBe(0);
    expect(control.output).toContain('QUALITY_A');
    await writeFile(
      join(f.repo, 'test/new.test.ts'),
      header + "test('new', () => { console.log('NEW_QUALITY'); expect(1).toBe(1); });\n",
    );
    const classified = run(f, ['run', 'check:classification']);
    expect(classified.code, classified.output).toBe(0);
    await writeFile(join(f.repo, 'unknown.txt'), 'unmapped input');
    const mixed = run(f, ['run', 'test:affected']);
    expect(mixed.code, mixed.output).toBe(0);
    for (const marker of ['QUALITY_A', 'QUALITY_B', 'NEW_QUALITY']) {
      expect(mixed.output).toContain(marker);
    }
    expect(mixed.output).not.toContain('ASSURANCE_RAN');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
    const failed = run(f, ['run', 'test:affected']);
    expect(failed.output).toContain('QUALITY_A');
    expect(failed.code, failed.output).not.toBe(0);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const repaired = run(f, ['run', 'test:affected']);
    expect(repaired.code, repaired.output).toBe(0);
  });
});

for (const { scenario, source, diagnostic } of [
  {
    scenario: 'failed',
    source: "console.error('COLLECTION_FAILURE'); process.exit(7);\n",
    diagnostic: 'COLLECTION_FAILURE',
  },
  {
    scenario: 'invalid-json',
    source: "console.log('not JSON');\n",
    diagnostic: 'JSON Parse error:',
  },
  {
    scenario: 'duplicate',
    source: `console.log('["test/a.test.ts","test/b.test.ts","test/assurance.test.ts","test/a.test.ts"]');\n`,
    diagnostic: '収集結果が重複しています',
  },
  {
    scenario: 'missing',
    source: `console.log('["test/a.test.ts","test/b.test.ts","test/assurance.test.ts","test/nonexistent.test.ts"]');\n`,
    diagnostic: '集合が一致しません',
  },
  {
    scenario: 'omitted',
    source: `console.log('["test/a.test.ts","test/b.test.ts"]');\n`,
    diagnostic: '集合が一致しません',
  },
]) {
  test(`導入後の収集が${scenario}なら分類検査と関連実行を成功扱いしない`, async () => {
    await fixture(files, async (f) => {
      apply(f);
      const control = run(f, ['run', 'check:classification']);
      expect(control.code, control.output).toBe(0);
      await writeFile(join(f.repo, 'scripts/collect.ts'), source);
      const before = await snapshot(f.repo);
      for (const command of ['check:classification', 'test:affected']) {
        const result = run(f, ['run', command]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(diagnostic);
        expect(result.output).not.toContain('QUALITY_A');
        expect(result.output).not.toContain('ASSURANCE_RAN');
      }
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

for (const { allowSkipped, mixedCode, mixedDiagnostic, noneDiagnostic } of [
  {
    allowSkipped: undefined,
    mixedCode: 0,
    mixedDiagnostic: 'QUALITY_A',
    noneDiagnostic: '未実行:',
  },
  { allowSkipped: true, mixedCode: 0, mixedDiagnostic: 'QUALITY_A', noneDiagnostic: '未実行:' },
  {
    allowSkipped: false,
    mixedCode: 1,
    mixedDiagnostic: '許可されていないskipがあります',
    noneDiagnostic: '許可されていないskipがあります',
  },
]) {
  test(`Bun生成入口はallowSkipped=${String(allowSkipped)}でskip・todoと未実行を区別する`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({ ...config, allowSkipped }),
      },
      async (f) => {
        apply(f);
        const control = run(f, ['run', 'check:feedback']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain('QUALITY_A');
        expect(control.output).toContain('QUALITY_B');
        for (const unexecuted of [
          header + "test.skip('unexecuted', () => expect(1).toBe(2));\n",
          header + "test.todo('unexecuted', () => expect(1).toBe(2));\n",
        ]) {
          await writeFile(join(f.repo, 'test/b.test.ts'), unexecuted);
          const mixed = run(f, ['run', 'check:feedback']);
          expect(mixed.output).toContain('QUALITY_A');
          expect(mixed.code, mixed.output).toBe(mixedCode);
          expect(mixed.output).toContain(mixedDiagnostic);
          await writeFile(join(f.repo, 'test/a.test.ts'), unexecuted);
          const none = run(f, ['run', 'check:feedback']);
          expect(none.code, none.output).not.toBe(0);
          expect(none.output).toContain(noneDiagnostic);
          expect(none.output).not.toContain('QUALITY_A');
          expect(none.output).not.toContain('ASSURANCE_RAN');
          await writeFile(join(f.repo, 'test/a.test.ts'), files['test/a.test.ts']);
        }
        // 許容設定がassertion失敗まで許容しないことと、修正後の回復を確認する。
        await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts']);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
        const failed = run(f, ['run', 'check:feedback']);
        expect(failed.code, failed.output).not.toBe(0);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const repaired = run(f, ['run', 'check:feedback']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output).toContain('QUALITY_A');
      },
    );
  });
}

test('明示依存の入力とquality自身を同時に変更しても、変更したテストを実行する', async () => {
  await fixture(files, async (f) => {
    const normal = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
    expect(normal.code, normal.output).toBe(0);
    expect(normal.output).toContain('QUALITY_B');
    const changedTest =
      header + "test('changed', () => { console.log('CHANGED_QUALITY_B'); expect(1).toBe(2); });\n";
    await writeFile(join(f.repo, 'test/b.test.ts'), changedTest);
    const direct = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
    expect(direct.code, direct.output).toBe(1);
    expect(direct.output).toContain('CHANGED_QUALITY_B');
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts']);
    apply(f);
    commitFixture(f.repo, 'configured');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const recorded = run(f, ['run', 'test:affected']);
    expect(recorded.code, recorded.output).toBe(0);
    expect(recorded.output).toContain('QUALITY_A');
    expect(recorded.output).toContain('QUALITY_B');
    await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
    await writeFile(join(f.repo, 'data/value.json'), '{"value":2}\n');
    const control = run(f, ['run', 'check:feedback']);
    expect(control.code, control.output).toBe(0);
    expect(control.output).toContain('QUALITY_A');
    await writeFile(
      join(f.repo, 'test/b.test.ts'),
      header +
        "test('changed', () => { console.log('CHANGED_QUALITY_B_SUCCESS'); expect(1).toBe(1); });\n",
    );
    const successfulMixed = run(f, ['run', 'check:feedback']);
    expect(successfulMixed.code, successfulMixed.output).toBe(0);
    expect(successfulMixed.output).toContain('QUALITY_A');
    expect(successfulMixed.output).toContain('CHANGED_QUALITY_B_SUCCESS');
    expect(successfulMixed.output).toContain('quality選択: 2');
    expect(successfulMixed.output).not.toContain('quality全件の理由:');
    expect(successfulMixed.output).not.toContain('ASSURANCE_RAN');
    await writeFile(join(f.repo, 'test/b.test.ts'), changedTest);
    const mixed = run(f, ['run', 'check:feedback']);
    expect(mixed.output).toContain('CHANGED_QUALITY_B');
    expect(mixed.output).not.toContain('ASSURANCE_RAN');
    expect(mixed.code, mixed.output).toBe(1);
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts'] + '// changed\n');
    const repaired = run(f, ['run', 'check:feedback']);
    expect(repaired.code, repaired.output).toBe(0);
    expect(repaired.output).toContain('QUALITY_A');
    expect(repaired.output).toContain('QUALITY_B');
  });
}, 60000);

for (const { name, breakInput, restoreInput, stageChange } of [
  {
    name: 'delete',
    breakInput: (original: string) => unlink(original),
    restoreInput: (original: string) => writeFile(original, files['data/value.json']),
    stageChange: (_f: Fixture) => {},
  },
  {
    name: 'rename',
    breakInput: (original: string, moved: string) => rename(original, moved),
    restoreInput: (original: string, moved: string) => rename(moved, original),
    // 改名先も既知の入力にし、未知入力による全件実行で旧パスの欠落を隠さない。
    stageChange: (f: Fixture) => git(f.repo, 'add', 'data/value.json', 'data/moved.json'),
  },
]) {
  test(`生成入口は既知変更と${name}の旧パスの影響先を両方実行する`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({
          ...config,
          dependencies: [
            { inputs: ['data/value.json'], tests: ['test/b.test.ts'] },
            { inputs: ['data/moved.json'], tests: ['test/a.test.ts'] },
          ],
        }),
        'test/b.test.ts':
          header +
          "import { existsSync } from 'node:fs'; test('required input', () => { console.log('OLD_PATH_QUALITY'); expect(existsSync('data/value.json')).toBe(true); });\n",
      },
      async (f) => {
        const original = join(f.repo, 'data/value.json');
        const moved = join(f.repo, 'data/moved.json');
        const control = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain('OLD_PATH_QUALITY');
        await breakInput(original, moved);
        const direct = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
        expect(direct.code, direct.output).toBe(1);
        expect(direct.output).toContain('OLD_PATH_QUALITY');
        await restoreInput(original, moved);

        apply(f);
        commitFixture(f.repo, '旧パスの依存を設定');
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const recorded = run(f, ['run', 'test:affected']);
        expect(recorded.code, recorded.output).toBe(0);
        expect(recorded.output).toContain('QUALITY_A');
        expect(recorded.output).toContain('OLD_PATH_QUALITY');
        await breakInput(original, moved);
        stageChange(f);
        const affected = run(f, ['run', 'check:feedback']);
        expect(affected.output).toContain('QUALITY_A');
        expect(affected.output).toContain('OLD_PATH_QUALITY');
        expect(affected.output).not.toContain('ASSURANCE_RAN');
        expect(affected.code, affected.output).toBe(1);

        await writeFile(original, files['data/value.json']);
        const repaired = run(f, ['run', 'check:feedback']);
        expect(repaired.code, repaired.output).toBe(0);
      },
    );
  }, 60000);
}

test('未commitの設定Bで取得した記録を、設定Aへ戻して部分選択の根拠にしない', async () => {
  await fixture(files, async (f) => {
    apply(f);
    commitFixture(f.repo, 'configuration A');
    const alternate = structuredClone(config);
    alternate.assurance.push({ path: 'test/b.test.ts', reason: '資源解放だけを検証する対照' });
    await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(alternate));
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const control = run(f, ['run', 'test:affected']);
      expect(control.code, control.output).toBe(0);
      expect(control.output).toContain('QUALITY_A');
      expect(control.output).not.toContain('QUALITY_B');
      expect(control.output).not.toContain('ASSURANCE_RAN');
    }
    // Gitの差分から設定変更が消えても、記録時の設定との不一致は残る。
    await writeFile(join(f.repo, '.feedback-loop.json'), files['.feedback-loop.json']);
    expect(git(f.repo, 'diff', '--name-only')).toBe('src/input.ts');
    const restored = run(f, ['run', 'check:feedback']);
    expect(restored.code, restored.output).toBe(0);
    expect(restored.output).toContain('QUALITY_A');
    expect(restored.output).toContain('QUALITY_B');
    expect(restored.output).not.toContain('ASSURANCE_RAN');
    expect(restored.output).toContain('quality全件の理由:');
  });
}, 60000);

test('bunArgsの--no-env-fileを生成入口でも保ち、外側のBunによる先行読込みを防ぐ', async () => {
  const sentinel = 'FEEDBACK_LOOP_ENV_SENTINEL';
  await fixture(
    {
      ...files,
      '.env': `${sentinel}=fixture_only_no_secret\n`,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        collect: [process.execPath, '--no-env-file', 'scripts/collect.ts'],
        globalChanges: ['scripts/**', 'src/**'],
      }),
      'scripts/collect.ts':
        `if (process.env.${sentinel}) throw new Error('COLLECT_ENV_LEAK');\n` +
        files['scripts/collect.ts'],
      'test/b.test.ts':
        header +
        `test('env', () => { console.log('ENV_QUALITY'); expect(process.env.${sentinel}).toBeUndefined(); });\n`,
    },
    async (f) => {
      const env = { [sentinel]: undefined };
      // fixtureの.envが有効で、既存の保護引数なら読まないことを先に確認する。
      const control = run(f, ['--no-env-file', 'test', './test/b.test.ts'], env);
      expect(control.code, control.output).toBe(0);
      expect(control.output).toContain('ENV_QUALITY');
      const unprotected = run(f, ['test', './test/b.test.ts'], env);
      expect(unprotected.code, unprotected.output).toBe(1);
      expect(unprotected.output).toContain('fixture_only_no_secret');
      apply(f, ['--no-env-file']);
      commitFixture(f.repo, 'protected entrypoints');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      for (const { command, markers } of [
        { command: 'check:classification', markers: [] },
        { command: 'test:affected', markers: ['QUALITY_A', 'ENV_QUALITY'] },
        { command: 'check:feedback', markers: ['QUALITY_A', 'ENV_QUALITY'] },
      ]) {
        const result = run(f, ['--no-env-file', 'run', command], env);
        expect(result.code, result.output).toBe(0);
        expect(result.output).not.toContain('COLLECT_ENV_LEAK');
        for (const marker of markers) {
          expect(result.output).toContain(marker);
        }
        expect(result.output).not.toContain('ASSURANCE_RAN');
      }
    },
  );
}, 60000);
