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

for (const { manager, otherManager, runner, packageManager, runnerConfig, testHeader } of [
  {
    manager: 'bun',
    otherManager: 'npm',
    runner: 'bun',
    packageManager: 'bun@1.4.4',
    runnerConfig: config,
    testHeader: header,
  },
  {
    manager: 'npm',
    otherManager: 'bun',
    runner: 'vitest',
    packageManager: 'npm@11.0.0',
    runnerConfig: createVitestConfig(config),
    testHeader: vitestHeader,
  },
  {
    manager: 'npm',
    otherManager: 'bun',
    runner: 'bun',
    packageManager: 'npm@11.0.0',
    runnerConfig: config,
    testHeader: header,
  },
  {
    manager: 'bun',
    otherManager: 'npm',
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
        const applied = applyFeedback(f, `${manager} run check:affected`, run);
        expect(applied.code, applied.output).toBe(0);
        const runScript = (script: string) => {
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
          return output;
        };
        const classified = runScript('check:classification');
        expect(classified).toContain(`再実行: ${manager} run check:classification`);
        expect(classified).not.toContain(`再実行: ${otherManager} run`);
        const affected = runScript('check:affected');
        expect(affected).toContain(`再実行: ${manager} run check:affected`);
        expect(affected).not.toContain(`再実行: ${otherManager} run`);
        expect(affected).toContain('PREPARE_RAN');
        expect(affected).toContain('QUALITY_A');
        expect(affected).toContain('quality選択: 2');
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
      const feedback = async (prepareFail: string) => {
        await writeFile(log, '');
        await writeFile(ready, 'not ready');
        return run(f, ['run', 'check:feedback'], { ...env, PREPARE_FAIL: prepareFail });
      };

      const prepared = await feedback('0');
      expect(prepared.code, prepared.output).toBe(0);
      expect(prepared.output).toContain('PREPARED_QUALITY');
      expect(prepared.output).toContain('QUALITY_B');
      expect(await readFile(log, 'utf8')).toBe('prepare\ntest\n');

      const failed = await feedback('1');
      expect(failed.code, failed.output).toBe(1);
      expect(failed.output).toContain('PREPARE_DIAGNOSTIC');
      expect(failed.output).toContain('rerun: bun run check:feedback');
      expect(failed.output).not.toContain('PREPARED_QUALITY');
      expect(failed.output).not.toContain('QUALITY_B');
      expect(await readFile(log, 'utf8')).toBe('prepare\n');

      // 準備の失敗の後も、次の実行は準備からやり直す。
      const repaired = await feedback('0');
      expect(repaired.code, repaired.output).toBe(0);
      expect(repaired.output).toContain('PREPARED_QUALITY');
      expect(repaired.output).toContain('QUALITY_B');
      expect(await readFile(log, 'utf8')).toBe('prepare\ntest\n');
    },
  );
});

test('生成入口は新規qualityを収集し、未知入力を既知依存と混ぜても全qualityへ広げる', async () => {
  await fixture(files, async (f) => {
    apply(f);
    commitFixture(f.repo, 'configured');
    // 最初の全件実行で依存記録を作る。
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const recorded = run(f, ['run', 'check:affected']);
    expect(recorded.code, recorded.output).toBe(0);
    await writeFile(
      join(f.repo, 'test/new.test.ts'),
      header + "test('new', () => { console.log('NEW_QUALITY'); expect(1).toBe(1); });\n",
    );
    await writeFile(join(f.repo, 'unknown.txt'), 'unmapped input');
    const mixed = run(f, ['run', 'check:affected']);
    expect(mixed.code, mixed.output).toBe(0);
    expect(mixed.stdout.split('\n')).toContain('quality全件の理由: unknown.txt');
    expect(mixed.output).toContain('QUALITY_A');
    expect(mixed.output).toContain('QUALITY_B');
    expect(mixed.output).toContain('NEW_QUALITY');
    expect(mixed.output).not.toContain('ASSURANCE_RAN');
  });
});

