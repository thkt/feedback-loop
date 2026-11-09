import { applyFeedback } from './support/feedback-loop-batch.ts';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  baseEnv,
  config,
  files,
  fixture,
  header,
  installed,
  recordFile,
  run,
  seed,
  type Fixture,
} from './support/feedback-loop-batch.ts';

const names = ['a', 'b', 'c', 'd', 'e'];
const tests = Object.fromEntries(
  names.map((name, index) => [
    `test/${name}.test.ts`,
    `${header}import { state } from './state.ts';
${index < 2 ? "import { value } from '../src/input.ts';" : ''}
test('${name}', async () => {
  expect(state.used).toBe(false);
  state.used = true;
  expect(Reflect.has(globalThis, 'feedbackBatchOwner')).toBe(false);
  Reflect.set(globalThis, 'feedbackBatchOwner', '${name}');
  ${index < 2 ? 'expect(value).toBeGreaterThan(0);' : ''}
  if (process.env.BATCH_SERVER) {
    await fetch(process.env.BATCH_SERVER + '/start/${name}');
    await fetch(process.env.BATCH_SERVER + '/end/${name}');
  }
});\n`,
  ]),
);

async function affected(f: Fixture, url: string) {
  const child = Bun.spawn([process.execPath, 'run', 'test:affected'], {
    cwd: f.repo,
    env: { ...baseEnv(f), BATCH_SERVER: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

function concurrencyProbe(peakAll: number) {
  const active = new Set<string>();
  const started: string[] = [];
  const pending: (() => void)[] = [];
  const peak = { value: 0 };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const [, operation, name = ''] = new URL(request.url).pathname.split('/');
      if (operation === 'start') {
        active.add(name);
        started.push(name);
        peak.value = Math.max(peak.value, active.size);
        await new Promise<void>((done) => {
          const timeout = setTimeout(done, 300);
          pending.push(() => {
            clearTimeout(timeout);
            done();
          });
          if (active.size >= peakAll) {
            for (const release of pending.splice(0)) {
              release();
            }
          }
        });
      } else if (operation === 'end') {
        active.delete(name);
      }
      return new Response('ok');
    },
  });
  return { active, started, pending, peak, server };
}

for (const { workers, peakAll, peakSelected } of [
  { workers: undefined, peakAll: 4, peakSelected: 2 },
  { workers: 1, peakAll: 1, peakSelected: 1 },
  { workers: 2, peakAll: 2, peakSelected: 2 },
]) {
  test(`Bun一括実行はworkers=${String(workers)}で分離・上限・標準と補完の和集合を保つ`, async () => {
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
        const { active, started, pending, peak, server } = concurrencyProbe(peakAll);
        try {
          await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
          const initial = await affected(f, server.url.href);
          expect(initial.code, initial.output).toBe(0);
          expect(started.toSorted()).toEqual(names);
          expect(peak.value, initial.output).toBe(peakAll);
          expect(active.size).toBe(0);

          started.length = 0;
          peak.value = 0;
          await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
          await writeFile(join(f.repo, 'data/input.json'), '{"value":2}\n');
          const selected = await affected(f, server.url.href);
          expect(selected.code, selected.output).toBe(0);
          expect(started.toSorted(), selected.output).toEqual(['a', 'b', 'c', 'd']);
          expect(peak.value, selected.output).toBe(peakSelected);
          expect(active.size).toBe(0);
          expect(selected.output).toContain('quality候補: 5');
          expect(selected.output).toContain('quality選択: 4');
          expect(selected.output).not.toContain('quality全件の理由:');
        } finally {
          for (const release of pending.splice(0)) {
            release();
          }
          await server.stop(true);
        }
      },
    );
  }, 30000);
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

test('bunWorkersと競合するCLI引数は配置前に拒否する', async () => {
  await fixture(files, async (f) => {
    const originalPackage = await readFile(join(f.repo, 'package.json'), 'utf8');
    const invalid = [
      ...[0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map((bunWorkers) => ({
        ...config,
        bunWorkers,
      })),
      { ...config, runner: 'vitest', bunArgs: [], bunWorkers: 2 },
      ...['bunArgs', 'testArgs'].flatMap((key) =>
        ['--isolate', '--no-isolate', '--parallel', '--parallel=2', '--no-parallel'].map(
          (flag) => ({
            ...config,
            [key]: [flag],
          }),
        ),
      ),
    ];
    for (const value of invalid) {
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(value));
      const rejected = applyFeedback(f, 'bun run test:affected', run);
      expect(rejected.code, JSON.stringify(value) + '\n' + rejected.output).not.toBe(0);
      expect(rejected.output).toMatch(/bunArgs|bunWorkers|parallel|isolate|worker|並列|分離/i);
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

test('比較元を取得できなければ選択不能として失敗し、テスト成功へ読み替えない', async () => {
  await fixture(
    { ...files, '.feedback-loop.json': JSON.stringify({ ...config, base: 'missing-base' }) },
    async (f) => {
      installed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const result = run(f, ['run', 'test:affected']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('git merge-base missing-base HEAD failed:');
      expect(result.output).not.toContain('選択したqualityが成功しました');
      expect(result.output).not.toMatch(/^実行:/m);
    },
  );
});

test('明示依存が全qualityへ届いても、記録の欠如を全件の理由に残し、次回は部分選択へ戻る', async () => {
  await fixture(
    {
      ...files,
      'data/input.json': '{}\n',
      '.feedback-loop.json': JSON.stringify({
        ...config,
        dependencies: [
          { inputs: ['data/input.json'], tests: ['test/a.test.ts', 'test/b.test.ts'] },
        ],
      }),
    },
    async (f) => {
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
    },
  );
});

for (const { label, body } of [
  { label: '壊れたJSON', body: '{invalid' },
  { label: '不正な形', body: '["a.test.ts"]' },
  { label: '旧形式', body: '{"version":1,"tests":{}}' },
  {
    label: '不正な基点',
    body: '{"version":2,"tests":{"a":{"basis":null,"files":{}}}}',
  },
  {
    label: '不正なハッシュ',
    body: '{"version":2,"tests":{"a":{"basis":"x","files":{"b":null}}}}',
  },
]) {
  test(`明示依存が全qualityへ届いても、記録の${label}を全件の理由に残し、次回は部分選択へ戻る`, async () => {
    await fixture(
      {
        ...files,
        'data/input.json': '{}\n',
        '.feedback-loop.json': JSON.stringify({
          ...config,
          dependencies: [
            { inputs: ['data/input.json'], tests: ['test/a.test.ts', 'test/b.test.ts'] },
          ],
        }),
      },
      async (f) => {
        installed(f);
        await seed(f);
        await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
        await writeFile(recordFile(f.repo), body);
        await writeFile(join(f.repo, 'data/input.json'), '{"changed":true}\n');
        const result = run(f, ['run', 'test:affected']);
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain(
          `quality全件の理由: ${recordFile(f.repo)} の形が不正なため、記録なしとして扱います, 信頼できる依存記録なし`,
        );
        await writeFile(join(f.repo, 'data/input.json'), '{}\n');
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
        const partial = run(f, ['run', 'test:affected']);
        expect(partial.code, partial.output).toBe(0);
        expect(partial.output).toContain('quality選択: 1');
        expect(partial.output).not.toContain('quality全件の理由:');
      },
    );
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
