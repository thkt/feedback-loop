import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { guardMutation, lock, readLock } from '../src/mutation-guard.ts';
import { baseEnv, commitFixture, fixture } from './support/runner-affected.ts';

const original = 'export const value = 1 > 0;\n';
const files = { 'src/value.ts': original };
const replacement = {
  start: original.indexOf('>'),
  end: original.indexOf('>') + 1,
  replacement: '>=',
};
const mutated = 'export const value = 1 >= 0;\n';

function records(repo: string) {
  return join(repo, '.feedback-loop-records');
}

function lockFile(repo: string) {
  return join(records(repo), 'mutation.lock');
}

function takeoverFile(repo: string) {
  return `${lockFile(repo)}.takeover`;
}

function endedPid() {
  return spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
    encoding: 'utf8',
  }).stdout.trim();
}

/** guardMutationが壊し方を当て始めたかを返す。止まったときは、その理由も返す。 */
async function attempt(repo: string) {
  let applied = false;
  try {
    await guardMutation(repo, 'src/value.ts', async (target) => {
      applied = true;
      target.apply(replacement);
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
    writeFileSync(lockFile(f.repo), endedPid());
    const taken = await attempt(f.repo);
    expect(taken).toEqual({ applied: true, error: undefined });
    expect(readFileSync(join(f.repo, 'src/value.ts'), 'utf8')).toBe(original);
    expect(existsSync(takeoverFile(f.repo))).toBe(false);
  });
});

test('強制終了された実行のロックを別の実行が引き継いでいる途中なら、壊し方を当てずに止まり、ロックと引き継ぎ用のファイルを残す', async () => {
  await fixture(files, async (f) => {
    mkdirSync(records(f.repo), { recursive: true });
    const ended = endedPid();
    writeFileSync(lockFile(f.repo), ended);
    writeFileSync(takeoverFile(f.repo), '');
    const refused = await attempt(f.repo);
    expect(refused.applied).toBe(false);
    expect(refused.error).toContain(`${takeoverFile(f.repo)}を消してから実行してください`);
    expect(readFileSync(lockFile(f.repo), 'utf8')).toBe(ended);
    expect(existsSync(takeoverFile(f.repo))).toBe(true);
  });
});

test('Gitのルートより下のpackageでも、対象のファイルをそのpackageのHEADの内容と比べて壊し方を当てる', async () => {
  await fixture({ 'pkg/src/value.ts': original }, async (f) => {
    const root = join(f.repo, 'pkg');
    expect(await attempt(root)).toEqual({ applied: true, error: undefined });
    expect(readFileSync(join(root, 'src/value.ts'), 'utf8')).toBe(original);
  });
});

function heldLock(repo: string, pid = process.pid) {
  mkdirSync(records(repo), { recursive: true });
  writeFileSync(lockFile(repo), String(pid));
}

test('ロックを作れなかった後に読む前にロックが消えると、ロックを作り直して取り、返した関数でロックを消す', async () => {
  await fixture(files, async (f) => {
    heldLock(f.repo, process.ppid);
    const unlock = lock(records(f.repo), (path) => {
      rmSync(path);
      return readLock(path);
    });
    expect(readFileSync(lockFile(f.repo), 'utf8')).toBe(String(process.pid));
    unlock();
    expect(existsSync(lockFile(f.repo))).toBe(false);
  });
});

test('ロックが消えた後、作り直す前に別の実行がロックを取ると、別の実行が進んでいるとして止まり、そのロックを残す', async () => {
  await fixture(files, async (f) => {
    heldLock(f.repo);
    let reads = 0;
    expect(() =>
      lock(records(f.repo), (path) => {
        reads += 1;
        if (reads > 1) {
          return readLock(path);
        }
        rmSync(path);
        const read = readLock(path);
        writeFileSync(path, String(process.pid));
        return read;
      }),
    ).toThrow('別のmutationの実行が進んでいます');
    expect(readFileSync(lockFile(f.repo), 'utf8')).toBe(String(process.pid));
  });
});

