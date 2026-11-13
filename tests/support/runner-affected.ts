import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type Fixture = {
  repo: string;
  // runner の一時レポート置き場です。作業ツリーの外に置き、変更として数えられないようにします。
  reports: string;
  // 作業ツリーの外に置く、テストファイル同士の連絡用の置き場です。
  signals: string;
};

export function git(repo: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

// 記録の削除や破損を再現するための、現在の内部保存先です。
export function recordFile(repo: string): string {
  return join(repo, '.feedback-loop-records', 'records.json');
}

// 外側の実行が記録器を付けていても、入れ子の実行へその状態を持ち込みません。
export function baseEnv(f: Fixture): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', TMPDIR: f.reports };
  // npm_lifecycle_eventは、このテストを起動したscript名です。入れ子の実行の案内へ持ち込みません。
  // FEEDBACK_LOOP_BASEは、外側のシェルが指定した比較元です。fixtureの比較元を変えません。
  for (const key of [
    'CLAUDECODE',
    'AGENT',
    'REPL_ID',
    'npm_lifecycle_event',
    'FEEDBACK_LOOP_BASE',
  ]) {
    delete env[key];
  }
  return cleanRecorderEnv(env);
}

/** 外側の実行が付けた記録器を外した環境。入れ子のBunが読むファイルを、外側のテストの依存として記録しない。 */
export function cleanRecorderEnv(env: NodeJS.ProcessEnv = { ...process.env }): NodeJS.ProcessEnv {
  delete env.BUN_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('FEEDBACK_LOOP_RECORD_')) {
      delete env[key];
    }
  }
  return env;
}

export const header = "import { test, expect } from 'bun:test';\n";

// Bunがテストごとに表示する結果の行。利用者が端末で見る行で、Bunが形式を変えたらここだけを直す。
export function passedLine(name: string) {
  return `(pass) ${name}`;
}

export function failedLine(name: string) {
  return `(fail) ${name}`;
}

export async function fixture(
  files: Record<string, string>,
  run: (fixture: Fixture) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-affected-')));
  const repo = join(root, 'repo');
  const reports = join(root, 'reports');
  const signals = join(root, 'signals');
  try {
    await mkdir(repo);
    await mkdir(reports);
    await mkdir(signals);
    for (const [name, body] of Object.entries(files)) {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await writeFile(join(repo, name), body);
    }
    git(repo, 'init', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    await run({ repo, reports, signals });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function commitFixture(repo: string, message: string) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
}
