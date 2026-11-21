import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as oxc from 'oxc-parser';
import { keyModule } from '../src/equivalents.ts';
import { keyPath, mutants } from '../src/mutants.ts';
import { isRecord } from '../src/values.ts';

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

test('波括弧の無いifの本体の式文から作る論理演算子の壊し方は、本体を空の文に変えない', () => {
  const source =
    'export function run(x: boolean, a: boolean, b: () => boolean) {\n  if (x) a && b();\n}\n';
  const logical = mutants(oxc, 'src/run.ts', source).filter(
    ({ rule }) => rule === 'LogicalOperator',
  );
  expect(logical).toHaveLength(1);
  const [only] = logical;
  assert(only !== undefined);
  const mutated = source.slice(0, only.start) + only.replacement + source.slice(only.end);
  const { program, errors } = oxc.parseSync('src/run.ts', mutated);
  expect(errors).toEqual([]);
  const [declaration] = program.body;
  assert(
    declaration?.type === 'ExportNamedDeclaration' &&
      declaration.declaration?.type === 'FunctionDeclaration',
  );
  const [statement] = declaration.declaration.body?.body ?? [];
  assert(statement?.type === 'IfStatement');
  expect(statement.consequent.type).toBe('ExpressionStatement');
});

test('セミコロンを省いたソースで、!を外して括弧で始まる式文になる壊し方は、前の行の式とつながらない', () => {
  const source = `export function run(foo: () => unknown, a: boolean, b: () => boolean) {
  foo()
  !(a) && b()
}
`;
  const negations = mutants(oxc, 'src/run.ts', source).filter(
    ({ rule, original }) => rule === 'BooleanLiteral' && original === '!(a)',
  );
  expect(negations).toHaveLength(1);
  const [only] = negations;
  assert(only !== undefined);
  const mutated = source.slice(0, only.start) + only.replacement + source.slice(only.end);
  expect(functionStatements('src/run.ts', mutated)).toBe(2);
});

/** nodeの下に、startからendまでをちょうど占める構文があるか。 */
function spans(node: unknown, start: number, end: number): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => spans(item, start, end));
  }
  if (!isRecord(node)) {
    return false;
  }
  if (node.start === start && node.end === end) {
    return true;
  }
  return Object.entries(node).some(([key, value]) => key !== 'parent' && spans(value, start, end));
}

test.each([
  ['後ろが即時実行の関数', 'let n = 0;\n!function () { n++ }();\n'],
  ['後ろがオブジェクトのリテラル', 'let p = 0;\n!{ a: 1 }.a && p++;\n'],
  ['後ろがセミコロンを省いた正規表現', 'const s = "a"\nconst f = () => 1\n!/re/.test(s) && f()\n'],
  ['後ろがセミコロンを省いた単項の-', 'let x = 1\nconst f = () => 1\n!-x && f()\n'],
  ['後ろがアロー関数の本体のオブジェクト', 'export const g = () => !{ a: 1 }.a;\n'],
  ['前が単項の+', 'export const f = (x: number) => +!+x;\n'],
  ['前が二項の-', 'export const g = (a: number, b: number) => a-!-b;\n'],
  ['前が空白を挟まないreturn', 'export function f(a: boolean, b: boolean) {\n  return!a||b;\n}\n'],
])('!の%sでも、どの壊し方も構文解析を通り、置き換えた範囲が1つの式として読まれる', (_, source) => {
  const found = mutants(oxc, 'src/edge.ts', source);
  expect(found.some(({ rule }) => rule === 'BooleanLiteral')).toBe(true);
  for (const { start, end, replacement } of found) {
    const mutated = source.slice(0, start) + replacement + source.slice(end);
    const { program, errors } = oxc.parseSync('src/edge.ts', mutated);
    expect(errors, mutated).toEqual([]);
    // 文や名前を区切るために先頭へ置いた;と空白は、置き換えた式に含めない。
    const from = /^[; ]/.test(replacement) ? start + 1 : start;
    expect(spans(program, from, start + replacement.length), mutated).toBe(true);
  }
});

test('namespaceとenumの中の実行時の式は壊し、declareで宣言した中は壊さない', () => {
  const found = edits(
    'src/space.ts',
    `export namespace N {
  export function f(a: number) {
    return a > 1;
  }
}
export enum E {
  B = 1 < 2 ? 3 : 4,
}
declare namespace D {
  const x = true;
}
`,
  );
  expect(found).toContainEqual({
    rule: 'EqualityOperator',
    original: 'a > 1',
    replacement: 'a >= 1',
  });
  expect(found).toContainEqual({
    rule: 'EqualityOperator',
    original: '1 < 2',
    replacement: '1 <= 2',
  });
  expect(found.filter(({ original }) => original === 'true')).toEqual([]);
});