// diagnosticは、出力のうち1行に一致する正規表現である。行の末尾まで一致させ、余分な表示がないことも確かめる。
for (const { scenario, command, source, diagnostic } of [
  {
    scenario: '失敗',
    command: 'check:classification',
    source: "console.error('COLLECTION_FAILURE'); process.exit(7);\n",
    diagnostic: /^COLLECTION_FAILURE$[\s\S]*^feedback-loop未完了: 検査失敗または取消: 7$/m,
  },
  {
    scenario: '失敗',
    command: 'check:affected',
    source: "console.error('COLLECTION_FAILURE'); process.exit(7);\n",
    diagnostic: /^COLLECTION_FAILURE$[\s\S]*^feedback-loop未完了: 検査失敗または取消: 7$/m,
  },
  {
    scenario: 'JSONでない出力',
    command: 'check:classification',
    source: "console.log('not JSON');\n",
    diagnostic:
      /^feedback-loop未完了: 収集用コマンドの標準出力をJSONとして読めません。標準出力にはJSONの文字列配列だけを出し、診断は標準エラーへ出してください。理由: .+。標準出力の先頭: "not JSON\\n"$/m,
  },
  {
    scenario: '空の出力',
    command: 'check:classification',
    source: '\n',
    diagnostic:
      /^feedback-loop未完了: 収集用コマンドの標準出力をJSONとして読めません。.+。標準出力の先頭: ""$/m,
  },
  {
    // 標準出力は、先頭と末尾の200文字だけを表示する。理由も200文字までにする。
    scenario: '長い出力',
    command: 'check:classification',
    source: "console.log('x'.repeat(200) + 'MIDDLE'.repeat(100) + 'y'.repeat(199));\n",
    diagnostic:
      /^feedback-loop未完了: 収集用コマンドの標準出力をJSONとして読めません。標準出力にはJSONの文字列配列だけを出し、診断は標準エラーへ出してください。理由: [^\n]{1,200}。標準出力の先頭: "x{200}"。標準出力の末尾: "y{199}\\n"$/m,
  },
  {
    // JSONとして読めても、空でない文字列だけの配列でなければ、混ざった出力とは別の診断にする。
    scenario: '配列でないJSON',
    command: 'check:classification',
    source: "console.log('{}');\n",
    diagnostic:
      /^feedback-loop未完了: 収集用コマンドの標準出力はJSONですが、空でない文字列だけの配列ではありません。標準出力の先頭: "\{\}\\n"$/m,
  },
  {
    scenario: '空の文字列を含む配列',
    command: 'check:classification',
    source: `console.log('[""]');\n`,
    diagnostic:
      /^feedback-loop未完了: 収集用コマンドの標準出力はJSONですが、空でない文字列だけの配列ではありません。標準出力の先頭: "\[\\"\\"\]\\n"$/m,
  },
  {
    scenario: '重複したパス',
    command: 'check:classification',
    source: `console.log('["test/a.test.ts","test/b.test.ts","test/assurance.test.ts","test/a.test.ts"]');\n`,
    diagnostic: /^feedback-loop未完了: 収集結果が重複しています$/m,
  },
]) {
  test(`導入後の収集が${scenario}なら、${command}を成功扱いしない`, async () => {
    await fixture(files, async (f) => {
      apply(f);
      await writeFile(join(f.repo, 'scripts/collect.ts'), source);
      const before = await snapshot(f.repo);
      const result = run(f, ['run', command]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toMatch(diagnostic);
      expect(result.output).not.toContain('QUALITY_A');
      expect(result.output).not.toContain('ASSURANCE_RAN');
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

const skipped = header + "test.skip('unexecuted', () => expect(1).toBe(2));\n";
const todo = header + "test.todo('unexecuted', () => expect(1).toBe(2));\n";

// allowSkippedの既定はtrueである。全件が未実行なら、許可していても成功にしない。
for (const { allowSkipped, kind, unexecuted, mixedCode, mixedDiagnostic, noneDiagnostic } of [
  {
    allowSkipped: undefined,
    kind: 'skip',
    unexecuted: skipped,
    mixedCode: 0,
    mixedDiagnostic: '選択したqualityが成功しました',
    noneDiagnostic: '未実行: 選択したテストがすべてskipされています',
  },
  {
    allowSkipped: undefined,
    kind: 'todo',
    unexecuted: todo,
    mixedCode: 0,
    mixedDiagnostic: '選択したqualityが成功しました',
    noneDiagnostic: '未実行: 選択したテストがすべてskipされています',
  },
  {
    allowSkipped: false,
    kind: 'skip',
    unexecuted: skipped,
    mixedCode: 1,
    mixedDiagnostic: '許可されていないskipがあります',
    noneDiagnostic: '許可されていないskipがあります',
  },
  {
    allowSkipped: false,
    kind: 'todo',
    unexecuted: todo,
    mixedCode: 1,
    mixedDiagnostic: '許可されていないskipがあります',
    noneDiagnostic: '許可されていないskipがあります',
  },
]) {
  test(`Bun生成入口はallowSkipped=${String(allowSkipped)}で、${kind}を含む実行と全件の未実行を区別する`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({ ...config, allowSkipped }),
      },
      async (f) => {
        apply(f);
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
      },
    );
  });
}

test('明示依存の入力とquality自身を同時に変更しても、変更したテストを実行する', async () => {
  await fixture(files, async (f) => {
    const changedTest =
      header + "test('changed', () => { console.log('CHANGED_QUALITY_B'); expect(1).toBe(2); });\n";
    apply(f);
    commitFixture(f.repo, 'configured');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const recorded = run(f, ['run', 'check:affected']);
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

// bはdata/value.jsonがあることを確かめる。data/value.jsonはbへ、改名先のdata/moved.jsonはaへ明示依存で対応する。
const oldPathFiles = {
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
};

test('入力を削除すると、削除したパスに対応するqualityも実行して失敗を返す', async () => {
  await fixture(oldPathFiles, async (f) => {
    apply(f);
    commitFixture(f.repo, '旧パスの依存を設定');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const recorded = run(f, ['run', 'check:affected']);
    expect(recorded.code, recorded.output).toBe(0);
    expect(recorded.output).toContain('QUALITY_A');
    expect(recorded.output).toContain('OLD_PATH_QUALITY');

    await unlink(join(f.repo, 'data/value.json'));
    const affected = run(f, ['run', 'check:feedback']);
    expect(affected.output).toContain('QUALITY_A');
    expect(affected.output).toContain('OLD_PATH_QUALITY');
    expect(affected.output).not.toContain('ASSURANCE_RAN');
    expect(affected.code, affected.output).toBe(1);

    await writeFile(join(f.repo, 'data/value.json'), files['data/value.json']);
    const repaired = run(f, ['run', 'check:feedback']);
    expect(repaired.code, repaired.output).toBe(0);
  });
}, 60000);

test('入力を改名すると、改名前のパスに対応するqualityも実行して失敗を返す', async () => {
  await fixture(oldPathFiles, async (f) => {
    apply(f);
    commitFixture(f.repo, '旧パスの依存を設定');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const recorded = run(f, ['run', 'check:affected']);
    expect(recorded.code, recorded.output).toBe(0);
    expect(recorded.output).toContain('QUALITY_A');
    expect(recorded.output).toContain('OLD_PATH_QUALITY');

    await rename(join(f.repo, 'data/value.json'), join(f.repo, 'data/moved.json'));
    // 改名先も既知の入力にし、未知入力による全件実行で旧パスの欠落を隠さない。
    git(f.repo, 'add', 'data/value.json', 'data/moved.json');
    const affected = run(f, ['run', 'check:feedback']);
    expect(affected.output).toContain('QUALITY_A');
    expect(affected.output).toContain('OLD_PATH_QUALITY');
    expect(affected.output).not.toContain('ASSURANCE_RAN');
    expect(affected.code, affected.output).toBe(1);

    await writeFile(join(f.repo, 'data/value.json'), files['data/value.json']);
    const repaired = run(f, ['run', 'check:feedback']);
    expect(repaired.code, repaired.output).toBe(0);
  });
}, 60000);

test('未commitの設定Bで取得した記録を、設定Aへ戻して部分選択の根拠にしない', async () => {
  await fixture(files, async (f) => {
    apply(f);
    commitFixture(f.repo, 'configuration A');
    // 設定Bでは、bもassuranceである。
    const alternate = {
      ...config,
      assurance: [
        ...config.assurance,
        { path: 'test/b.test.ts', reason: '資源解放だけを検証する対照' },
      ],
    };
    await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(alternate));
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const recordedWithB = run(f, ['run', 'check:affected']);
    expect(recordedWithB.code, recordedWithB.output).toBe(0);
    expect(recordedWithB.output).toContain('QUALITY_A');
    expect(recordedWithB.output).not.toContain('QUALITY_B');
    expect(recordedWithB.output).not.toContain('ASSURANCE_RAN');
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
      // 保護引数がなければ、Bunがfixtureの.envを読むことを先に確認する。
      const unprotected = run(f, ['test', './test/b.test.ts'], env);
      expect(unprotected.code, unprotected.output).toBe(1);
      expect(unprotected.output).toContain('fixture_only_no_secret');
      apply(f, ['--no-env-file']);
      commitFixture(f.repo, 'protected entrypoints');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const classified = run(f, ['--no-env-file', 'run', 'check:classification'], env);
      expect(classified.code, classified.output).toBe(0);
      expect(classified.output).not.toContain('COLLECT_ENV_LEAK');

      const affected = run(f, ['--no-env-file', 'run', 'check:affected'], env);
      expect(affected.code, affected.output).toBe(0);
      expect(affected.output).not.toContain('COLLECT_ENV_LEAK');
      expect(affected.output).toContain('QUALITY_A');
      expect(affected.output).toContain('ENV_QUALITY');
      expect(affected.output).not.toContain('ASSURANCE_RAN');

      const feedback = run(f, ['--no-env-file', 'run', 'check:feedback'], env);
      expect(feedback.code, feedback.output).toBe(0);
      expect(feedback.output).not.toContain('COLLECT_ENV_LEAK');
      expect(feedback.output).toContain('QUALITY_A');
      expect(feedback.output).toContain('ENV_QUALITY');
      expect(feedback.output).not.toContain('ASSURANCE_RAN');
    },
  );
}, 60000);
