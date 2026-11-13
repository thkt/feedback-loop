import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedbackConfig } from './config.ts';
import {
  changesSince,
  defaultBase,
  gitOutput,
  NoMergeBase,
  resolveCommit,
  untrackedAmong,
} from './git.ts';
import type { PackageManager } from './installed.ts';
import { ancestorLockfileCandidates } from './lockfiles.ts';

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

/**
 * 差分を取る比較元。subjectは診断に書く参照の出どころ、refはその参照、commitは参照が指すcommitである。
 * runtimeは、実行時に指定した比較元だけが持つ、表示に添える出どころである。
 */
export type ComparisonBase = { subject: string; ref: string; commit: string; runtime?: string };

/** 実行時の比較元を指定する環境変数。&&でつないだscriptと、入れ子のscriptへ、package managerによらず届く。 */
export const baseVariable = 'FEEDBACK_LOOP_BASE';

function undecidable(root: string, reason: string): never {
  // origin/HEADを設定できるのは、originがあるrepoだけである。
  const hasOrigin = gitOutput(root, ['remote', 'get-url', 'origin']) !== undefined;
  return assert.fail(
    `比較元を決められません（${reason}）。差分を取る比較元を、.feedback-loop.jsonのbase` +
      (hasOrigin
        ? '（例: "origin/main"）か、git remote set-head origin --autoで決めてください'
        : '（例: "main"）で決めてください'),
  );
}

/** 実行時に指定した比較元。fromは出どころで、--baseの引数か環境変数である。 */
export type RuntimeBase = { ref: string; from: 'option' | 'environment' };

/**
 * --baseの指定と環境変数から、実行時の比較元を決める。--baseを優先する。
 * 環境変数は、この実行の比較元である。起動するコマンドへ引き継がないよう、読んだら消す。
 * 入れ子の実行が、別のrepoで同じ参照を読むためである。
 */
export function runtimeBase(option: string | undefined): RuntimeBase | undefined {
  const variable = process.env[baseVariable];
  delete process.env[baseVariable];
  if (option !== undefined) {
    return { ref: option, from: 'option' };
  }
  if (variable === undefined) {
    return undefined;
  }
  const ref = variable.trim();
  // 未設定の変数を展開した指定は、空になる。既定の比較元へ黙って戻さない。
  assert(ref !== '', `${baseVariable}には参照を指定してください`);
  return { ref, from: 'environment' };
}

// subjectは診断に書く参照の出どころ、runtimeは表示に添える出どころである。
const runtimeSources = {
  option: { subject: '--baseに指定した参照', runtime: '実行時の指定' },
  environment: { subject: `${baseVariable}に指定した参照`, runtime: `${baseVariable}の指定` },
};

// 実行時か設定で指定した比較元。指定がなければundefinedを返す。
function specifiedBase(config: FeedbackConfig, specified: RuntimeBase | undefined) {
  if (specified !== undefined) {
    return { ...runtimeSources[specified.from], ref: specified.ref };
  }
  return config.base === undefined
    ? undefined
    : { subject: '.feedback-loop.jsonのbase', ref: config.base };
}

/**
 * 比較元を決めてcommitへ解決する。runtimeは実行時に指定した比較元で、なければ設定か既定の規則で決める。
 * 同期で終えるので、呼出し側は、決められないか読めないときに収集を始める前に止まる。
 */
export function comparisonBase(
  root: string,
  config: FeedbackConfig,
  runtime?: RuntimeBase,
): ComparisonBase {
  const specified = specifiedBase(config, runtime);
  if (specified !== undefined) {
    return { ...specified, commit: resolveCommit(root, specified.ref, specified.subject) };
  }
  const found = defaultBase(root);
  if (found.base === null) {
    return undecidable(root, found.reason);
  }
  return { subject: '既定の比較元', ref: found.base, commit: found.commit };
}

function changesFrom(root: string, base: ComparisonBase, existingOnly = false) {
  return changesSince(root, base.commit, existingOnly).catch((error: unknown) => {
    if (error instanceof NoMergeBase) {
      assert.fail(`${base.subject}とHEADの分岐点を求められません: ${base.ref}（${error.message}）`);
    }
    throw error;
  });
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

/** 比較元からの変更を、祖先のlockfileの変更とあわせて返す。 */
export async function affectedChanges(
  root: string,
  base: ComparisonBase,
  manager: PackageManager,
): Promise<AffectedChanges> {
  const { comparison, changed, outside, top } = await changesFrom(root, base);
  const lockfile = await ancestorLockfile(root, top, outside, manager);
  const lockfileChanges = lockfile?.changed ? [lockfile.path] : [];
  return {
    comparison,
    changed: [...changed, ...lockfileChanges],
    outside: outside.filter((path) => !lockfileChanges.includes(path)),
    lockfileChanges,
    ancestorLockfiles: lockfile?.exists ? [lockfile.path] : [],
  };
}

/** 分岐点以降に変更し、作業ツリーに残るrootの中のパスを返す。削除したパスと改名前のパスを含めない。 */
export async function existingChanges(root: string, base: ComparisonBase) {
  return (await changesFrom(root, base, true)).changed;
}
