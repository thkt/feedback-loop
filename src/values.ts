import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertObject(value: unknown): asserts value is Record<string, unknown> {
  assert(isRecord(value), 'オブジェクトが必要です');
}

export function assertStringArray(value: unknown): asserts value is string[] {
  assert(
    Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && item.trim().length > 0),
    '文字列配列が必要です',
  );
}

export function assertRepoRelativePath(path: string) {
  assert(
    !isAbsolute(path) &&
      !path.split('/').includes('..') &&
      !path.startsWith('./') &&
      !path.includes('\\'),
    `repo相対パスが必要です: ${path}`,
  );
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

/** シェルへ貼っても1つの引数として読まれる形にする。記号を含まない引数はそのまま返す。 */
export function shellQuote(argument: string) {
  return /^[\w./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
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

function parseVersion(text: string | undefined) {
  return /^(\d+)\.(\d+)\.(\d+)/
    .exec(text ?? '')
    ?.slice(1)
    .map(Number);
}

/** 先頭のmajor.minor.patchを数値で比べる。読めないバージョンは満たさないと扱う。 */
export function versionAtLeast(version: string | undefined, minimum: string) {
  const [actual, required] = [parseVersion(version), parseVersion(minimum)];
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
