import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyFeedback,
  config,
  files,
  fixture,
  header,
  installed,
  observations,
  recordFile,
  run,
  seed,
  traceFile,
  type Fixture,
} from './support/feedback-loop-batch.ts';

const names = ['a', 'b', 'c', 'd', 'e'];
// 各テストは、実行されたことを名前の1行で記録します。
const tests = Object.fromEntries(
  names.map((name, index) => [
    `test/${name}.test.ts`,
    `${header}import { appendFileSync } from 'node:fs';
import { state } from './state.ts';
${index < 2 ? "import { value } from '../src/input.ts';" : ''}
test('${name}', () => {
  expect(state.used).toBe(false);
  state.used = true;
  expect(Reflect.has(globalThis, 'feedbackBatchOwner')).toBe(false);
  Reflect.set(globalThis, 'feedbackBatchOwner', '${name}');
  ${index < 2 ? 'expect(value).toBeGreaterThan(0);' : ''}
  appendFileSync(process.env.FEEDBACK_TRACE, '${name}\\n');
});\n`,
  ]),
);

/** 実行されたテストの名前を返し、記録を空にする。 */
async function executed(f: Fixture) {
  const names = (await observations(f)).toSorted();
  await writeFile(traceFile(f), '');
  return names;
}

for (const { workers, limit } of [
  { workers: undefined, limit: 4 },
  { workers: 1, limit: 1 },
  { workers: 2, limit: 2 },
]) {
  test(`bunWorkers=${String(workers)}で、ファイル間の状態を引き継がず、設定した並列数で、関連するqualityと明示依存のqualityを実行する`, async () => {
    await fixture(
      {
        ...files,
        ...tests,
        'test/state.ts': 'export const state = { used: false };\n',
        'data/input.json': '{"value":1}\n',
        '.feedback-loop.json': JSON.stringify({
          ...config,
          bunWorkers: workers,
          dependencies: [
            { inputs: ['data/input.json'], tests: ['test/c.test.ts', 'test/d.test.ts'] },
          ],
        }),
      },
      async (f) => {
        installed(f);
        const affected = () => run(f, ['run', 'test:affected'], { FEEDBACK_TRACE: traceFile(f) });
        await writeFile(traceFile(f), '');
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const initial = affected();
        expect(initial.code, initial.output).toBe(0);
        // 並列数の上限は、Bunへ渡すコマンドで確かめます。その数で動かすのはBunの責任です。
        expect(initial.output).toContain(` --parallel=${limit} `);
        expect(await executed(f), initial.output).toEqual(names);

        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
        await writeFile(join(f.repo, 'data/input.json'), '{"value":2}\n');
        const selected = affected();
        expect(selected.code, selected.output).toBe(0);
        expect(selected.output).toContain(` --parallel=${limit} `);
        expect(await executed(f), selected.output).toEqual(['a', 'b', 'c', 'd']);
        expect(selected.output).toContain('quality候補: 5');
        expect(selected.output).toContain('quality選択: 4');
        expect(selected.output).not.toContain('quality全件の理由:');
      },
    );
  });
}

test('bunArgsのnullは配置前に拒否する', async () => {
  await fixture(files, async (f) => {
    const originalPackage = await readFile(join(f.repo, 'package.json'), 'utf8');
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({ ...config, bunArgs: null }),
    );
    const rejected = applyFeedback(f, 'bun run test:affected', run);
    expect(rejected.code, rejected.output).not.toBe(0);
    expect(rejected.output).toContain('文字列配列');
    expect(existsSync(join(f.repo, 'scripts/feedback-loop'))).toBe(false);
    expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(originalPackage);
  });
});

test('不正なbunWorkersと、bunWorkersと競合するCLI引数は配置前に拒否する', async () => {
  await fixture(files, async (f) => {
    const originalPackage = await readFile(join(f.repo, 'package.json'), 'utf8');
    const invalid = [
      ...[0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map((bunWorkers) => ({
        value: { ...config, bunWorkers },
        diagnostic: 'bunWorkersは正の安全な整数で指定してください',
      })),
      {
        value: { ...config, runner: 'vitest', bunArgs: [], bunWorkers: 2 },
        diagnostic: 'VitestにはbunWorkersを指定できません',
      },
      ...['bunArgs', 'testArgs'].flatMap((key) =>
        ['--isolate', '--no-isolate', '--parallel', '--parallel=2', '--no-parallel'].map(
          (flag) => ({
            value: { ...config, [key]: [flag] },
            diagnostic: 'テストファイルごとの分離は固定です。並列数はbunWorkersで指定してください',
          }),
        ),
      ),
    ];
    for (const { value, diagnostic } of invalid) {
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(value));
      const rejected = applyFeedback(f, 'bun run test:affected', run);
      expect(rejected.code, JSON.stringify(value) + '\n' + rejected.output).not.toBe(0);
      expect(rejected.output).toContain(diagnostic);
      expect(existsSync(join(f.repo, 'scripts/feedback-loop'))).toBe(false);
      expect(await readFile(join(f.repo, 'package.json'), 'utf8')).toBe(originalPackage);
    }
  });
});

