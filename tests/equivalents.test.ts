import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEquivalents } from '../src/equivalents.ts';

function withRecord(content: string | undefined, check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'feedback-loop-equivalents-'));
  try {
    if (content !== undefined) {
      writeFileSync(join(root, '.feedback-loop-mutants.json'), content);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const entry = { key: 'src/rules.ts:isAdult:body:EqualityOperator:ff43f56b7f96', reason: '理由' };

test('記録ファイルが無ければ0件とし、形の合う記録は鍵と理由を返す', () => {
  withRecord(undefined, (root) => expect(readEquivalents(root)).toEqual([]));
  withRecord(JSON.stringify({ equivalent: [entry] }), (root) =>
    expect(readEquivalents(root)).toEqual([entry]),
  );
});

test.each([
  ['JSONでない', '{', 'JSONとして読めません'],
  ['最上位にほかのキーがある', JSON.stringify({ equivalent: [entry], note: 1 }), '最上位は'],
  ['equivalentが配列でない', JSON.stringify({ equivalent: entry }), '最上位は'],
  ['項目にほかのキーがある', JSON.stringify({ equivalent: [{ ...entry, by: 'a' }] }), '1件目'],
  ['reasonが無い', JSON.stringify({ equivalent: [{ key: entry.key }] }), '1件目'],
  ['reasonが空白だけ', JSON.stringify({ equivalent: [{ ...entry, reason: ' ' }] }), '1件目'],
  ['keyが空', JSON.stringify({ equivalent: [{ ...entry, key: '' }] }), '1件目'],
  ['鍵が重なる', JSON.stringify({ equivalent: [entry, entry] }), '鍵が重なっています'],
])('記録ファイルの%sとき、記録ファイルのパスを示して拒否する', (_, content, detail) => {
  withRecord(content, (root) =>
    expect(() => readEquivalents(root)).toThrow(
      new RegExp(`^\\.feedback-loop-mutants\\.jsonの形が崩れています（.*${detail}`),
    ),
  );
});
