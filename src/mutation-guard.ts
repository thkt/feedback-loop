import assert from 'node:assert/strict';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { cancellationSignals } from './command.ts';
import { gitOutput } from './git.ts';
import { recordsDirectory, writeAtomically } from './records.ts';
import { assertRepoRelativePath, hasErrorCode, isRecord } from './values.ts';

export type Replacement = { start: number; end: number; replacement: string };

/** 壊し方を当てる対象のファイル。sourceは、壊していない内容である。 */
export type MutationTarget = {
  source: string;
  apply: (replacement: Replacement) => void;
  restore: () => void;
  // 取消のシグナルを受けていたら、その旨を投げる。準備・基準の実行・壊し方を当てる前に呼ぶ。
  assertNotCancelled: () => Promise<void>;
};

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 権限がなくてシグナルを送れないプロセスも、生きている。
    return hasErrorCode(error, 'EPERM');
  }
}

/** ロックのファイルを作る。すでにあれば作らずにfalseを返す。 */
function create(path: string) {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }
}

function takeOver(path: string, holder: string) {
  const takeover = `${path}.takeover`;
  assert(
    create(takeover),
    `別のmutationの実行が、強制終了された実行のロックを引き継いでいる途中です。ほかの実行が残っていなければ、${takeover}を消してから実行してください`,
  );
  try {
    assert(readLock(path) === holder, '別のmutationの実行が先にロックを取りました');
    writeFileSync(path, String(process.pid));
  } finally {
    rmSync(takeover, { force: true });
  }
}