for (const { input, packageJson, initialInput, testSource } of [
  {
    input: 'package.json',
    packageJson: files['package.json'],
    initialInput: files['package.json'],
    testSource: `${header}import '../package.json'; test('a', () => expect(1).toBe(1));\n`,
  },
  {
    input: 'tsconfig.json',
    packageJson: files['package.json'],
    initialInput: '{}\n',
    testSource: `${header}import '../tsconfig.json'; test('a', () => expect(1).toBe(1));\n`,
  },
  {
    input: 'bun.lock',
    packageJson: files['package.json'],
    initialInput: '{}\n',
    testSource: `${header}test('a', () => expect(1).toBe(1));\n`,
  },
  {
    input: 'package-lock.json',
    packageJson: JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'npm@11.0.0',
      scripts: { check: 'bun test ./test' },
    }),
    initialInput: '{}\n',
    testSource: `${header}import '../package-lock.json'; test('a', () => expect(1).toBe(1));\n`,
  },
  {
    input: 'pnpm-lock.yaml',
    packageJson: JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'pnpm@10.0.0',
      scripts: { check: 'bun test ./test' },
    }),
    initialInput: "lockfileVersion: '9.0'\n",
    testSource: `${header}test('a', () => expect(1).toBe(1));\n`,
  },
  {
    input: '.feedback-loop.json',
    packageJson: files['package.json'],
    initialInput: '{}\n',
    testSource: `${header}import '../.feedback-loop.json'; test('a', () => expect(1).toBe(1));\n`,
  },
  {
    input: 'scripts/feedback-loop/input.ts',
    packageJson: files['package.json'],
    initialInput: "export default 'input';\n",
    testSource: `${header}import '../scripts/feedback-loop/input.ts'; test('a', () => expect(1).toBe(1));\n`,
  },
]) {
  test(`1件へ対応する${input}の変更でも全qualityを実行する`, async () => {
    await fixture(
      {
        ...files,
        'tsconfig.json': '{}\n',
        'package.json': packageJson,
        [input]: initialInput,
        '.feedback-loop.json': JSON.stringify({
          ...config,
          globalChanges: [],
          dependencies: [{ inputs: [input], tests: ['test/a.test.ts'] }],
        }),
        'test/a.test.ts': testSource,
      },
      async (f) => {
        installed(f);
        await seed(f);
        await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
        const target = join(f.repo, input);
        await writeFile(target, `${await readFile(target, 'utf8')}\n`);
        const affected = run(f, ['run', 'test:affected']);
        expect(affected.code, affected.output).toBe(0);
        expect(affected.output).toContain(`quality全件の理由: ${input}`);
        expect(affected.output).toContain('quality選択: 2');
      },
    );
  });
}

test('全件実行の理由は変更ファイルをrepo相対パスで1回ずつ示す', async () => {
  await fixture(files, async (f) => {
    installed(f);
    const pkg = join(f.repo, 'package.json');
    await writeFile(pkg, `${await readFile(pkg, 'utf8')}\n`);
    await writeFile(join(f.repo, 'src/other.ts'), 'export const other = 1;\n');
    const affected = run(f, ['run', 'test:affected']);
    expect(affected.code, affected.output).toBe(0);
    const line = affected.stdout.split('\n').find((text) => text.startsWith('quality全件の理由: '));
    expect(line, affected.output).toBeDefined();
    const reasons = (line ?? '').slice('quality全件の理由: '.length).split(', ');
    expect(reasons).toContain('package.json');
    expect(reasons).toContain('src/other.ts');
    expect(reasons.filter((reason) => reason.includes(f.repo))).toEqual([]);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

test('quality候補が0件なら成功とせず非ゼロ終了する', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        assurance: ['a', 'b'].map((name) => ({
          path: `test/${name}.test.ts`,
          reason: '全候補をassuranceへ分類する対照',
        })),
      }),
    },
    async (f) => {
      installed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const result = run(f, ['run', 'test:affected']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('候補0件');
      expect(result.output).not.toContain('選択したqualityが成功しました');
    },
  );
});

