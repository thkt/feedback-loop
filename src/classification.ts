import assert from 'node:assert/strict';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isTestFile } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import type { Run } from './command.ts';
import { assertRepoRelativePath, assertStringArray, errorMessage } from './values.ts';

function filesUnder(root: string, prefix: string, excludeHidden: boolean): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (
      entry.name === '.git' ||
      entry.name === 'node_modules' ||
      (excludeHidden && entry.isDirectory() && entry.name.startsWith('.'))
    ) {
      return [];
    }
    return entry.isDirectory()
      ? filesUnder(root, `${path}/`, excludeHidden)
      : entry.isFile()
        ? [path]
        : [];
  });
}

// リンク先のないシンボリックリンクも、エントリがあるので実在として扱う。
function entryExists(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    // 途中が通常ファイルであるパスは、たどれないので実在しない。
    return false;
  }
}

// テストが数百件あるrepoでも食い違ったパスと向きを診断だけで読めるよう、両方にあるパスは出さない。
function mismatchDiagnostic(
  root: string,
  config: FeedbackConfig,
  collected: string[],
  globbed: string[],
) {
  const inCollected = new Set(collected);
  const inGlobbed = new Set(globbed);
  // testGlobsの側の集合は、探索で見つかる通常ファイルから作る。testGlobsに当たるパスでも、この集合に入らないものがある。
  const missing: string[] = [];
  const unmatched: string[] = [];
  const unlisted: string[] = [];
  for (const path of collected.filter((candidate) => !inGlobbed.has(candidate))) {
    if (!entryExists(join(root, path))) {
      missing.push(path);
    } else if (isTestFile(path, config)) {
      unlisted.push(path);
    } else {
      unmatched.push(path);
    }
  }
  const sides: { label: string; paths: string[]; guidance?: string }[] = [
    { label: '収集にあって実在しない', paths: missing },
    {
      label: '収集にあってtestGlobsに当たらない',
      paths: unmatched,
      // テストを足した人は設定を知らない。診断だけで直せるよう、直す場所と、globに当たるテストの扱いを示す。
      // fixtureのようにテストでないパスは、globを足すとqualityとして実行されるため、収集から外す側の直し方も示す。
      guidance:
        '直し方: 上のパスがテストなら、.feedback-loop.jsonのtestGlobsへ、そのパスに当たるglobを足してください。globに当たるテストは、同じファイルのassuranceへ登録しなければqualityになります。' +
        (config.collect === undefined
          ? 'テストでなければ、拡張子の前が.test・_test・.spec・_specにならない名前へ変えてください'
          : 'テストでなければ、収集用コマンドの出力から外してください'),
    },
    {
      label:
        '収集にあってtestGlobsに当たるが、探索で見つからない（シンボリックリンク、ディレクトリ、node_modules・.gitの下、表記の違いなど）',
      paths: unlisted,
    },
    {
      label: 'testGlobsに当たって収集にない',
      paths: globbed.filter((path) => !inCollected.has(path)),
    },
  ];
  return [
    '通常収集とtestGlobsの集合が一致しません',
    ...sides
      .filter(({ paths }) => paths.length > 0)
      .flatMap(({ label, paths, guidance }) => {
        const line = `${label}: ${JSON.stringify(paths.sort())}`;
        return guidance === undefined ? [line] : [line, guidance];
      }),
  ].join('\n');
}

// 診断に載せる標準出力の長さ。全体を載せると、診断を読むエージェントの文脈を埋める。
const shownOutput = 200;

// 標準出力の先頭を示す。長ければ末尾も示す。JSONの後ろに混ざった出力は、先頭だけでは見えないためである。
function outputEnds(stdout: string) {
  const head = `標準出力の先頭: ${JSON.stringify(stdout.slice(0, shownOutput))}`;
  return stdout.length > shownOutput
    ? `${head}。標準出力の末尾: ${JSON.stringify(stdout.slice(-shownOutput))}`
    : head;
}

// package manager経由で呼んだ収集用コマンドは、警告を標準出力へ出すことがある。
function parseCollected(stdout: string): string[] {
  let collected: unknown;
  try {
    collected = JSON.parse(stdout);
  } catch (error) {
    // 実行系の文は、標準出力の一部や制御文字を含むことがある。1行に収め、長さを抑える。
    const reason = errorMessage(error)
      .replaceAll(/\p{Cc}+/gu, ' ')
      .slice(0, shownOutput);
    assert.fail(
      `収集用コマンドの標準出力をJSONとして読めません。標準出力にはJSONの文字列配列だけを出し、診断は標準エラーへ出してください。理由: ${reason}。${outputEnds(stdout)}`,
    );
  }
  try {
    assertStringArray(collected);
  } catch {
    // 混ざった出力ではなく、配列の中身が原因である。
    assert.fail(
      `収集用コマンドの標準出力はJSONですが、空でない文字列だけの配列ではありません。${outputEnds(stdout)}`,
    );
  }
  return collected;
}

// テストファイルの一覧の作り方。collectの指定がなければ、探索で見つかるファイルを内蔵の規則で絞る。
type Collection = { kind: 'builtin' } | { kind: 'command'; command: string[] };

function builtinTests(files: string[]) {
  return files
    .filter(
      (path) =>
        !path.split('/').some((part) => part.startsWith('.')) &&
        /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(path),
    )
    .sort();
}

async function collectedTests(root: string, command: string[], run: Run) {
  const { stdout } = await run(command, { cwd: root, captureStdout: true });
  const collected = parseCollected(stdout);
  collected.forEach(assertRepoRelativePath);
  assert(new Set(collected).size === collected.length, '収集結果が重複しています');
  return collected;
}

export async function classification(root: string, config: FeedbackConfig, run: Run) {
  const collection: Collection =
    config.collect === undefined
      ? { kind: 'builtin' }
      : { kind: 'command', command: config.collect };
  const prefixes = config.testGlobs.map((glob) => {
    const fixed = glob.split(/[*?]/, 1)[0] ?? '';
    return fixed.slice(0, fixed.lastIndexOf('/') + 1);
  });
  const roots = [...new Set(prefixes)].filter(
    (prefix, _, all) => !all.some((parent) => parent !== prefix && prefix.startsWith(parent)),
  );
  const files = roots
    .filter(
      (prefix) =>
        !prefix
          .split('/')
          .some(
            (part) =>
              part === '.git' ||
              part === 'node_modules' ||
              (collection.kind === 'builtin' && part.startsWith('.')),
          ),
    )
    .filter((prefix) => {
      const found = statSync(join(root, prefix), { throwIfNoEntry: false })?.isDirectory() ?? false;
      // 内蔵の一覧は探索場所だけが根拠なので、欠けた場所を0件として通さない。collect指定では収集結果との差で検出する。
      assert(found || collection.kind === 'command', `testGlobsの探索場所がありません: ${prefix}`);
      return found;
    })
    .flatMap((prefix) => filesUnder(root, prefix, collection.kind === 'builtin'));
  const expected = files.filter((path) => isTestFile(path, config)).sort();
  const actual =
    collection.kind === 'builtin'
      ? builtinTests(files)
      : await collectedTests(root, collection.command, run);
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected)) {
    assert.fail(mismatchDiagnostic(root, config, actual, expected));
  }
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert(assurance.size === config.assurance.length, 'assurance指定が重複しています');
  assert(
    [...assurance].every((path) => expected.includes(path)),
    'assuranceに存在しないテストか集合外の指定があります',
  );
  assert(
    config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))),
    '依存対応に集合外のテストがあります',
  );
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance],
  };
}