export function readLock(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

/** 実行中を示すロックを取る。強制終了された実行のロックは、PIDが消えていれば引き継ぐ。 */
export function lock(directory: string, read: (path: string) => string | undefined = readLock) {
  const path = join(directory, 'mutation.lock');
  while (!create(path)) {
    const holder = read(path);
    if (holder === undefined) {
      assert(
        !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink(),
        `${path}は、指す先の無いシンボリックリンクです。消してから実行してください`,
      );
      continue;
    }
    const pid = Number(holder);
    // PIDを読めないロックは、別の実行がロックを作ってからPIDを書くまでの間にある。
    assert(
      Number.isSafeInteger(pid) && pid > 0 && !isAlive(pid),
      `別のmutationの実行が進んでいます（PID ${holder || '未記入'}）。その実行が残っていなければ、${path}を消してから実行してください`,
    );
    takeOver(path, holder);
    break;
  }
  return () => rmSync(path, { force: true });
}

function journalPath(directory: string) {
  return join(directory, 'mutation-original.json');
}

function replacementPath(directory: string) {
  return join(directory, 'mutation-replacement.json');
}

function mutated(original: Buffer, { start, end, replacement }: Replacement) {
  const source = original.toString('utf8');
  return Buffer.from(source.slice(0, start) + replacement + source.slice(end));
}

type Ownership = Pick<Stats, 'mode' | 'uid' | 'gid'>;

function keepOwner(temp: string, { uid, gid }: Ownership) {
  try {
    chownSync(temp, uid, gid);
  } catch (error) {
    if (!hasErrorCode(error, 'EPERM')) {
      throw error;
    }
  }
}

function replaceTarget(directory: string, file: string, content: Buffer, ownership: Ownership) {
  const temp = join(directory, 'mutation-target.tmp');
  rmSync(temp, { force: true });
  try {
    writeFileSync(temp, content);
    chmodSync(temp, ownership.mode & 0o7777);
    keepOwner(temp, ownership);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readReplacement(directory: string, original: Buffer): Replacement | undefined {
  let text: string;
  try {
    text = readFileSync(replacementPath(directory), 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  const replacement: unknown = JSON.parse(text);
  const length = original.toString('utf8').length;
  assert(
    isRecord(replacement) &&
      typeof replacement.replacement === 'string' &&
      Number.isSafeInteger(replacement.start) &&
      Number.isSafeInteger(replacement.end) &&
      0 <= Number(replacement.start) &&
      Number(replacement.start) <= Number(replacement.end) &&
      Number(replacement.end) <= length,
    `前の実行の記録を読めません。対象のファイルを確かめてから、${journalPath(directory)}を消してください`,
  );
  return {
    start: Number(replacement.start),
    end: Number(replacement.end),
    replacement: replacement.replacement,
  };
}

function removeJournal(directory: string) {
  rmSync(replacementPath(directory), { force: true });
  rmSync(journalPath(directory));
}

type Recovery = { kind: 'none' } | { kind: 'restored' | 'dropped'; path: string };

/** 前の実行が壊し方を当てたまま終わっていれば、記録した元の内容に戻す。対象のファイルがHEADと同じ内容なら、記録だけを消す。 */
function restoreInterrupted(root: string, directory: string): Recovery {
  let text: string;
  try {
    text = readFileSync(journalPath(directory), 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { kind: 'none' };
    }
    throw error;
  }
  const journal: unknown = JSON.parse(text);
  assert(
    isRecord(journal) && typeof journal.path === 'string' && typeof journal.original === 'string',
    `前の実行の記録を読めません。対象のファイルを確かめてから、${journalPath(directory)}を消してください`,
  );
  assertRepoRelativePath(journal.path);
  const file = join(root, journal.path);
  const original = Buffer.from(journal.original, 'base64');
  assert(
    existsSync(file),
    `前の実行の記録${journalPath(directory)}が残っていますが、${journal.path}がありません。移した先のファイルに壊し方が残っていないか確かめてから、記録を消してください`,
  );
  const current = readFileSync(file);
  if (current.equals(original)) {
    removeJournal(directory);
    return { kind: 'none' };
  }
  if (matchesHead(root, journal.path)) {
    removeJournal(directory);
    return { kind: 'dropped', path: journal.path };
  }
  const replacement = readReplacement(directory, original);
  assert(
    replacement !== undefined && current.equals(mutated(original, replacement)),
    `前の実行の記録${journalPath(directory)}が残っていますが、${journal.path}は当てた壊し方とも元の内容とも違うため、上書きしません。${journal.path}を確かめてから、記録を消してください`,
  );
  replaceTarget(directory, file, original, statSync(file));
  removeJournal(directory);
  return { kind: 'restored', path: journal.path };
}

function reportRecovery(recovery: Recovery) {
  if (recovery.kind === 'restored') {
    console.error(`前の実行が壊し方を当てたまま終わった${recovery.path}を、元の内容に戻しました`);
  } else if (recovery.kind === 'dropped') {
    console.error(`${recovery.path}がHEADと同じ内容のため、前の実行の記録だけを消しました`);
  }
}

export function restoreRemaining(root: string) {
  const directory = recordsDirectory(root);
  const unlock = lock(directory);
  try {
    const recovery = restoreInterrupted(root, directory);
    if (recovery.kind === 'none') {
      console.error('前の実行が壊し方を当てたまま終わったファイルはありません');
    } else {
      reportRecovery(recovery);
    }
  } finally {
    unlock();
  }
}

function headBlob(root: string, path: string) {
  // HEAD:<パス>はGitのルートから解決する。./を付けると、rootがGitのルートより下でもrootから解決する。
  return gitOutput(root, ['rev-parse', '--verify', '--quiet', `HEAD:./${path}`]);
}

function workingBlob(root: string, path: string) {
  // hash-objectは、-wを付けなければGitのディレクトリへ書かない。
  return gitOutput(root, ['hash-object', '--', path]);
}

function matchesHead(root: string, path: string) {
  const head = headBlob(root, path);
  return Boolean(head) && workingBlob(root, path) === head;
}

function assertMatchesHead(root: string, path: string) {
  const head = headBlob(root, path);
  assert(head, `${path}がHEADにありません。commitしてから実行してください`);
  assert(
    workingBlob(root, path) === head,
    `${path}がHEADの内容と違います。commitするか元に戻してから実行してください`,
  );
}

async function pendingSignalsDelivered() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * pathのファイルに壊し方を当てるworkを、ほかの実行と重ならないように実行する。
 * 当てる前に元の内容を記録し、終了時に元へ戻す。強制終了された場合は、次の実行が記録から戻す。
 * 子のコマンドが走っていない合間に受けた取消は、ここで覚え、workの確かめる箇所とworkの終了後に失敗として投げる。
 */
export async function guardMutation<T>(
  root: string,
  path: string,
  work: (target: MutationTarget) => Promise<T>,
): Promise<T> {
  const directory = recordsDirectory(root);
  const unlock = lock(directory);
  let received: NodeJS.Signals | undefined;
  const receive = (signal: NodeJS.Signals) => {
    received ??= signal;
  };
  const assertNotCancelled = async () => {
    await pendingSignalsDelivered();
    assert(received === undefined, `${received}で取り消されました`);
  };
  for (const signal of cancellationSignals) {
    process.on(signal, receive);
  }
  try {
    reportRecovery(restoreInterrupted(root, directory));
    assertMatchesHead(root, path);
    const file = join(root, path);
    const original = readFileSync(file);
    const ownership = statSync(file);
    rmSync(replacementPath(directory), { force: true });
    writeAtomically(
      journalPath(directory),
      JSON.stringify({ path, original: original.toString('base64') }),
    );
    let result: T;
    try {
      result = await work({
        source: original.toString('utf8'),
        apply: (replacement) => {
          const { start, end } = replacement;
          writeAtomically(
            replacementPath(directory),
            JSON.stringify({ start, end, replacement: replacement.replacement }),
          );
          replaceTarget(directory, file, mutated(original, replacement), ownership);
        },
        restore: () => replaceTarget(directory, file, original, ownership),
        assertNotCancelled,
      });
    } finally {
      replaceTarget(directory, file, original, ownership);
      removeJournal(directory);
    }
    // 最後の壊し方の後に受けた取消も、結果を返さずに失敗とする。
    await assertNotCancelled();
    return result;
  } finally {
    for (const signal of cancellationSignals) {
      process.off(signal, receive);
    }
    unlock();
  }
}
