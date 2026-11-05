import { test, expect } from 'bun:test';
import { selectAffected, type Selection } from '../../../test-runtime/affected.ts';

const root = '/repo';
const abs = (path: string) => `${root}/${path}`;

const testA = abs('scripts/a.test.ts');
const testB = abs('scripts/b.test.ts');
const testC = abs('scripts/c.test.ts');
const moduleX = abs('scripts/x.ts');
const moduleY = abs('scripts/y.ts');

function records(entries: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(entries).map(([owner, modules]) => [owner, new Set(modules)]));
}

const select = selectAffected;

function selectedTests(selection: Selection): string[] {
  expect(selection.kind).toBe('tests');
  return selection.kind === 'tests' ? [...selection.tests].sort() : [];
}

test('変更したモジュールを記録に持つテストファイルだけを選ぶ', () => {
  const selection = select({
    changed: [moduleX],
    testFiles: [testA, testB],
    records: records({ [testA]: [testA, moduleX], [testB]: [testB, moduleY] }),
  });
  expect(selectedTests(selection)).toEqual([testA]);
});

test('記録のないテストファイルと変更されたテストファイルは必ず選ぶ', () => {
  const selection = select({
    changed: [moduleX, testB],
    testFiles: [testA, testB, testC],
    records: records({ [testA]: [testA, moduleY], [testB]: [testB, moduleX] }),
  });
  // testA は x.ts を読まない。testB は自身が変更された。testC は記録がない。
  expect(selectedTests(selection)).toEqual([testB, testC]);
});

test('どの記録にもない入力ファイルの変更は、全テストを選んで理由のファイルを示す', () => {
  const orphan = abs('scripts/tests/fixtures/data.json');
  const selection = select({
    changed: [orphan],
    testFiles: [testA],
    records: records({ [testA]: [testA, moduleX] }),
  });
  expect(selection).toEqual({ kind: 'all', reasons: [orphan] });
});

test('記録のないテストファイルがあっても、どのテストにも届かない入力ファイルの変更は全テストを選ぶ', () => {
  const orphan = abs('scripts/tests/fixtures/data.json');
  const selection = select({
    changed: [orphan],
    testFiles: [testA, testC],
    records: records({ [testA]: [testA, moduleX] }),
  });
  // testC は記録がないが、data.json を読むかは分からないため、全部実行にする。
  expect(selection).toEqual({ kind: 'all', reasons: [orphan] });
});
