import assert from 'node:assert/strict';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOutput } from './git.ts';
import { recordsDirectory } from './records.ts';
import { assertRepoRelativePath, hasErrorCode, isRecord, sha256 } from './values.ts';

/** 壊し方を当てる対象のファイル。sourceは、壊していない内容である。 */
export type MutationTarget = {
  source: string;
  apply: (content: string) => void;
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

/** 実行中を示すロックを取る。強制終了された実行のロックは、PIDが消えていれば引き継ぐ。 */
function lock(directory: string) {
  const path = join(directory, 'mutation.lock');
  if (!create(path)) {
    const holder = Number(readFileSync(path, 'utf8'));
    assert(
      !(Number.isSafeInteger(holder) && holder > 0 && isAlive(holder)),
      `別のmutationの実行が進んでいます（PID ${holder}）。その実行が残っていなければ、${path}を消してから実行してください`,
    );
    rmSync(path, { force: true });
    // 消した後に別の実行が先にロックを取った場合は、引き継がずに止める。
    assert(create(path), '別のmutationの実行が先にロックを取りました');
  }
  return () => rmSync(path, { force: true });
}

function journalPath(directory: string) {
  return join(directory, 'mutation-original.json');
}

type Journal = { path: string; original: string; applied: string | undefined };

/** 対象のファイルと、当てる壊し方の内容のhashを記録する。ファイルを書き換える前に呼ぶ。 */
function writeJournal(directory: string, journal: Journal) {
  const temp = `${journalPath(directory)}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(journal));
  renameSync(temp, journalPath(directory));
}

/**
 * 前の実行が壊し方を当てたまま終わっていれば、記録した元の内容に戻し、そのパスを返す。
 * 今の内容が当てた壊し方と一致するときだけ戻す。元の内容と一致すれば、記録を消すだけにする。
 * どちらとも違えば、利用者が書き換えた内容を上書きせずに止める。
 */
function restoreInterrupted(root: string, directory: string) {
  let text: string;
  try {
    text = readFileSync(journalPath(directory), 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  const journal: unknown = JSON.parse(text);
  assert(
    isRecord(journal) &&
      typeof journal.path === 'string' &&
      typeof journal.original === 'string' &&
      (journal.applied === undefined || typeof journal.applied === 'string'),
    `前の実行の記録を読めません。対象のファイルを確かめてから、${journalPath(directory)}を消してください`,
  );
  assertRepoRelativePath(journal.path);
  const file = join(root, journal.path);
  const original = Buffer.from(journal.original, 'base64');
  const current = readFileSync(file);
  if (current.equals(original)) {
    rmSync(journalPath(directory));
    return undefined;
  }
  assert(
    journal.applied !== undefined && sha256(current) === journal.applied,
    `前の実行の記録${journalPath(directory)}が残っていますが、${journal.path}は当てた壊し方とも元の内容とも違うため、上書きしません。${journal.path}を確かめてから、記録を消してください`,
  );
  writeFileSync(file, original);
  rmSync(journalPath(directory));
  return journal.path;
}

function assertMatchesHead(root: string, path: string) {
  // HEAD:<パス>はGitのルートから解決する。./を付けると、rootがGitのルートより下でもrootから解決する。
  const head = gitOutput(root, ['rev-parse', '--verify', '--quiet', `HEAD:./${path}`]);
  assert(head, `${path}がHEADにありません。commitしてから実行してください`);
  // hash-objectは、-wを付けなければGitのディレクトリへ書かない。
  assert(
    gitOutput(root, ['hash-object', '--', path]) === head,
    `${path}がHEADの内容と違います。commitするか元に戻してから実行してください`,
  );
}

/**
 * pathのファイルに壊し方を当てるworkを、ほかの実行と重ならないように実行する。
 * 当てる前に元の内容を記録し、終了時に元へ戻す。強制終了された場合は、次の実行が記録から戻す。
 * 子のコマンドの実行中のSIGINT・SIGTERMは、コマンドの実行部が受けて実行を止める。
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
  // spawnSyncなどの同期の処理の間に届いたシグナルは、イベントループが1周するまで受け口に届かない。
  const assertNotCancelled = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert(received === undefined, `${received}で取り消されました`);
  };
  process.on('SIGINT', receive);
  process.on('SIGTERM', receive);
  try {
    const restored = restoreInterrupted(root, directory);
    if (restored !== undefined) {
      console.error(`前の実行が壊し方を当てたまま終わった${restored}を、元の内容に戻しました`);
    }
    assertMatchesHead(root, path);
    const file = join(root, path);
    const original = readFileSync(file);
    const journal = { path, original: original.toString('base64') };
    writeJournal(directory, { ...journal, applied: undefined });
    let result: T;
    try {
      result = await work({
        source: original.toString('utf8'),
        apply: (content) => {
          // 強制終了の後の実行が、残った内容を壊し方だと見分けられるよう、書き換える前にhashを記録する。
          writeJournal(directory, { ...journal, applied: sha256(content) });
          writeFileSync(file, content);
        },
        restore: () => writeFileSync(file, original),
        assertNotCancelled,
      });
    } finally {
      writeFileSync(file, original);
      rmSync(journalPath(directory));
    }
    // 最後の壊し方の後に受けた取消も、結果を返さずに失敗とする。
    await assertNotCancelled();
    return result;
  } finally {
    process.off('SIGINT', receive);
    process.off('SIGTERM', receive);
    unlock();
  }
}
