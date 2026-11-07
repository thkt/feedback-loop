import { createHash } from 'node:crypto';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
