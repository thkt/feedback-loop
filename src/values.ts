import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertObject(value: unknown): asserts value is Record<string, unknown> {
  assert(isRecord(value), 'オブジェクトが必要です');
}

/** 値がすべて文字列のオブジェクトであることを確かめ、その写しを返す。 */
export function stringRecord(value: unknown): Record<string, string> {
  assertObject(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    assert(typeof item === 'string', `${key}は文字列で指定してください`);
    result[key] = item;
  }
  return result;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrorCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function sha256(body: string | Uint8Array) {
  return createHash('sha256').update(body).digest('hex');
}

/** 先頭のmajor.minor.patchを数値で比べる。読めない版は満たさないと扱う。 */
export function versionAtLeast(version: string | undefined, minimum: string) {
  const parse = (text: string | undefined) =>
    /^(\d+)\.(\d+)\.(\d+)/
      .exec(text ?? '')
      ?.slice(1)
      .map(Number);
  const [actual, required] = [parse(version), parse(minimum)];
  if (!actual || !required) {
    return false;
  }
  for (const [index, part] of required.entries()) {
    const found = actual[index] ?? 0;
    if (found !== part) {
      return found > part;
    }
  }
  return true;
}
