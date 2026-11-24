import { expect } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files } from './feedback-loop-batch.ts';
import type { Fixture } from './feedback-loop-batch.ts';
import { isRecord } from './json.ts';
import { vitestModules } from './vitest.ts';

export const mutatorConfig = {
  ...config,
  bunWorkers: 1,
  testArgs: ['--timeout', '4000'],
};

export const mutatorFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  '.feedback-loop.json': JSON.stringify(mutatorConfig),
};

export async function linkModules(directory: string) {
  await symlink(vitestModules, join(directory, 'node_modules'));
}

export function parseReport(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

type Listed = {
  key: string;
  path: string;
  line: number;
  rule: string;
  original: string;
  replacement: string;
};

function isListed(value: unknown): value is Listed {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.path === 'string' &&
    typeof value.line === 'number' &&
    typeof value.rule === 'string' &&
    typeof value.original === 'string' &&
    typeof value.replacement === 'string'
  );
}

export function listed(report: unknown, name: 'survived' | 'uncovered' | 'timedOut' | 'errors') {
  assert(isRecord(report), 'mutationの標準出力がJSONのオブジェクトではありません');
  const value = report[name];
  assert(Array.isArray(value) && value.every(isListed), `${name}の要素の形が違います`);
  return value;
}

export function withoutKeys(items: Listed[]) {
  return items.map(({ key: _key, ...rest }) => rest);
}

export function keyOf(items: Listed[], original: string, replacement: string) {
  const found = items.find(
    (item) => item.original === original && item.replacement === replacement,
  );
  expect(found, `${original} -> ${replacement}`).toBeDefined();
  return found?.key ?? '';
}

export function prepareCount(f: Fixture) {
  const log = join(f.signals, 'prepare.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}

export const narrowingItem = {
  path: 'src/rules.ts',
  line: 2,
  rule: 'ConditionalExpression',
  original: "typeof value !== 'string'",
  replacement: 'false',
};
