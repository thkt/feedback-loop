import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as oxc from 'oxc-parser';
import { mutants } from '../src/mutants.ts';

/** 先頭でexportした関数の本体にある文の数。構文解析に失敗すれば落とす。 */
function functionStatements(path: string, source: string) {
  const { program, errors } = oxc.parseSync(path, source);
  expect(errors).toEqual([]);
  const [declaration] = program.body;
  return declaration?.type === 'ExportNamedDeclaration' &&
    declaration.declaration?.type === 'FunctionDeclaration'
    ? declaration.declaration.body?.body.length
    : undefined;
}

function edits(path: string, source: string) {
  return mutants(oxc, path, source).map(({ rule, original, replacement }) => ({
    rule,
    original,
    replacement,
  }));
}

test('比較の>は>=へ置き換え、型引数とアロー関数の>は壊さない', () => {
  const source = `export const first = <T,>(items: Array<T>): T | undefined => items[0];
export function isAdult(age: number): boolean {
  return age > 17;
}
`;
  const found = mutants(oxc, 'src/age.ts', source);
  expect(
    found
      .filter((mutant) => mutant.rule === 'EqualityOperator')
      .map(({ line, original, replacement }) => ({ line, original, replacement })),
  ).toEqual([
    { line: 3, original: 'age > 17', replacement: 'age >= 17' },
    { line: 3, original: 'age > 17', replacement: 'age <= 17' },
  ]);
  // 型引数とアロー関数の>を含む1行目からは、壊し方を作らない。
  expect(found.filter((mutant) => mutant.line === 1)).toEqual([]);
});

test('||でつないだ条件からは、片方の項をfalseにして取り除いた壊し方を作る', () => {
  const found = edits(
    'src/either.ts',
    'export function either(a: number, b: number) {\n  return a > 1 || b < 0;\n}\n',
  );
  expect(found).toContainEqual({
    rule: 'ConditionalExpression',
    original: 'a > 1',
    replacement: 'false',
  });
  expect(found).toContainEqual({
    rule: 'ConditionalExpression',
    original: 'b < 0',
    replacement: 'false',
  });
  // a || trueは、式全体をtrueにする壊し方と同じになるため作らない。
  expect(found).not.toContainEqual({
    rule: 'ConditionalExpression',
    original: 'b < 0',
    replacement: 'true',
  });
});

test('比較の演算子を置き換えるとき、項の間のコメントの中の同じ字は書き換えない', () => {
  const found = edits(
    'src/lt.ts',
    'export function lt(a: number, b: number) {\n  return a /* a<b */ < b;\n}\n',
  );
  expect(found.filter(({ rule }) => rule === 'EqualityOperator')).toEqual([
    { rule: 'EqualityOperator', original: 'a /* a<b */ < b', replacement: 'a /* a<b */ <= b' },
    { rule: 'EqualityOperator', original: 'a /* a<b */ < b', replacement: 'a /* a<b */ >= b' },
  ]);
});

test('セミコロンを省いたソースの式文から作る論理演算子の壊し方は、前の行の式とつながらない', () => {
  const source = `export function run(load: () => unknown, ready: boolean, start: () => boolean) {
  const a = load()
  ready && start()
  return a
}
`;
  const logical = mutants(oxc, 'src/run.ts', source).filter(
    ({ rule }) => rule === 'LogicalOperator',
  );
  expect(logical).toHaveLength(1);
  const [only] = logical;
  assert(only !== undefined);
  const mutated = source.slice(0, only.start) + only.replacement + source.slice(only.end);
  expect(functionStatements('src/run.ts', mutated)).toBe(3);
});

test('return falseからは、return trueへ置き換える壊し方を作る', () => {
  expect(edits('src/flag.ts', 'export function flag() {\n  return false;\n}\n')).toEqual([
    { rule: 'BooleanLiteral', original: 'false', replacement: 'true' },
  ]);
});

test('同じソースからは同じ鍵と置き換えの壊し方を同じ順で作り、前に文を足しても鍵を変えない', () => {
  const body = `export const enabled = process.env.MODE !== 'off';
export function check(a: number, b: boolean) {
  if (a >= 0 && !b) {
    return a === 1 ? true : a < 5;
  }
  return false;
}
`;
  const first = mutants(oxc, 'src/check.ts', body);
  expect(first.length).toBeGreaterThan(5);
  expect(new Set(first.map((mutant) => mutant.key)).size).toBe(first.length);
  expect(mutants(oxc, 'src/check.ts', body)).toEqual(first);
  // 足す文は壊し方を持たない。ファイルの先頭の文とその後ろの関数の鍵は、位置がずれても変わらない。
  const shifted = mutants(
    oxc,
    'src/check.ts',
    `import { x } from './x.ts';\nexport const before = x;\n\n${body}`,
  );
  expect(shifted.map(({ key, replacement }) => ({ key, replacement }))).toEqual(
    first.map(({ key, replacement }) => ({ key, replacement })),
  );
});

test('同じ名前のメソッドとアクセサや、名前のない関数の同じ位置からも、重ならない鍵を作る', () => {
  const source = `export class A {
  isEmpty() { return this.n === 0; }
  get value() { return this.n > 0; }
  set value(v: number) { this.n = v > 0 ? v : 0; }
}
export class B {
  isEmpty() { return this.n === 0; }
}
export const handlers = [() => 1 > 0, () => 1 > 0];
`;
  const found = mutants(oxc, 'src/classes.ts', source);
  const keys = found.map((mutant) => mutant.key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.some((key) => key.startsWith('src/classes.ts:A.isEmpty:'))).toBe(true);
  expect(keys.some((key) => key.startsWith('src/classes.ts:B.isEmpty:'))).toBe(true);
  expect(keys.some((key) => key.startsWith('src/classes.ts:get A.value:'))).toBe(true);
  expect(keys.some((key) => key.startsWith('src/classes.ts:set A.value:'))).toBe(true);
});
