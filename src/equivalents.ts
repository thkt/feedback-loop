import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { mutantsRecordFile } from './config.ts';
import { keyPath } from './mutants.ts';
import { errorMessage, hasErrorCode, isRecord, isRepoRelativePath } from './values.ts';

/**
 * 動作の変わらない壊し方の記録1件。reasonは、記録した人が書いた、動作が変わらない理由である。
 * originalは、記録したときの置き換える前の字である。鍵は関数の中の位置と置き換えのhashでできており、
 * 位置の移動や式の書き換えで別の式を指すようになるため、今の壊し方と照らして見分ける。
 */
export type Equivalent = { key: string; original: string; reason: string };

/** 鍵の形の説明。記録ファイルと--keyの診断に使う。 */
export const keyShape =
  "鍵は、repoからのそろえたパス（./や前後の空白を持たない）と、関数、経路、規則、hashを':'でつなぎます";

/**
 * 鍵のパス。鍵がパス、関数、経路、規則、hashの5つ以上の部分を持ち、パスがrepoからのそろえたパスのときだけ返す。
 * 壊し方の鍵はそろえたパスから作るため、./や前後の空白を持つパスの鍵は、どの壊し方の鍵とも一致しない。
 */
export function keyModule(key: string): string | undefined {
  const path = keyPath(key);
  return path !== undefined &&
    key.split(':').length >= 5 &&
    path !== '' &&
    path.trim() === path &&
    posix.normalize(path) === path &&
    isRepoRelativePath(path)
    ? path
    : undefined;
}

/**
 * pathのファイルがrootにあるか。区切りごとに名前が大文字と小文字まで一致するかで確かめる。
 * 大文字と小文字を区別しないファイルシステムでも、名前の違う記録をあるとみなさない。読めなければ無いとみなす。
 */
export function fileExists(root: string, path: string) {
  let current = root;
  for (const name of path.split('/')) {
    try {
      if (!readdirSync(current).includes(name)) {
        return false;
      }
    } catch {
      return false;
    }
    current = join(current, name);
  }
  try {
    return statSync(current).isFile();
  } catch {
    return false;
  }
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
    // ディレクトリなどで読めないときも、どのファイルかを示して止める。
    return assert.fail(`${mutantsRecordFile}を読めません: ${errorMessage(error)}`);
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
  assert(
    keyModule(entry.key) !== undefined,
    invalid(`${index + 1}件目の鍵: ${entry.key}。${keyShape}`),
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