test('ロックのパスにディレクトリがあって読めないと、読み込みのエラーで止まり、ディレクトリを残す', async () => {
  await fixture(files, async (f) => {
    mkdirSync(lockFile(f.repo), { recursive: true });
    expect(() => lock(records(f.repo))).toThrow('EISDIR');
    expect(existsSync(lockFile(f.repo))).toBe(true);
  });
});

test('ロックのパスに指す先の無いシンボリックリンクがあると、リンクを消すよう示して止まり、リンクを残す', async () => {
  await fixture(files, async (f) => {
    mkdirSync(records(f.repo), { recursive: true });
    symlinkSync('missing', lockFile(f.repo));
    expect(() => lock(records(f.repo))).toThrow(
      `${lockFile(f.repo)}は、指す先の無いシンボリックリンクです`,
    );
    expect(readdirSync(records(f.repo))).toEqual(['mutation.lock']);
  });
});

test('PIDがまだ書かれていないロックは、別の実行が作っている途中として引き継がずに止まる', async () => {
  await fixture(files, async (f) => {
    mkdirSync(join(f.repo, '.feedback-loop-records'), { recursive: true });
    writeFileSync(lockFile(f.repo), '');
    const refused = await attempt(f.repo);
    expect(refused.applied).toBe(false);
    expect(refused.error).toContain('別のmutationの実行が進んでいます');
    expect(readFileSync(lockFile(f.repo), 'utf8')).toBe('');
  });
});

test('前の実行の記録が指すファイルが無くなっていると、記録のパスを示して壊し方を当てずに止まる', async () => {
  await fixture(files, async (f) => {
    const journal = join(records(f.repo), 'mutation-original.json');
    mkdirSync(records(f.repo), { recursive: true });
    const recorded = JSON.stringify({
      path: 'src/moved.ts',
      original: Buffer.from(original).toString('base64'),
    });
    writeFileSync(journal, recorded);
    const refused = await attempt(f.repo);
    expect(refused.applied).toBe(false);
    expect(refused.error).toContain(
      `前の実行の記録${journal}が残っていますが、src/moved.tsがありません`,
    );
    expect(readFileSync(journal, 'utf8')).toBe(recorded);
  });
});

const guardModule = resolve(import.meta.dir, '../src/mutation-guard.ts');

function killedAfterApply(repo: string) {
  const script = `import { guardMutation } from ${JSON.stringify(guardModule)};
await guardMutation(${JSON.stringify(repo)}, 'src/value.ts', async (target) => {
  target.apply(${JSON.stringify(replacement)});
  process.kill(process.pid, 'SIGKILL');
});`;
  const killed = spawnSync(process.execPath, ['--no-env-file', '-e', script], {
    cwd: repo,
    encoding: 'utf8',
    env: baseEnv({ repo, reports: repo, signals: repo }),
  });
  expect(killed.signal, killed.stderr).toBe('SIGKILL');
  expect(readFileSync(join(repo, 'src/value.ts'), 'utf8')).toBe(mutated);
}

for (const [name, partial] of [
  ['壊し方を当てた内容の先頭の一部', mutated.slice(0, mutated.indexOf('>=') + 2)],
  ['元の内容の先頭の一部', original.slice(0, original.indexOf('> 0') + 3)],
  ['空', ''],
] as const) {
  test(`壊し方を当てたまま強制終了された後に、対象のファイルが${name}になっていると、次の実行は上書きせずに止まり、記録を残す`, async () => {
    await fixture(files, async (f) => {
      killedAfterApply(f.repo);
      writeFileSync(join(f.repo, 'src/value.ts'), partial);
      const refused = await attempt(f.repo);
      expect(refused.applied).toBe(false);
      expect(refused.error).toContain(
        'src/value.tsは当てた壊し方とも元の内容とも違うため、上書きしません',
      );
      expect(readFileSync(join(f.repo, 'src/value.ts'), 'utf8')).toBe(partial);
      expect(readdirSync(records(f.repo)).toSorted()).toEqual([
        '.gitignore',
        'mutation-original.json',
        'mutation-replacement.json',
      ]);
    });
  });
}