test('計算したキーのメソッドは、同じ名前のメソッドの鍵を変えない', () => {
  const method = '  foo() { return 1 < 2; }\n';
  const plain = mutants(oxc, 'src/a.ts', `export class A {\n${method}}\n`);
  const computed = mutants(
    oxc,
    'src/a.ts',
    `const foo = 'k';\nexport class A {\n  [foo]() { return 1 < 2; }\n${method}}\n`,
  );
  expect(plain.length).toBeGreaterThan(0);
  // foo()は、計算したキーがなければ2行目に、あれば4行目にある。
  expect(computed.filter(({ line }) => line === 4).map(({ key }) => key)).toEqual(
    plain.map(({ key }) => key),
  );
});

test('return falseからは、return trueへ置き換える壊し方を作る', () => {
  expect(edits('src/flag.ts', 'export function flag() {\n  return false;\n}\n')).toEqual([
    { rule: 'BooleanLiteral', original: 'false', replacement: 'true' },
  ]);
});

test('everyはsomeへ入れ替え、trim()は呼び出しを外して呼び出し先の式だけを残す', () => {
  const found = edits(
    'src/names.ts',
    'export function valid(names: string[]) {\n  return names.every((name) => name.trim());\n}\n',
  );
  expect(found.filter(({ rule }) => rule === 'MethodExpression')).toEqual([
    { rule: 'MethodExpression', original: 'every', replacement: 'some' },
    { rule: 'MethodExpression', original: 'name.trim()', replacement: 'name' },
  ]);
});

test('superのメソッドは入れ替えるが、呼び出しを外してsuperだけを残す壊し方は作らない', () => {
  const found = edits(
    'src/list.ts',
    'export class List extends Array<number> {\n  all(f: (n: number) => boolean) {\n    return super.every(f) && super.slice().length > 0;\n  }\n}\n',
  );
  expect(found.filter(({ rule }) => rule === 'MethodExpression')).toEqual([
    { rule: 'MethodExpression', original: 'every', replacement: 'some' },
  ]);
});

