import assert from 'node:assert/strict';
import { repoPath } from './config.ts';

function elements(node: Bun.XML.Node, name: string): Bun.XML.Node[] {
  return node.children.filter(
    (child): child is Bun.XML.Node =>
      typeof child !== 'string' && 'name' in child && child.name === name,
  );
}

// Bunはdescribeごとに入れ子のtestsuiteを出し、中のテストをその下に置きます。
function testcases(node: Bun.XML.Node): Bun.XML.Node[] {
  return [...elements(node, 'testcase'), ...elements(node, 'testsuite').flatMap(testcases)];
}

/** JUnitの件数の属性を読む。欠けているか、数字でなければ投げる。 */
function junitCount(node: Bun.XML.Node, name: string, fallback?: string): number {
  const value = node.attributes[name] ?? fallback;
  assert(value !== undefined && /^\d+$/.test(value), `JUnitの${name}が不正です`);
  const result = Number(value);
  assert(Number.isSafeInteger(result), `JUnitの${name}が不正です`);
  return result;
}

function counts(node: Bun.XML.Node, allowSkipped: boolean) {
  const tests = junitCount(node, 'tests');
  const skipped = junitCount(node, 'skipped');
  assert(tests > 0 && skipped <= tests, 'JUnitの完了件数が不正または0件です');
  assert(allowSkipped || skipped === 0, '許可されていないskipがあります');
  assert(
    junitCount(node, 'failures') === 0 && junitCount(node, 'errors', '0') === 0,
    'JUnitに失敗が記録されています',
  );
  return { tests, skipped };
}

export function readBunSuites(text: string, root: string) {
  const report = Bun.XML.parse(text, { compact: false });
  assert(report.name === 'testsuites', 'Bun JUnitのrootがありません');
  const suites = new Map<string, Bun.XML.Node>();
  for (const suite of elements(report, 'testsuite')) {
    const file = suite.attributes.file;
    assert(file && file.trim(), 'JUnitのテストファイルがありません');
    const owner = repoPath(root, file);
    assert(!suites.has(owner), `JUnitのファイルが重複しています: ${file}`);
    suites.set(owner, suite);
  }
  return { report, suites };
}

export type BunFileResult = {
  tests: number;
  passed: number;
  skipped: number;
  failed: boolean;
  failedCases: number;
};

function fileResults(
  report: Bun.XML.Node,
  suites: Map<string, Bun.XML.Node>,
  root: string,
  candidates: Set<string>,
) {
  const results = new Map<string, BunFileResult>();
  let tests = 0;
  let skipped = 0;
  for (const [owner, suite] of suites) {
    const file = suite.attributes.file;
    assert(candidates.has(owner), `JUnitに候補外のファイルがあります: ${file}`);
    const suiteTests = junitCount(suite, 'tests');
    const suiteSkipped = junitCount(suite, 'skipped');
    const cases = testcases(suite);
    assert(cases.length === suiteTests, `JUnitのファイル別件数が一致しません: ${file}`);
    let skippedCases = 0;
    let failedCases = 0;
    for (const item of cases) {
      assert(
        item.attributes.file && repoPath(root, item.attributes.file) === owner,
        `JUnitのtestcaseのファイルが一致しません: ${file}`,
      );
      if (elements(item, 'failure').length > 0 || elements(item, 'error').length > 0) {
        failedCases++;
      } else if (elements(item, 'skipped').length > 0) {
        skippedCases++;
      }
    }
    assert(skippedCases === suiteSkipped, `JUnitのskip件数が一致しません: ${file}`);
    tests += suiteTests;
    skipped += suiteSkipped;
    results.set(owner, {
      tests: suiteTests,
      passed: suiteTests - suiteSkipped - failedCases,
      skipped: suiteSkipped,
      failedCases,
      failed:
        failedCases > 0 ||
        junitCount(suite, 'failures') > 0 ||
        junitCount(suite, 'errors', '0') > 0,
    });
  }
  assert(
    tests === junitCount(report, 'tests') && skipped === junitCount(report, 'skipped'),
    'JUnitのファイル別件数と全体件数が一致しません',
  );
  return results;
}

export function readBunFileResults(text: string, root: string, candidates: Set<string>) {
  const { report, suites } = readBunSuites(text, root);
  return fileResults(report, suites, root, candidates);
}

// Bunの分岐でだけ呼びます。Node/Vitestの実行にはBunやXML依存を要求しません。
export function readBunReport(
  text: string,
  root: string,
  candidates: Set<string>,
  allowSkipped: boolean,
): Map<string, number> {
  const { report, suites } = readBunSuites(text, root);
  counts(report, allowSkipped);
  const completed = new Map<string, number>();
  for (const [owner, result] of fileResults(report, suites, root, candidates)) {
    assert(
      result.tests > 0 && result.skipped <= result.tests,
      'JUnitの完了件数が不正または0件です',
    );
    assert(allowSkipped || result.skipped === 0, '許可されていないskipがあります');
    assert(result.failedCases === 0, `JUnitのtestcaseが失敗しています: ${owner}`);
    assert(!result.failed, 'JUnitに失敗が記録されています');
    completed.set(owner, result.passed);
  }
  return completed;
}
