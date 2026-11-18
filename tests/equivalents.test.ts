import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyPath, readEquivalents } from '../src/equivalents.ts';

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

const entry = {
  key: 'src/rules.ts:isAdult:body:EqualityOperator:ff43f56b7f96',
  original: 'age >= 18',
  reason: '理由',
};

test('鍵のパスは、末尾の関数、経路、規則、hashを除いた残りであり、パスと関数のどちらが:を含んでも、repoにあるファイルで境界を分ける', () => {
  withRecord(undefined, (root) => {
    mkdirSync(join(root, 'src'));
    for (const file of ['src/rules.ts', 'src/a:b.ts', 'src/events.ts']) {
      writeFileSync(join(root, file), '');
    }
    expect(keyPath(root, entry.key)).toBe('src/rules.ts');
    expect(keyPath(root, 'src/a:b.ts:<top>:body{x}:BooleanLiteral:0123456789ab#2')).toBe(
      'src/a:b.ts',
    );
    // 文字列リテラルのメンバー名は、関数の部分に:を持ち込む。
    expect(
      keyPath(root, 'src/events.ts:handlers.user:created:body:EqualityOperator:5b25bbe9dbd4'),
    ).toBe('src/events.ts');
    expect(keyPath(root, 'src/a:b.ts:handlers.x:y:body:EqualityOperator:5b25bbe9dbd4')).toBe(
      'src/a:b.ts',
    );
    expect(keyPath(root, 'src/gone.ts:check:body:BooleanLiteral:000000000000')).toBeUndefined();
    expect(keyPath(root, 'src/rules.ts:body:BooleanLiteral:0123456789ab')).toBeUndefined();
  });
});

test('記録ファイルが無ければ0件とし、形の合う記録は鍵と置き換える前の字と理由を返す', () => {
  withRecord(undefined, (root) => expect(readEquivalents(root)).toEqual([]));
  withRecord(JSON.stringify({ equivalent: [entry] }), (root) =>
    expect(readEquivalents(root)).toEqual([entry]),
  );
});

const withKey = (key: string) => JSON.stringify({ equivalent: [{ ...entry, key }] });

test.each([
  ['JSONでない', '{', 'JSONとして読めません'],
  ['最上位にほかのキーがある', JSON.stringify({ equivalent: [entry], note: 1 }), '最上位は'],
  ['equivalentが配列でない', JSON.stringify({ equivalent: entry }), '最上位は'],
  ['項目にほかのキーがある', JSON.stringify({ equivalent: [{ ...entry, by: 'a' }] }), '1件目は'],
  [
    'originalが無い',
    JSON.stringify({ equivalent: [{ key: entry.key, reason: '理由' }] }),
    '1件目は',
  ],
  [
    'originalが文字列でない',
    JSON.stringify({ equivalent: [{ ...entry, original: 1 }] }),
    '1件目は',
  ],
  ['reasonが無い', JSON.stringify({ equivalent: [{ key: entry.key, original: 'a' }] }), '1件目は'],
  ['reasonが空白だけ', JSON.stringify({ equivalent: [{ ...entry, reason: ' ' }] }), '1件目は'],
  ['鍵の部分が足りない', withKey('isAdult:body:EqualityOperator:ff43f56b7f96'), '1件目の鍵は'],
  ['鍵のパスが./で始まる', withKey(`./${entry.key}`), '1件目の鍵は'],
  ['鍵のパスが前に空白を持つ', withKey(` ${entry.key}`), '1件目の鍵は'],
  ['鍵のパスが後ろに空白を持つ', withKey(entry.key.replace(':', ' :')), '1件目の鍵は'],
  ['鍵のパスがrepoの外を指す', withKey(`../${entry.key}`), '1件目の鍵は'],
  ['鍵が重なる', JSON.stringify({ equivalent: [entry, entry] }), '鍵が重なっています'],
])('記録ファイルの%sとき、記録ファイルのパスを示して拒否する', (_, content, detail) => {
  withRecord(content, (root) =>
    expect(() => readEquivalents(root)).toThrow(
      new RegExp(`^\\.feedback-loop-mutants\\.jsonの形が崩れています（.*${detail}`),
    ),
  );
});
