import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { errorMessage } from './values.ts';

export function gitOutput(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * 参照をcommitのobject idへ解決する。subjectは、診断に書く参照の出どころである。
 * 解決できなければ、gitの示す理由を付けて失敗する。
 */
export function resolveCommit(root: string, ref: string, subject: string): string {
  const unreadable = `${subject}をGitのcommitとして読めません: ${ref}`;
  // -で始まる名前は、gitがオプションとして読む。
  assert(!ref.startsWith('-'), unreadable);
  // :/<文>のような参照は、^{commit}を続けて書けない。object idへ解決してから、commitへたどる。
  let commit = ref;
  for (const revision of [(id: string) => id, (id: string) => `${id}^{commit}`]) {
    const result = spawnSync('git', ['rev-parse', '--verify', revision(commit)], {
      cwd: root,
      encoding: 'utf8',
    });
    commit = result.status === 0 ? result.stdout.trim() : '';
    // ^HEADのような除外の指定は、検証を通って^付きのidになる。object idだけを受け取る。
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      const reason = result.error?.message ?? result.stderr.trim();
      assert.fail(reason ? `${unreadable}（${reason}）` : unreadable);
    }
  }
  return commit;
}

/** baseは比較元の候補で、commitはその指すcommit。決められない場合はnullで、reasonがその理由である。 */
export type DefaultBase = { base: string; commit: string } | { base: null; reason: string };

/** origin/HEADの指す先を優先し、なければmainとmasterのうち1つだけある方を比較元の候補にする。 */
export function defaultBase(root: string): DefaultBase {
  const verified = (ref: string) => gitOutput(root, ['rev-parse', '--verify', '--quiet', ref]);
  const remoteHead = gitOutput(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (remoteHead) {
    // リモートで既定のブランチを改名した後にfetch --pruneすると、指す先のないorigin/HEADが残る。
    const commit = verified(`refs/remotes/${remoteHead}`);
    return commit
      ? { base: remoteHead, commit }
      : { base: null, reason: `origin/HEADの指す先の${remoteHead}がありません` };
  }
  for (const [prefix, label] of [
    ['refs/remotes/origin/', 'origin/'],
    ['refs/heads/', ''],
  ]) {
    const found = ['main', 'master'].flatMap((name) => {
      const commit = verified(`${prefix}${name}`);
      return commit ? [{ base: `${label}${name}`, commit }] : [];
    });
    if (found.length === 1 && found[0]) {
      return found[0];
    }
    if (found.length > 1) {
      return { base: null, reason: `${label}mainと${label}masterの両方があります` };
    }
  }
  return { base: null, reason: 'origin/HEADがなく、mainもmasterもありません' };
}

/** 比較元とHEADに分岐点がない。浅いcloneや、履歴を共有しないbranchがこれに当たる。 */
export class NoMergeBase extends Error {}

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
 * topはGitのルートの絶対パスである。
 * --no-renames により rename は旧パスと新パスの両方を数える。
 * existingOnlyなら、削除したパスと改名前のパスを含めない。
 */
export async function changesSince(
  root: string,
  base: string,
  existingOnly = false,
): Promise<{ comparison: string; changed: string[]; outside: string[]; top: string }> {
  // 未追跡の一覧とrootの位置は分岐点に依存しないので、merge-baseと並行して求める。
  const [merged, untracked, shown] = await Promise.all([
    git(root, ['merge-base', base, 'HEAD']).catch((error: unknown) => {
      throw new NoMergeBase(errorMessage(error));
    }),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(root, ['rev-parse', '--show-prefix']),
  ]);
  const comparison = merged.trim();
  // Gitのルートからのパスを1回で得て、rootの中と外に分ける。
  // --no-relative は、利用者の設定 diff.relative が有効でもルートからのパスを返すために渡す。
  const tracked = nulSeparated(
    await git(root, [
      'diff',
      '--name-only',
      '--no-renames',
      '--no-relative',
      // 削除したパスを除く。--no-renamesのもとでは、改名前のパスも削除として除かれる。
      ...(existingOnly ? ['--diff-filter=d'] : []),
      '-z',
      comparison,
    ]),
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
    // rootからの相対パスへそろえる。rootがGitのルートより2階層以上深いと、up + pathは../../apps/xの形になる。
    outside: tracked
      .filter((path) => !path.startsWith(prefix))
      .map((path) => posix.relative(prefix, path)),
    top: resolve(root, up),
  };
}

/** pathsのうち、未追跡のファイルを返す。pathsはrootからの相対パスで、rootの外でもよい。 */
export async function untrackedAmong(root: string, paths: string[]): Promise<string[]> {
  return paths.length === 0
    ? []
    : nulSeparated(
        await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]),
      );
}
