import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

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

/**
 * rootにlockfileがなければ、Gitのルートまでの祖先のうち、lockfileがあるいちばん近いディレクトリを返す。
 * lockfileをworkspaceのルートに置く構成で、rootのpackageが使うlockfileである。
 */
export function ancestorLockfiles(root: string) {
  if (lockfilesIn(root).length > 0) {
    return undefined;
  }
  let directory = root;
  // worktreeとsubmoduleでは、.gitはファイルである。
  while (!existsSync(join(directory, '.git'))) {
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
    const lockfiles = lockfilesIn(directory);
    if (lockfiles.length > 0) {
      return { directory, lockfiles };
    }
  }
  return undefined;
}

/** ancestorLockfilesのlockfileを、rootからの相対パスで返す。gitの変更のパスと同じ形である。 */
export function ancestorLockfilePaths(root: string): string[] {
  const found = ancestorLockfiles(root);
  return (found?.lockfiles ?? []).map(({ name }) =>
    relative(root, join(found?.directory ?? root, name))
      .split(sep)
      .join('/'),
  );
}
