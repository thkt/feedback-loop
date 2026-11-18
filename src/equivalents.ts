import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutantsRecordFile } from './config.ts';
import { errorMessage, hasErrorCode, isRecord } from './values.ts';

/** 動作の変わらない壊し方の記録1件。reasonは、記録した人が書いた、動作が変わらない理由である。 */
export type Equivalent = { key: string; reason: string };

function invalid(detail: string) {
  return `${mutantsRecordFile}の形が崩れています（${detail}）。{"equivalent":[{"key":"<鍵>","reason":"<理由>"}]}の形で書いてください`;
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
    assert(
      isRecord(entry) &&
        Object.keys(entry).length === 2 &&
        filled(entry.key) &&
        filled(entry.reason),
      invalid(`${index + 1}件目は、空でないkeyとreasonだけを持ちます`),
    );
    assert(!keys.has(entry.key), invalid(`鍵が重なっています: ${entry.key}`));
    keys.add(entry.key);
    return { key: entry.key, reason: entry.reason };
  });
}