for (const { name, collect, diagnostic } of [
  {
    name: '比較元を取得できなければ選択不能として失敗し、テスト成功へ読み替えない',
    collect: files['scripts/collect.ts'],
    diagnostic: 'missing-base',
  },
  {
    name: '収集と比較元の両方が失敗しても、従来どおり収集の診断を返す',
    collect: 'console.log("[]");\n',
    diagnostic: '通常収集とtestGlobsの集合が一致しません',
  },
]) {
  test(name, async () => {
    await fixture(files, async (f) => {
      installed(f);
      await writeFile(
        join(f.repo, '.feedback-loop.json'),
        JSON.stringify({ ...config, base: 'missing-base' }),
      );
      await writeFile(join(f.repo, 'scripts/collect.ts'), collect);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const result = run(f, ['run', 'test:affected']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(diagnostic);
      expect(result.output).not.toContain('quality候補:');
      expect(result.output).not.toContain('選択したqualityが成功しました');
      expect(result.output).not.toMatch(/^実行:/m);
    });
  });
}

// data/input.jsonは、明示依存でqualityの全件（aとb）へ対応する。
const mappedToEveryQuality = {
  ...files,
  'data/input.json': '{}\n',
  '.feedback-loop.json': JSON.stringify({
    ...config,
    dependencies: [{ inputs: ['data/input.json'], tests: ['test/a.test.ts', 'test/b.test.ts'] }],
  }),
};

test('依存記録がなければ、明示依存が全qualityへ届いても全件の理由に示し、次回は部分選択へ戻る', async () => {
  await fixture(mappedToEveryQuality, async (f) => {
    installed(f);
    await writeFile(join(f.repo, 'data/input.json'), '{"changed":true}\n');
    const result = run(f, ['run', 'test:affected']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('quality全件の理由: 信頼できる依存記録なし');

    await writeFile(join(f.repo, 'data/input.json'), '{}\n');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
    const partial = run(f, ['run', 'test:affected']);
    expect(partial.code, partial.output).toBe(0);
    expect(partial.output).toContain('quality選択: 1');
    expect(partial.output).not.toContain('quality全件の理由:');
  });
});

for (const { label, body } of [
  { label: '壊れたJSON', body: '{invalid' },
  { label: '不正な形', body: '["a.test.ts"]' },
  { label: '旧形式', body: '{"version":1,"tests":{}}' },
  { label: '不正な基点', body: '{"version":2,"tests":{"a":{"basis":null,"files":{}}}}' },
  { label: '不正なハッシュ', body: '{"version":2,"tests":{"a":{"basis":"x","files":{"b":null}}}}' },
]) {
  test(`依存記録が${label}なら、明示依存が全qualityへ届いても全件の理由に示し、次回は部分選択へ戻る`, async () => {
    await fixture(mappedToEveryQuality, async (f) => {
      installed(f);
      await seed(f);
      await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
      await writeFile(recordFile(f.repo), body);
      await writeFile(join(f.repo, 'data/input.json'), '{"changed":true}\n');
      const result = run(f, ['run', 'test:affected']);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(
        ' の形が不正なため、記録なしとして扱います, 信頼できる依存記録なし',
      );

      await writeFile(join(f.repo, 'data/input.json'), '{}\n');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      const partial = run(f, ['run', 'test:affected']);
      expect(partial.code, partial.output).toBe(0);
      expect(partial.output).toContain('quality選択: 1');
      expect(partial.output).not.toContain('quality全件の理由:');
    });
  });
}

test('変更されたquality自身と、そのファイルを入力とする明示依存の先を両方選ぶ', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        dependencies: [{ inputs: ['test/a.test.ts'], tests: ['test/b.test.ts'] }],
      }),
    },
    async (f) => {
      installed(f);
      await seed(f);
      await writeFile(join(f.repo, 'test/a.test.ts'), `${files['test/a.test.ts']}\n`);
      const result = run(f, ['run', 'test:affected']);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('quality選択: 2');
      expect(result.output).not.toContain('quality全件の理由:');
    },
  );
});

test('明示依存の先がassuranceだけの変更は、届くqualityがないため全qualityを実行する', async () => {
  await fixture(
    {
      ...files,
      'data/input.json': '{}\n',
      'test/assurance.test.ts': `${header}test('cleanup', () => expect(1).toBe(1));\n`,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放の確認' }],
        dependencies: [{ inputs: ['data/input.json'], tests: ['test/assurance.test.ts'] }],
      }),
    },
    async (f) => {
      installed(f);
      await seed(f);
      await writeFile(join(f.repo, 'data/input.json'), '{"changed":true}\n');
      const result = run(f, ['run', 'test:affected']);
      expect(result.code, result.output).toBe(0);
      expect(result.stdout.split('\n')).toContain('quality全件の理由: data/input.json');
      expect(result.output).toContain('quality選択: 2');
    },
  );
});
