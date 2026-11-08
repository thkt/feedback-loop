import { applyFeedback } from './support/feedback-loop-batch.ts';
import { commitFixture } from './support/runner-affected.ts';
import {
  fakeVitest,
  passedVitestReportSource,
  vitestConfig as createVitestConfig,
} from './support/fake-vitest.ts';
import {
  cliConfig as config,
  cliFiles as files,
  runSetup as run,
  snapshot,
} from './support/feedback-loop-batch.ts';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, fixture, git, header } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';

// references/contract.mdの公開入口を使う。
// 内部export・記録形式・生成ファイルの分割は期待値にしない。

function apply(f: Fixture, bunArgs: string[] = []) {
  const result = applyFeedback(
    f,
    'bun scripts/probe.ts && bun run test:affected',
    (fixture, args) => run(fixture, [...bunArgs, ...args]),
  );
  expect(result.code, result.output).toBe(0);
}

for (const [manager, runner] of [
  ['bun', 'bun'],
  ['npm', 'vitest'],
  ['npm', 'bun'],
  ['bun', 'vitest'],
] as const) {
  test(`生成入口は${manager}管理・${runner} runnerに対応する再実行方法を案内する`, async () => {
    const targetConfig = {
      ...(runner === 'vitest' ? createVitestConfig(config) : config),
      runner,
      prepare: [process.execPath, 'scripts/prepare.ts'],
    };
    await fixture(
      {
        ...files,
        'package.json': JSON.stringify({
          private: true,
          type: 'module',
          packageManager: manager === 'bun' ? 'bun@1.4.4' : 'npm@11.0.0',
          scripts: { check: 'echo existing' },
        }),
        '.feedback-loop.json': JSON.stringify(targetConfig),
        'scripts/prepare.ts': "console.log('PREPARE_RAN');\n",
        ...(runner === 'vitest'
          ? {
              ...fakeVitest({
                cli: `import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
console.log('VITEST_CLI_RAN');
const selected = process.argv.filter(value => value.startsWith('test/') && value.endsWith('.test.ts'));
const argument = process.argv.find(value => value.startsWith('--outputFile='));
if (!argument) throw new Error('JSON report output was not requested');
writeFileSync(argument.slice('--outputFile='.length), JSON.stringify(${passedVitestReportSource('selected', true)}));\n`,
                relevant: ['test/a.test.ts', 'test/b.test.ts'],
              }),
            }
          : {}),
      },
      async (f) => {
        const applied = applyFeedback(f, `${manager} run test:affected`, run);
        expect(applied.code, applied.output).toBe(0);
        for (const script of ['check:classification', 'test:affected']) {
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
          expect(managers.length, output).toBeGreaterThanOrEqual(
            script === 'check:classification' ? 1 : 3,
          );
          expect(new Set(managers), output).toEqual(new Set([manager]));
          if (script === 'test:affected') {
            expect(output).toContain('PREPARE_RAN');
            expect(output).toContain(runner === 'bun' ? 'QUALITY_A' : 'VITEST_CLI_RAN');
            expect(output).toContain('quality選択: 2');
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
      for (const failed of [false, true, false]) {
        await writeFile(log, '');
        await writeFile(ready, 'not ready');
        const result = run(f, ['run', 'check:feedback'], {
          ...env,
          PREPARE_FAIL: failed ? '1' : '0',
        });
        if (failed) {
          expect(result.code, result.output).not.toBe(0);
          expect(result.output).toContain('PREPARE_DIAGNOSTIC');
          expect(result.output).toContain('rerun: bun run check:feedback');
          expect(result.output).not.toContain('PREPARED_QUALITY');
          expect(result.output).not.toContain('QUALITY_B');
          expect(await readFile(log, 'utf8')).toBe('prepare\n');
        } else {
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain('PREPARED_QUALITY');
          expect(result.output).toContain('QUALITY_B');
          expect(await readFile(log, 'utf8')).toBe('prepare\ntest\n');
        }
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
    expect(failed.output).toContain('1 fail');
    expect(failed.code, failed.output).not.toBe(0);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const repaired = run(f, ['run', 'test:affected']);
    expect(repaired.code, repaired.output).toBe(0);
  });
});

for (const scenario of ['failed', 'invalid-json', 'duplicate', 'missing', 'omitted']) {
  test(`導入後の収集が${scenario}なら分類検査と関連実行を成功扱いしない`, async () => {
    await fixture(files, async (f) => {
      apply(f);
      const control = run(f, ['run', 'check:classification']);
      expect(control.code, control.output).toBe(0);
      let source: string;
      if (scenario === 'failed') {
        source = "console.error('COLLECTION_FAILURE'); process.exit(7);\n";
      } else if (scenario === 'invalid-json') {
        source = "console.log('not JSON');\n";
      } else {
        const paths = ['test/a.test.ts', 'test/b.test.ts', 'test/assurance.test.ts'];
        if (scenario === 'duplicate') {
          paths.push('test/a.test.ts');
        } else if (scenario === 'missing') {
          paths.push('test/nonexistent.test.ts');
        } else {
          paths.pop();
        }
        source = `console.log(${JSON.stringify(JSON.stringify(paths))});\n`;
      }
      await writeFile(join(f.repo, 'scripts/collect.ts'), source);
      const before = await snapshot(f.repo);
      for (const command of ['check:classification', 'test:affected']) {
        const result = run(f, ['run', command]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(
          {
            failed: 'COLLECTION_FAILURE',
            'invalid-json': 'JSON Parse error:',
            duplicate: '収集結果が重複しています',
            missing: '集合が一致しません',
            omitted: '集合が一致しません',
          }[scenario] ?? '原因の診断がありません',
        );
        expect(result.output).not.toContain('QUALITY_A');
        expect(result.output).not.toContain('ASSURANCE_RAN');
      }
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

for (const allowSkipped of [undefined, true, false]) {
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
        for (const kind of ['skip', 'todo']) {
          const unexecuted = header + `test.${kind}('unexecuted', () => expect(1).toBe(2));\n`;
          await writeFile(join(f.repo, 'test/b.test.ts'), unexecuted);
          const mixed = run(f, ['run', 'check:feedback']);
          expect(mixed.output).toContain('QUALITY_A');
          if (allowSkipped === false) {
            expect(mixed.code, mixed.output).not.toBe(0);
            expect(mixed.output).toContain('許可されていないskipがあります');
          } else {
            expect(mixed.code, mixed.output).toBe(0);
          }
          await writeFile(join(f.repo, 'test/a.test.ts'), unexecuted);
          const none = run(f, ['run', 'check:feedback']);
          expect(none.code, none.output).not.toBe(0);
          expect(none.output).toContain(
            allowSkipped === false ? '許可されていないskipがあります' : '未実行:',
          );
          expect(none.output).not.toContain('QUALITY_A');
          expect(none.output).not.toContain('ASSURANCE_RAN');
          await writeFile(join(f.repo, 'test/a.test.ts'), files['test/a.test.ts']);
        }
        // 許容設定がassertion失敗まで許容しないことと、修正後の回復を確認する。
        await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts']);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
        const failed = run(f, ['run', 'check:feedback']);
        expect(failed.code, failed.output).not.toBe(0);
        expect(failed.output).toContain('toBeLessThan');
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
    expect(direct.output).toContain('1 fail');
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
    expect(mixed.output).toContain('1 fail');
    expect(mixed.output).not.toContain('ASSURANCE_RAN');
    expect(mixed.code, mixed.output).toBe(1);
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts'] + '// changed\n');
    const repaired = run(f, ['run', 'check:feedback']);
    expect(repaired.code, repaired.output).toBe(0);
    expect(repaired.output).toContain('QUALITY_A');
    expect(repaired.output).toContain('QUALITY_B');
  });
}, 60000);

for (const operation of ['delete', 'rename']) {
  test(`生成入口は既知変更と${operation}の旧パスの影響先を両方実行する`, async () => {
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
        if (operation === 'delete') {
          await unlink(original);
        } else {
          await rename(original, moved);
        }
        const direct = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
        expect(direct.code, direct.output).toBe(1);
        expect(direct.output).toContain('OLD_PATH_QUALITY');
        expect(direct.output).toContain('1 fail');
        if (operation === 'rename') {
          await rename(moved, original);
        } else {
          await writeFile(original, files['data/value.json']);
        }

        apply(f);
        commitFixture(f.repo, '旧パスの依存を設定');
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const recorded = run(f, ['run', 'test:affected']);
        expect(recorded.code, recorded.output).toBe(0);
        expect(recorded.output).toContain('QUALITY_A');
        expect(recorded.output).toContain('OLD_PATH_QUALITY');
        if (operation === 'delete') {
          await unlink(original);
        } else {
          await rename(original, moved);
          // 改名先も既知の入力にし、未知入力による全件実行で旧パスの欠落を隠さない。
          git(f.repo, 'add', 'data/value.json', 'data/moved.json');
        }
        const affected = run(f, ['run', 'check:feedback']);
        expect(affected.output).toContain('QUALITY_A');
        expect(affected.output).toContain('OLD_PATH_QUALITY');
        expect(affected.output).toContain('1 fail');
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
      expect(unprotected.output).toContain('1 fail');
      apply(f, ['--no-env-file']);
      commitFixture(f.repo, 'protected entrypoints');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      for (const command of ['check:classification', 'test:affected', 'check:feedback']) {
        const result = run(f, ['--no-env-file', 'run', command], env);
        expect(result.code, result.output).toBe(0);
        expect(result.output).not.toContain('COLLECT_ENV_LEAK');
        if (command !== 'check:classification') {
          expect(result.output).toContain('QUALITY_A');
          expect(result.output).toContain('ENV_QUALITY');
          expect(result.output).not.toContain('ASSURANCE_RAN');
        }
      }
    },
  );
}, 60000);
