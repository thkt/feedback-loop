import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { mutantsRecordFile } from './config.ts';
import { errorMessage, hasErrorCode, isRecord } from './values.ts';

/**
 * 動作の変わらない壊し方の記録1件。reasonは、記録した人が書いた、動作が変わらない理由である。
 * originalは、記録したときの置き換える前の字である。鍵は関数の中の位置と置き換えのhashでできており、
 * 位置の移動や式の書き換えで別の式を指すようになるため、今の壊し方と照らして見分ける。
 */
export type Equivalent = { key: string; original: string; reason: string };

/**
 * 鍵のパスの候補を、短い順に返す。経路、規則、hashの末尾の3つの部分は':'を含まない。
 * 関数の部分は文字列リテラルのメンバー名（'user:created'など）から':'を含みうるため、
 * 残りの「パス:関数」のどの':'がパスと関数の境界かは、鍵の字だけでは決まらない。
 */
function pathCandidates(key: string): string[] {
  const head = key.split(':').slice(0, -3);
  return head.slice(1).map((_, index) => head.slice(0, index + 1).join(':'));
}

/**
 * 鍵のパス。鍵の末尾の4つの部分（関数、経路、規則、hash）を除いた残りである。
 * パスと関数の境界は、repoにファイルとして在る最も長い候補で決める。どの候補もファイルでなければundefinedを返す。
 */
export function keyPath(root: string, key: string): string | undefined {
  return pathCandidates(key).findLast(
    (path) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true,
  );
}

// 鍵のパスが、repoからのそろえたパスか。./や前後の空白を持つ鍵は、壊し方の鍵と一致しない。
function isRepoPath(path: string) {
  return (
    path !== '' &&
    path.trim() === path &&
    posix.normalize(path) === path &&
    !isAbsolute(path) &&
    !path.split('/').includes('..') &&
    !path.includes('\\')
  );
}

function invalid(detail: string) {
  return `${mutantsRecordFile}の形が崩れています（${detail}）。{"equivalent":[{"key":"<鍵>","original":"<置き換える前の字>","reason":"<理由>"}]}の形で書いてください`;
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function readText(root: string) {
  try {
    return readFileSync(join(root, mutantsRecordFile), 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function entryAt(entry: unknown, index: number): Equivalent {
  assert(
    isRecord(entry) &&
      Object.keys(entry).length === 3 &&
      typeof entry.key === 'string' &&
      typeof entry.original === 'string' &&
      filled(entry.reason),
    invalid(`${index + 1}件目は、文字列のkeyとoriginalと、空でないreasonだけを持ちます`),
  );
  // ファイルの消えた記録も形を確かめられるよう、ファイルを見ずに最も短い候補で確かめる。./や前後の空白は、この候補に現れる。
  const [path] = pathCandidates(entry.key);
  assert(
    path !== undefined && isRepoPath(path),
    invalid(
      `${index + 1}件目の鍵は、repoからのパスと、関数、経路、規則、hashを':'でつなぎます: ${entry.key}`,
    ),
  );
  return { key: entry.key, original: entry.original, reason: entry.reason };
}

/** rootの記録ファイルを読み、形を確かめる。ファイルが無ければ0件である。 */
export function readEquivalents(root: string): Equivalent[] {
  const text = readText(root);
  if (text === undefined) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    assert.fail(invalid(`JSONとして読めません: ${errorMessage(error)}`));
  }
  assert(
    isRecord(value) && Object.keys(value).length === 1 && Array.isArray(value.equivalent),
    invalid('最上位はequivalentの配列だけを持ちます'),
  );
  const keys = new Set<string>();
  return value.equivalent.map((entry: unknown, index) => {
    const equivalent = entryAt(entry, index);
    assert(!keys.has(equivalent.key), invalid(`鍵が重なっています: ${equivalent.key}`));
    keys.add(equivalent.key);
    return equivalent;
  });
}
