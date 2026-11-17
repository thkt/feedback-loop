import assert from 'node:assert/strict';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOutput } from './git.ts';
import { recordsDirectory } from './records.ts';
import { assertRepoRelativePath, hasErrorCode, isRecord } from './values.ts';

/** 壊し方を当てる対象のファイル。sourceは、壊していない内容である。 */
export type MutationTarget = {
  source: string;
  apply: (content: string) => void;
  restore: () => void;
  // 取消のシグナルを受けていたら、その旨を投げる。壊し方を当てる前に呼ぶ。
  assertNotCancelled: () => void;
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

/** 前の実行が壊し方を当てたまま終わっていれば、記録した元の内容に戻し、そのパスを返す。 */
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
    isRecord(journal) && typeof journal.path === 'string' && typeof journal.original === 'string',
    `前の実行の記録を読めません。対象のファイルを確かめてから、${journalPath(directory)}を消してください`,
  );
  assertRepoRelativePath(journal.path);
  writeFileSync(join(root, journal.path), Buffer.from(journal.original, 'base64'));
  rmSync(journalPath(directory));
  return journal.path;
}

function assertMatchesHead(root: string, path: string) {
  const head = gitOutput(root, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`]);
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
 * 実行中のSIGINT・SIGTERMは、コマンドの実行部が受けて実行を止める。ここでは受けたことだけを覚え、元に戻してから終える。
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
    const temp = `${journalPath(directory)}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ path, original: original.toString('base64') }));
    renameSync(temp, journalPath(directory));
    try {
      return await work({
        source: original.toString('utf8'),
        apply: (content) => writeFileSync(file, content),
        restore: () => writeFileSync(file, original),
        assertNotCancelled: () => assert(received === undefined, `${received}で取り消されました`),
      });
    } finally {
      writeFileSync(file, original);
      rmSync(journalPath(directory));
    }
  } finally {
    process.off('SIGINT', receive);
    process.off('SIGTERM', receive);
    unlock();
  }
}
