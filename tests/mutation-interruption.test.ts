import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { guardMutation } from '../src/mutation-guard.ts';
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

test('強制終了の後に対象のファイルが書き換えられていると、次の実行は上書きせずに非ゼロで止まる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    await cancelWithoutLeftovers(
      f,
      [process.execPath, '--no-env-file', ...mutationArgs],
      'group SIGKILL',
    );
    // 利用者が、壊し方が残ったファイルを自分で直した。
    const edited = rules.replace('18', '20');
    await writeFile(join(f.repo, 'src/rules.ts'), edited);

    const next = run(f, ['--no-env-file', ...mutationArgs], {}, 60000);
    expect(next.code, next.output).not.toBe(0);
    expect(next.stderr).toContain(
      'src/rules.tsは当てた壊し方とも元の内容とも違うため、上書きしません',
    );
    expect(target(f)).toBe(edited);
    expect(leftovers(f)).toEqual(['mutation-original.json']);
  });
}, 60000);

test('強制終了の後に対象のファイルが元の内容へ戻されていれば、次の実行は記録を消して進む', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    await cancelWithoutLeftovers(
      f,
      [process.execPath, '--no-env-file', ...mutationArgs],
      'group SIGKILL',
    );
    await writeFile(join(f.repo, 'src/rules.ts'), rules);

    const next = run(f, ['--no-env-file', ...mutationArgs], {}, 60000);
    expect(next.code, next.output).toBe(0);
    expect(next.stderr).not.toContain('元の内容に戻しました');
    expect(target(f)).toBe(rules);
    expect(leftovers(f)).toEqual([]);
  });
}, 60000);

// hash-objectのときだけ自分と親のPIDをCANCEL_TRACEへ書き、取消が届くまで待ってから本物のgitを起動するgit。
// 親は、対象のファイルをHEADと比べるruntime本体である。
async function slowHashObject(f: Fixture) {
  const git = Bun.which('git');
  assert(git);
  const bin = join(f.signals, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = hash-object ]; then
  printf '{"child":%s,"parent":%s}' "$$" "$PPID" > "$CANCEL_TRACE"
  sleep 1
fi
exec ${JSON.stringify(git)} "$@"
`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
}

test('子のコマンドが走っていない合間に取り消されると、基準の実行を始めずに、対象のファイルを元の内容のまま非ゼロで終わる', async () => {
  await fixture(mutationFiles, async (f) => {
    await prepared(f);
    const cancelled = await cancelWithoutLeftovers(
      f,
      [process.execPath, '--no-env-file', ...mutationArgs],
      'SIGINT',
      await slowHashObject(f),
    );
    expect(cancelled.code, cancelled.output).not.toBe(0);
    expect(cancelled.output).toContain('feedback-loop未完了: SIGINTで取り消されました');
    expect(cancelled.output).not.toContain('基準の実行');
    expect(target(f)).toBe(rules);
    expect(leftovers(f)).toEqual([]);
  });
}, 60000);

test('最後の壊し方の後に取り消されると、一覧を返さずに失敗とし、対象のファイルを元の内容に戻す', async () => {
  await fixture({ 'src/rules.ts': rules }, async (f) => {
    const listed = await guardMutation(f.repo, 'src/rules.ts', async (mutated) => {
      mutated.apply(rules.replace('>=', '>'));
      // 最後のテストのコマンドが終わった後に、取消のシグナルが届いた状態にする。
      process.emit('SIGINT', 'SIGINT');
      return 'listed';
    }).catch((error: unknown) => String(error));
    expect(listed).toContain('SIGINTで取り消されました');
    expect(target(f)).toBe(rules);
    expect(leftovers(f)).toEqual([]);
  });
});

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
