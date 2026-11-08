import { spawnSync } from 'node:child_process';

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

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function nulSeparated(text: string): string[] {
  return text.split('\0').filter((path) => path !== '');
}

export function mergeBase(root: string, base: string): string {
  return git(root, ['merge-base', base, 'HEAD']).trim();
}

// base との分岐点以降の commit・未 commit の変更・未追跡ファイルを、repo相対パスで返す。
// --no-renames により rename は旧パスと新パスの両方を数える。
export function changedFiles({ root, base }: { root: string; base: string }): string[] {
  const comparison = mergeBase(root, base);
  // --relative と ls-files の既定出力は root からの相対パスで、root の外は含まない。
  const tracked = git(root, [
    'diff',
    '--name-only',
    '--no-renames',
    '--relative',
    '-z',
    comparison,
  ]);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])];
}
