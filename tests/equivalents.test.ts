import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists, readEquivalents } from '../src/equivalents.ts';

function withRecord(content: string | undefined, check: (root: string) => void) {
  // 導入先のrootと同じく、実際のパスにそろえる。macOSのtmpdirはsymlinkを通る。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'feedback-loop-equivalents-')));
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

test('記録の鍵のパスは、実際のファイルのそろえたパスと一致するときだけあるとみなす', () => {
  withRecord(undefined, (root) => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/rules.ts'), '');
    expect(fileExists(root, 'src/rules.ts')).toBe(true);
    // 大文字と小文字だけが違うパスと、symlinkのパスは、生成する鍵のパスと一致しない。
    expect(fileExists(root, 'src/Rules.ts')).toBe(false);
    symlinkSync('rules.ts', join(root, 'src/link.ts'));
    expect(fileExists(root, 'src/link.ts')).toBe(false);
    expect(fileExists(root, 'src')).toBe(false);
    // ファイルの下を指すパスと長すぎる名前は、statでは投げる。
    expect(fileExists(root, 'src/rules.ts/x.ts')).toBe(false);
    expect(fileExists(root, `src/${'a'.repeat(300)}.ts`)).toBe(false);
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
  ['鍵の部分が足りない', withKey('isAdult:body:EqualityOperator:ff43f56b7f96'), '1件目の鍵:'],
  ['鍵のパスが./で始まる', withKey(`./${entry.key}`), '1件目の鍵:'],
  ['鍵のパスが前に空白を持つ', withKey(` ${entry.key}`), '1件目の鍵:'],
  ['鍵のパスが後ろに空白を持つ', withKey(entry.key.replace(':', ' :')), '1件目の鍵:'],
  ['鍵のパスがrepoの外を指す', withKey(`../${entry.key}`), '1件目の鍵:'],
  [
    '鍵のパスが置き換えていない%を持つ',
    withKey('a%b.ts:isAdult:body:EqualityOperator:ff43f56b7f96'),
    '1件目の鍵: a%b.ts:isAdult:body:EqualityOperator:ff43f56b7f96。',
  ],
  [
    '鍵のパスが小文字の%3aを持つ',
    withKey('src/a%3ab.ts:isAdult:body:EqualityOperator:ff43f56b7f96'),
    '1件目の鍵: src/a%3ab.ts:isAdult:body:EqualityOperator:ff43f56b7f96。',
  ],
  [
    '鍵のパスが.だけである',
    withKey('.:isAdult:body:EqualityOperator:ff43f56b7f96'),
    '1件目の鍵: .:isAdult:body:EqualityOperator:ff43f56b7f96。',
  ],
  [
    '鍵のパスが/で終わる',
    withKey('src/:isAdult:body:EqualityOperator:ff43f56b7f96'),
    '1件目の鍵: src/:isAdult:body:EqualityOperator:ff43f56b7f96。',
  ],
  ['鍵の部分が多すぎる', withKey(`${entry.key}:x`), `1件目の鍵: ${entry.key}:x。`],
  ['鍵が重なる', JSON.stringify({ equivalent: [entry, entry] }), '鍵が重なっています'],
])('記録ファイルの%sとき、記録ファイルのパスを示して拒否する', (_, content, detail) => {
  withRecord(content, (root) =>
    expect(() => readEquivalents(root)).toThrow(
      new RegExp(`^\\.feedback-loop-mutants\\.jsonの形が崩れています（.*${RegExp.escape(detail)}`),
    ),
  );
});

test('記録ファイルの位置がディレクトリで読めないとき、記録ファイルのパスを示して止める', () => {
  withRecord(undefined, (root) => {
    mkdirSync(join(root, '.feedback-loop-mutants.json'));
    expect(() => readEquivalents(root)).toThrow(/^\.feedback-loop-mutants\.jsonを読めません: /);
  });
});
