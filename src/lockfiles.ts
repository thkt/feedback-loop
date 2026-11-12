import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { PackageManager } from './installed.ts';

/** lockfileの名前と、それを使うpackage manager。yarnは対応外だが、競合と未対応の診断に使う。 */
const lockfileManagers = [
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['pnpm-lock.yaml', 'pnpm'],
] as const;

/** directoryにあるlockfileを、名前とpackage managerの組で返す。 */
export function lockfilesIn(directory: string) {
  return lockfileManagers
    .filter(([name]) => existsSync(join(directory, name)))
    .map(([name, manager]) => ({ name, manager }));
}

// rootの親からtopまでのディレクトリを、近い順に返す。rootがtopの中になければ空を返す。
function ancestors(root: string, top: string): string[] {
  const found: string[] = [];
  let directory = root;
  while (directory !== top && directory.startsWith(top + sep)) {
    directory = dirname(directory);
    found.push(directory);
  }
  return found;
}

/**
 * rootにlockfileがなければ、Gitのルート（top）までの祖先のうち、lockfileがあるいちばん近いディレクトリを返す。
 * lockfileをworkspaceのルートに置く構成で、rootのpackageが使うlockfileである。
 */
export function ancestorLockfiles(root: string, top: string) {
  if (lockfilesIn(root).length > 0) {
    return undefined;
  }
  for (const directory of ancestors(root, top)) {
    const lockfiles = lockfilesIn(directory);
    if (lockfiles.length > 0) {
      return { directory, lockfiles };
    }
  }
  return undefined;
}

/** rootからの相対パスを、gitの変更のパスと同じ/区切りで返す。 */
export function fromRoot(root: string, path: string): string {
  return relative(root, resolve(root, path)).split(sep).join('/');
}

/**
 * rootにlockfileがなければ、managerのlockfileが置かれうる祖先のパスを、rootからの相対パスで近い順に返す。
 * 削除されたlockfileの変更も見分けるため、実在するかどうかは見ない。
 */
export function ancestorLockfileCandidates(
  root: string,
  top: string,
  manager: PackageManager,
): string[] {
  if (lockfilesIn(root).length > 0) {
    return [];
  }
  const name = lockfileManagers.find(([, owner]) => owner === manager)?.[0];
  return name === undefined
    ? []
    : ancestors(root, top).map((directory) => fromRoot(root, join(directory, name)));
}