test('呼び出しだけの文は;へ置き換え、constructorのsuper()の文は消さない', () => {
  const found = edits(
    'src/child.ts',
    `export class Child extends Base {
  constructor() {
    super();
    this.start();
  }
}
`,
  );
  expect(found.filter(({ rule }) => rule === 'CallExpression')).toEqual([
    { rule: 'CallExpression', original: 'this.start();', replacement: ';' },
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

test('ほかの関数の中を変えても、関数の中の壊し方の鍵を変えない', () => {
  const check = 'export function check(a: number) {\n  return a > 0 && a < 9;\n}\n';
  const keysOf = (other: string) =>
    mutants(oxc, 'src/check.ts', `${check}export function other(b: number) {\n${other}}\n`)
      .filter(({ key }) => key.startsWith('src/check.ts:check:'))
      .map(({ key }) => key);
  const before = keysOf('  return b > 1;\n');
  expect(before.length).toBeGreaterThan(0);
  expect(keysOf('  log(b);\n  return b === 1;\n')).toEqual(before);
});

function keysWithin(source: string, statement: string) {
  const start = source.indexOf(statement);
  expect(start).toBeGreaterThanOrEqual(0);
  return mutants(oxc, 'src/f.ts', source)
    .filter((mutant) => mutant.start >= start && mutant.end <= start + statement.length)
    .map(({ key }) => key);
}

function allKeys(source: string) {
  return mutants(oxc, 'src/f.ts', source).map(({ key }) => key);
}

const calls = 'export function f(a: number) {\n  foo(a > 0);\n  bar(a > 0);\n}\n';

test.each([
  ['2つの文を入れ替える', 'export function f(a: number) {\n  bar(a > 0);\n  foo(a > 0);\n}\n'],
  [
    '2つの文の前に文を足す',
    'export function f(a: number) {\n  log();\n  foo(a > 0);\n  bar(a > 0);\n}\n',
  ],
])(
  '関数の中で%sと、変える前の後ろの文の壊し方の鍵は、変えた後のどの壊し方の鍵とも一致しない',
  (_, changed) => {
    const before = keysWithin(calls, 'bar(a > 0);');
    expect(before.length).toBeGreaterThan(0);
    const after = new Set(allKeys(changed));
    expect(before.filter((key) => after.has(key))).toEqual([]);
  },
);

test('関数の中で、return falseの文が並ぶ前に文を足すと、足す前の2つ目のfalseの壊し方の鍵は、足した後のどの鍵とも一致しない', () => {
  const body = '  if (a) return false;\n  if (b) return false;\n  return true;\n}\n';
  const head = 'export function f(a: boolean, b: boolean) {\n';
  const source = `${head}${body}`;
  const second = source.indexOf('false', source.indexOf('if (b)'));
  const before = mutants(oxc, 'src/f.ts', source)
    .filter(({ start }) => start === second)
    .map(({ key }) => key);
  expect(before).toHaveLength(1);
  const after = new Set(allKeys(`${head}  log();\n${body}`));
  expect(before.filter((key) => after.has(key))).toEqual([]);
});

test('字の同じ名前の無いファイルの先頭の文が並ぶとき、前に文を足しても、2つ目の文の壊し方の鍵は2つ目の文を指す', () => {
  const source = 'init();\ninit();\n';
  const [, second] = mutants(oxc, 'src/main.ts', source);
  assert(second !== undefined);
  expect(second.start).toBe(source.lastIndexOf('init();'));
  const shifted = `setup();\n${source}`;
  const moved = mutants(oxc, 'src/main.ts', shifted).find(({ key }) => key === second.key);
  expect(moved?.start).toBe(shifted.lastIndexOf('init();'));
});

test('名前の無いファイルの先頭の文の前にimportの文を足しても、その文の壊し方の鍵を変えない', () => {
  const source = 'export default () => 1 > 0;\n';
  const keys = mutants(oxc, 'src/flag.ts', source).map(({ key }) => key);
  expect(keys.length).toBeGreaterThan(0);
  expect(
    mutants(oxc, 'src/flag.ts', `import './setup.ts';\n${source}`).map(({ key }) => key),
  ).toEqual(keys);
});

test('改行の字だけが違うCRLFとLFのソースからは、同じ鍵を作る', () => {
  const source = `export function ready(a: number, b: boolean) {
  const ok = a > 0 &&
    b;
  return ok || a === 1;
}
export const on = [1, 2].some(
  (n) => n > 1,
);
`;
  const keys = mutants(oxc, 'src/ready.ts', source).map(({ key }) => key);
  expect(keys.length).toBeGreaterThan(0);
  expect(
    mutants(oxc, 'src/ready.ts', source.replaceAll('\n', '\r\n')).map(({ key }) => key),
  ).toEqual(keys);
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

test('鍵のパスと関数の部分の:と%を%3Aと%25に置き換え、記録ファイルと--keyの鍵の確かめ方はその鍵を受け付けてモジュールのパスを返す', () => {
  const path = 'src/a%3A:b.ts';
  const [found] = mutants(
    oxc,
    path,
    "export const handlers = {\n  'user:100%': () => 1 > 0,\n};\n",
  );
  assert(found !== undefined);
  expect(found.key.startsWith('src/a%253A%3Ab.ts:handlers.user%3A100%25:')).toBe(true);
  // 一覧のpathは置き換えない字のままである。
  expect(found.path).toBe(path);
  expect(keyPath(found.key)).toBe(path);
  expect(keyModule(found.key)).toBe(path);
  expect(keyPath('src/rules.ts')).toBeUndefined();
});

test('名前に:を含む文字列で宣言したモジュールの中の壊し方にも、記録ファイルと--keyの鍵の確かめ方が受け付ける鍵を作る', () => {
  const path = 'src/virtual.d.ts';
  const found = mutants(
    oxc,
    path,
    'module "virtual:cfg" { export const debug: boolean; export const on = !debug; }\n',
  );
  expect(found.length).toBeGreaterThan(0);
  expect(found.map((mutant) => keyModule(mutant.key))).toEqual(found.map(() => path));
});

test.each([
  ['!!x', 'return !!x;', '(!x)'],
  ['!(!x)', 'return !(!x);', '(!x)'],
  ['!!!x', 'return !!!x;', '(!!x)'],
])('%sの真偽値の壊し方は、外側の!を外す1件だけである', (original, statement, replacement) => {
  const found = edits('src/twice.ts', `export function twice(x: boolean) {\n  ${statement}\n}\n`);
  expect(found.filter(({ rule }) => rule === 'BooleanLiteral')).toEqual([
    { rule: 'BooleanLiteral', original, replacement },
  ]);
});

test('名前と字の同じ2つの関数の中の壊し方は、2つ目の鍵に番号を付けて重ならない鍵を作る', () => {
  const found = mutants(
    oxc,
    'src/x.ts',
    'export const handlers = [\n  { run(x: number) { return x > 0; } },\n  { run(x: number) { return x > 0; } },\n];\n',
  );
  const first = found.filter(({ line }) => line === 2).map(({ key }) => key);
  expect(first.length).toBeGreaterThan(0);
  expect(found.filter(({ line }) => line === 3).map(({ key }) => key)).toEqual(
    first.map((key) => `${key}#2`),
  );
  expect(new Set(found.map(({ key }) => key)).size).toBe(found.length);
});

test.each([
  [
    'if',
    'if ((!(a < 1))) return 1;\n  return 2;',
    [
      { original: '(!(a < 1))', replacement: 'true' },
      { original: '(!(a < 1))', replacement: 'false' },
    ],
  ],
  [
    'while',
    'while (!(a < 1 && b)) a--;\n  return a;',
    [
      { original: '!(a < 1 && b)', replacement: 'false' },
      { original: 'a < 1', replacement: 'true' },
    ],
  ],
  [
    'do-while',
    'do a--; while (!(a < 1));\n  return a;',
    [{ original: '!(a < 1)', replacement: 'false' }],
  ],
  [
    'for',
    'for (; !(a < 1 || b); ) a--;\n  return a;',
    [
      { original: '!(a < 1 || b)', replacement: 'false' },
      { original: 'a < 1', replacement: 'false' },
    ],
  ],
  [
    '三項演算子',
    'return !(a < 1) ? 1 : 2;',
    [
      { original: '!(a < 1)', replacement: 'true' },
      { original: '!(a < 1)', replacement: 'false' },
    ],
  ],
  [
    'asで包んだwhile',
    'while (!((a < 1) as boolean)) a--;\n  return a;',
    [{ original: '!((a < 1) as boolean)', replacement: 'false' }],
  ],
])(
  '%sの条件が!(…)のとき、!の引数をtrueとfalseに置き換える壊し方を作らない',
  (_, body, expected) => {
    const found = edits(
      'src/negated.ts',
      `export function negated(a: number, b: boolean) {\n  ${body}\n}\n`,
    );
    expect(
      found
        .filter(({ rule }) => rule === 'ConditionalExpression')
        .map(({ original, replacement }) => ({ original, replacement })),
    ).toEqual(expected);
  },
);

test('!!xと条件の!(…)を含むソースからは、作らなくなる壊し方のほかは、元と同じ鍵の壊し方を同じ順で作る', () => {
  const source = `export function check(x: boolean, a: number, b: boolean) {
  while (!(a < 1 && b)) {
    a--;
  }
  return !!x || !(a > 2) ? 1 : 2;
}
export function flip(x: boolean) {
  if ((!(x === true))) {
    return !(!x);
  }
  return x;
}
`;
  expect(mutants(oxc, 'src/check.ts', source).map(({ key }) => key)).toEqual([
    'src/check.ts:check:body.body[0].test:BooleanLiteral:bb9f7cd456b8',
    'src/check.ts:check:body.body[0].test:ConditionalExpression:f150d831e69f',
    'src/check.ts:check:body.body[0].test.argument.expression:LogicalOperator:fb577d510e5d',
    'src/check.ts:check:body.body[0].test.argument.expression.left:ConditionalExpression:789e9e9fd59a',
    'src/check.ts:check:body.body[0].test.argument.expression.left:EqualityOperator:ca651c92a249',
    'src/check.ts:check:body.body[0].test.argument.expression.left:EqualityOperator:ad50cfca8f53',
    'src/check.ts:check:body.body[1].argument.test:ConditionalExpression:789e9e9fd59a',
    'src/check.ts:check:body.body[1].argument.test:ConditionalExpression:f150d831e69f',
    'src/check.ts:check:body.body[1].argument.test:LogicalOperator:b79c94f76d7f',
    'src/check.ts:check:body.body[1].argument.test.left:BooleanLiteral:510046ea94b5',
    'src/check.ts:check:body.body[1].argument.test.right:BooleanLiteral:95a77c8f4caa',
    'src/check.ts:check:body.body[1].argument.test.right.argument.expression:ConditionalExpression:789e9e9fd59a',
    'src/check.ts:check:body.body[1].argument.test.right.argument.expression:ConditionalExpression:f150d831e69f',
    'src/check.ts:check:body.body[1].argument.test.right.argument.expression:EqualityOperator:0b6197c0668d',
    'src/check.ts:check:body.body[1].argument.test.right.argument.expression:EqualityOperator:3143eabf6f46',
    'src/check.ts:flip:body.body[0].test:ConditionalExpression:28ff40b4355e',
    'src/check.ts:flip:body.body[0].test:ConditionalExpression:03343e0b3adc',
    'src/check.ts:flip:body.body[0].test.expression:BooleanLiteral:fd69a4232667',
    'src/check.ts:flip:body.body[0].test.expression.argument.expression:EqualityOperator:4f1110569c9c',
    'src/check.ts:flip:body.body[0].test.expression.argument.expression.right:BooleanLiteral:03343e0b3adc',
    'src/check.ts:flip:body.body[0].consequent.body[0].argument:BooleanLiteral:5d7c000b150e',
  ]);
});
