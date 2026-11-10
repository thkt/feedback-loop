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

export async function mergeBase(root: string, base: string): Promise<string> {
  return (await git(root, ['merge-base', base, 'HEAD'])).trim();
}

/**
 * changedはrootの中の変更、outsideはrootの外にある追跡済みファイルの変更で、どちらもrootからの相対パスである。
 * --no-renames により rename は旧パスと新パスの両方を数える。
 */
export async function changedFiles({
  root,
  comparison,
}: {
  root: string;
  comparison: string;
}): Promise<{ changed: string[]; outside: string[] }> {
  // --relative と ls-files の既定出力は root からの相対パスで、root の外は含まない。
  const [tracked, untracked, shown] = await Promise.all([
    git(root, ['diff', '--name-only', '--no-renames', '--relative', '-z', comparison]),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(root, ['rev-parse', '--show-prefix']),
  ]);
  const changed = [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])];
  // rootがGitのルートなら空で、その下ならworkspace/のように/で終わる。
  const prefix = shown.trim();
  if (prefix === '') {
    return { changed, outside: [] };
  }
  // --relative のない diff は Git のルートからのパスを返す。
  const all = await git(root, ['diff', '--name-only', '--no-renames', '-z', comparison]);
  const up = '../'.repeat(prefix.split('/').filter(Boolean).length);
  return {
    changed,
    outside: nulSeparated(all)
      .filter((path) => !path.startsWith(prefix))
      .map((path) => up + path),
  };
}
