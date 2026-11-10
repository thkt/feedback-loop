import { execFile, spawnSync } from 'node:child_process';

export function gitOutput(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** origin/HEADの指す先を優先し、なければmainとmasterのうち1つだけある方を比較元の候補にする。 */
export function defaultBase(root: string): string | null {
  const remoteHead = gitOutput(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (remoteHead) {
    return remoteHead;
  }
  for (const prefix of ['refs/remotes/origin/', 'refs/heads/']) {
    const found = ['main', 'master'].filter(
      (name) =>
        gitOutput(root, ['rev-parse', '--verify', '--quiet', `${prefix}${name}`]) !== undefined,
    );
    if (found.length > 0) {
      return found.length === 1 ? `${prefix === 'refs/heads/' ? '' : 'origin/'}${found[0]}` : null;
    }
  }
  return null;
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      args,
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          fail(new Error(`git ${args.join(' ')} failed: ${stderr}`));
        } else {
          done(stdout);
        }
      },
    );
  });
}

function nulSeparated(text: string): string[] {
  return text.split('\0').filter((path) => path !== '');
}

/**
 * baseとの分岐点と、そこからの変更を返す。
 * changedはrootの中の変更、outsideはrootの外にある追跡済みファイルの変更で、どちらもrootからの相対パスである。
 * --no-renames により rename は旧パスと新パスの両方を数える。
 */
export async function changesSince(
  root: string,
  base: string,
): Promise<{ comparison: string; changed: string[]; outside: string[] }> {
  // 未追跡の一覧とrootの位置は分岐点に依存しないので、merge-baseと並行して求める。
  const [merged, untracked, shown] = await Promise.all([
    git(root, ['merge-base', base, 'HEAD']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(root, ['rev-parse', '--show-prefix']),
  ]);
  const comparison = merged.trim();
  // Gitのルートからのパスを1回で得て、rootの中と外に分ける。
  // --no-relative は、利用者の設定 diff.relative が有効でもルートからのパスを返すために渡す。
  const tracked = nulSeparated(
    await git(root, ['diff', '--name-only', '--no-renames', '--no-relative', '-z', comparison]),
  );
  // rootがGitのルートなら空で、その下ならworkspace/のように/で終わる。
  const prefix = shown.trim();
  const up = '../'.repeat(prefix.split('/').filter(Boolean).length);
  const inside = tracked.filter((path) => path.startsWith(prefix));
  return {
    comparison,
    changed: [
      ...new Set([...inside.map((path) => path.slice(prefix.length)), ...nulSeparated(untracked)]),
    ],
    outside: tracked.filter((path) => !path.startsWith(prefix)).map((path) => up + path),
  };
}