test('壊し方を当てたまま強制終了された後に、対象のファイルが当てた壊し方の内容のままなら、次の実行は元の内容に戻して進む', async () => {
  await fixture(files, async (f) => {
    killedAfterApply(f.repo);
    expect(await attempt(f.repo)).toEqual({ applied: true, error: undefined });
    expect(readFileSync(join(f.repo, 'src/value.ts'), 'utf8')).toBe(original);
    expect(readdirSync(records(f.repo))).toEqual(['.gitignore']);
  });
});

test('壊し方を当てると対象のファイルは別のファイルに置き換わり、実行権限のあるファイルは戻した後も同じmodeと内容で、記録の置き場に一時ファイルを残さない', async () => {
  await fixture(files, async (f) => {
    const file = join(f.repo, 'src/value.ts');
    chmodSync(file, 0o755);
    const before = statSync(file).ino;
    let modeWhileMutated: number | undefined;
    let inodeWhileMutated: number | undefined;
    await guardMutation(f.repo, 'src/value.ts', async (target) => {
      target.apply(replacement);
      modeWhileMutated = statSync(file).mode & 0o7777;
      inodeWhileMutated = statSync(file).ino;
    });
    expect(inodeWhileMutated).not.toBe(before);
    expect(modeWhileMutated).toBe(0o755);
    expect(statSync(file).mode & 0o7777).toBe(0o755);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(records(f.repo))).toEqual(['.gitignore']);
  });
});

test('壊し方を当てたまま強制終了された後に、対象のファイルがHEADと同じ内容になっていれば、次の実行は上書きせずに記録だけを消して進む', async () => {
  await fixture(files, async (f) => {
    killedAfterApply(f.repo);
    const updated = 'export const value = 2 > 0;\n';
    writeFileSync(join(f.repo, 'src/value.ts'), updated);
    commitFixture(f.repo, 'update');
    expect(await attempt(f.repo)).toEqual({ applied: true, error: undefined });
    expect(readFileSync(join(f.repo, 'src/value.ts'), 'utf8')).toBe(updated);
    expect(readdirSync(records(f.repo))).toEqual(['.gitignore']);
  });
});

test('壊し方を当てている間に対象のファイルが消されても、終わるときに元の内容で作り直し、記録を消す', async () => {
  await fixture(files, async (f) => {
    const file = join(f.repo, 'src/value.ts');
    await guardMutation(f.repo, 'src/value.ts', async (target) => {
      target.apply(replacement);
      rmSync(file);
    });
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(records(f.repo))).toEqual(['.gitignore']);
  });
});

test('壊し方を当てる位置が同じなら、対象のファイルの後ろが長くても、壊し方を当てたときに書く記録の大きさは変わらない', async () => {
  const long = original + 'export const padding = 0;\n'.repeat(1000);
  await fixture({ 'src/short.ts': original, 'src/long.ts': long }, async (f) => {
    const writtenByApply = async (path: string) => {
      const snapshot = () =>
        new Map(
          readdirSync(records(f.repo)).map((name) => [
            name,
            readFileSync(join(records(f.repo), name), 'utf8'),
          ]),
        );
      let written = 0;
      await guardMutation(f.repo, path, async (target) => {
        const before = snapshot();
        target.apply(replacement);
        for (const [name, content] of snapshot()) {
          if (before.get(name) !== content) {
            written += Buffer.byteLength(content);
          }
        }
      });
      return written;
    };
    const short = await writtenByApply('src/short.ts');
    expect(short).toBeGreaterThan(0);
    expect(await writtenByApply('src/long.ts')).toBe(short);
  });
});
