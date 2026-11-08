import { test, expect } from 'bun:test';
import { selectAffected } from '../../../test-runtime/affected.ts';

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

function selectedTests(selection: ReturnType<typeof selectAffected>): string[] {
  expect([...selection.reached.values()].every((files) => files.length > 0)).toBe(true);
  return [...new Set([...selection.unrecorded, ...[...selection.reached.values()].flat()])].sort();
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

test('どの記録にもない入力ファイルの変更は、届くテストファイルなしとして返す', () => {
  const orphan = abs('scripts/tests/fixtures/data.json');
  const selection = select({
    changed: [orphan],
    testFiles: [testA],
    records: records({ [testA]: [testA, moduleX] }),
  });
  expect(selection.reached).toEqual(new Map([[orphan, []]]));
  expect(selection.unrecorded).toEqual([]);
});

test('記録のないテストファイルがあっても、どの記録にもない入力ファイルの変更は届くテストファイルなしとして返す', () => {
  const orphan = abs('scripts/tests/fixtures/data.json');
  const selection = select({
    changed: [orphan],
    testFiles: [testA, testC],
    records: records({ [testA]: [testA, moduleX] }),
  });
  // testC は記録がないため常に選ぶ対象として返すが、data.json の到達先には数えない。
  expect(selection.reached).toEqual(new Map([[orphan, []]]));
  expect(selection.unrecorded).toEqual([testC]);
});
