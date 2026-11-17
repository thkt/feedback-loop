import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardMutation } from '../src/mutation-guard.ts';
import { fixture } from './support/runner-affected.ts';

const original = 'export const value = 1 > 0;\n';
const files = { 'src/value.ts': original };

function lockFile(repo: string) {
  return join(repo, '.feedback-loop-records', 'mutation.lock');
}

/** guardMutationが壊し方を当て始めたかを返す。止まったときは、その理由も返す。 */
async function attempt(repo: string) {
  let applied = false;
  try {
    await guardMutation(repo, 'src/value.ts', async (target) => {
      applied = true;
      target.apply('export const value = 1 >= 0;\n');
    });
    return { applied, error: undefined };
  } catch (error) {
    return { applied, error: String(error) };
  }
}

test('対象のファイルがHEADの内容と違うと、壊し方を当てずに止まる', async () => {
  await fixture(files, async (f) => {
    const control = await attempt(f.repo);
    expect(control).toEqual({ applied: true, error: undefined });
    expect(readFileSync(join(f.repo, 'src/value.ts'), 'utf8')).toBe(original);

    const edited = 'export const value = 2 > 0;\n';
    writeFileSync(join(f.repo, 'src/value.ts'), edited);
    const refused = await attempt(f.repo);
    expect(refused.applied).toBe(false);
    expect(refused.error).toContain('src/value.tsがHEADの内容と違います');
    expect(readFileSync(join(f.repo, 'src/value.ts'), 'utf8')).toBe(edited);
  });
});

test('別の実行がロックを持っている間は、壊し方を当てずに止まり、終わった実行のロックは引き継ぐ', async () => {
  await fixture(files, async (f) => {
    mkdirSync(join(f.repo, '.feedback-loop-records'), { recursive: true });
    // このテストのプロセスは生きているので、別の実行が進んでいる状態になる。
    writeFileSync(lockFile(f.repo), String(process.pid));
    const refused = await attempt(f.repo);
    expect(refused.applied).toBe(false);
    expect(refused.error).toContain('別のmutationの実行が進んでいます');
    expect(readFileSync(lockFile(f.repo), 'utf8')).toBe(String(process.pid));

    // 終わったプロセスのPIDを持つロックは、強制終了された実行が残したものである。
    const ended = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
      encoding: 'utf8',
    });
    writeFileSync(lockFile(f.repo), ended.stdout.trim());
    const taken = await attempt(f.repo);
    expect(taken).toEqual({ applied: true, error: undefined });
    expect(readFileSync(join(f.repo, 'src/value.ts'), 'utf8')).toBe(original);
  });
});
