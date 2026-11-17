import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, header, installed, run } from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { cancelWithoutLeftovers } from './support/feedback-loop-cancellation.ts';
import { vitestModules } from './support/vitest.ts';

const rules = 'export function isAdult(age: number) {\n  return age >= 18;\n}\n';

// CANCEL_TRACEがあり、src/rules.tsが壊されていれば、自分と親のPIDを書いて待ち続けるテスト。
const mutationFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  '.feedback-loop.json': JSON.stringify({
    ...config,
    testArgs: ['--timeout', '30000'],
    bunWorkers: 2,
  }),
  'src/rules.ts': rules,
  'test/adult.test.ts': `${header}import { readFileSync, writeFileSync } from 'node:fs';
import { isAdult } from '../src/rules.ts';
test('adult', async () => {
  const mutated = readFileSync(new URL('../src/rules.ts', import.meta.url), 'utf8') !== ${JSON.stringify(rules)};
  if (process.env.CANCEL_TRACE && mutated) {
    writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
    await new Promise(() => {});
  }
  expect(isAdult(30)).toBe(true);
}, 30000);\n`,
};

const mutationArgs = [
  'scripts/feedback-loop/runtime.mjs',
  'mutation',
  'src/rules.ts',
  '--tests',
  'test/adult.test.ts',
];

function target(f: Fixture) {
  return readFileSync(join(f.repo, 'src/rules.ts'), 'utf8');
}

function leftovers(f: Fixture) {
  return ['mutation.lock', 'mutation-original.json'].filter((name) =>
    existsSync(join(f.repo, '.feedback-loop-records', name)),
  );
}

async function prepared(f: Fixture) {
  await symlink(vitestModules, join(f.repo, 'node_modules'));
  installed(f);
}

test('壊し方を当てたまま強制終了された後の次の実行で、対象のファイルを元の内容に戻す', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    await cancelWithoutLeftovers(
      f,
      [process.execPath, '--no-env-file', ...mutationArgs],
      'group SIGKILL',
    );
    // 強制終了では元に戻せないため、壊し方を当てた内容のまま残る。
    expect(target(f)).not.toBe(rules);

    const next = run(f, ['--no-env-file', ...mutationArgs], {}, 60000);
    expect(next.code, next.output).toBe(0);
    expect(next.stderr).toContain(
      '前の実行が壊し方を当てたまま終わったsrc/rules.tsを、元の内容に戻しました',
    );
    expect(target(f)).toBe(rules);
    expect(leftovers(f)).toEqual([]);
  });
}, 60000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal}で取り消されたときに、対象のファイルを元の内容に戻して終わる`, async () => {
    await fixture(mutationFiles, async (f) => {
      await prepared(f);
      const cancelled = await cancelWithoutLeftovers(
        f,
        [process.execPath, '--no-env-file', ...mutationArgs],
        signal,
      );
      expect(cancelled.code, cancelled.output).not.toBe(0);
      expect(cancelled.output).toContain(`feedback-loop未完了: 検査失敗または取消: ${signal}`);
      expect(target(f)).toBe(rules);
      expect(leftovers(f)).toEqual([]);
    });
  }, 60000);
}
