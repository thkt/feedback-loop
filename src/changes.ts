import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedbackConfig } from './config.ts';
import { changesSince, defaultBase, resolveCommit, untrackedAmong } from './git.ts';
import type { PackageManager } from './installed.ts';
import { ancestorLockfileCandidates } from './lockfiles.ts';
import { errorMessage } from './values.ts';

/** affectedが比較元から求めた変更。パスはどれもrootからの相対パスである。 */
export type AffectedChanges = {
  // 比較元とHEADの分岐点のcommit。
  comparison: string;
  // rootの中の変更と、変更した祖先のlockfile。
  changed: string[];
  // rootの外にある変更。祖先のlockfileは含めない。Vitestだけが、importでつながるテストの選択に使う。
  outside: string[];
  // 変更した祖先のlockfile。記録や依存グラフによらず、全qualityを実行する理由にする。
  lockfileChanges: string[];
  // rootにlockfileがない構成で使う、実在する祖先のlockfile。Bunの依存記録の基点に含める。
  ancestorLockfiles: string[];
};

async function configuredChanges(root: string, config: FeedbackConfig, existingOnly = false) {
  const comparison = config.base === undefined ? defaultBase(root) : { base: config.base };
  if (comparison.base === null) {
    assert.fail(
      `比較元を決められません。.feedback-loop.jsonにbaseを指定してください: ${comparison.reason}`,
    );
  }
  return changesSince(root, comparison.base, existingOnly);
}

// 参照を読めなければ、Promiseを返す前に失敗する。
function overriddenChanges(root: string, override: string) {
  const commit = resolveCommit(root, override, '--baseに指定した参照');
  // 浅いcloneや別の履歴の参照は、commitとして読めてもHEADとの分岐点がない。
  return changesSince(root, commit).catch((error: unknown) =>
    assert.fail(
      `--baseに指定した参照とHEADの分岐点を求められません: ${override}（${errorMessage(error)}）`,
    ),
  );
}

// rootにlockfileがない構成では、rootのpackageは祖先のlockfileを使う。
// いちばん近い、実在するか削除されたlockfileを返す。削除したlockfileも変更として数えるためである。
async function ancestorLockfile(
  root: string,
  top: string,
  outside: string[],
  manager: PackageManager,
) {
  const path = ancestorLockfileCandidates(root, top, manager).find(
    (candidate) => outside.includes(candidate) || existsSync(join(root, candidate)),
  );
  if (path === undefined) {
    return undefined;
  }
  // 作ったばかりで未追跡のlockfileは、追跡済みの変更に現れない。
  const changed = outside.includes(path) || (await untrackedAmong(root, [path])).length > 0;
  return { path, changed, exists: existsSync(join(root, path)) };
}

/**
 * affectedの比較元からの変更を返す。overrideは実行時に指定した比較元で、なければ設定か既定の規則で決める。
 * overrideを読めなければ、Promiseを返す前に失敗する。呼出し側が収集を始める前に止めるためである。
 */
export function affectedChanges(
  root: string,
  config: FeedbackConfig,
  manager: PackageManager,
  override: string | undefined,
): Promise<AffectedChanges> {
  const changes =
    override === undefined ? configuredChanges(root, config) : overriddenChanges(root, override);
  return changes.then(async ({ comparison, changed, outside, top }) => {
    const lockfile = await ancestorLockfile(root, top, outside, manager);
    const lockfileChanges = lockfile?.changed ? [lockfile.path] : [];
    return {
      comparison,
      changed: [...changed, ...lockfileChanges],
      outside: outside.filter((path) => !lockfileChanges.includes(path)),
      lockfileChanges,
      ancestorLockfiles: lockfile?.exists ? [lockfile.path] : [],
    };
  });
}

/** 分岐点以降に変更し、作業ツリーに残るrootの中のパスを返す。削除したパスと改名前のパスを含めない。 */
export async function existingChanges(root: string, config: FeedbackConfig) {
  return (await configuredChanges(root, config, true)).changed;
}
