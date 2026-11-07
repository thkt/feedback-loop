import { createHash } from 'node:crypto';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sha256(body: string | Uint8Array) {
  return createHash('sha256').update(body).digest('hex');
}
