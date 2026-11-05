import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export type Selection = { kind: 'tests'; tests: string[] } | { kind: 'all'; reasons: string[] };

export type SelectionInput = {
  root: string;
  changed: string[];
  testFiles: string[];
  records: Map<string, Set<string>>;
};

// 記録の有無によらず、変更すると全部実行にするファイルです（root からの相対パス）。
const fixedAllPaths = ['package.json', 'bun.lock', 'tsconfig.json'];

export function selectAffected(input: SelectionInput): Selection {
  const { root, changed, testFiles, records } = input;
  const fixed = new Set(fixedAllPaths.map((path) => `${root}/${path}`));
  const testSet = new Set(testFiles);
  // 記録のないテストファイルは何を読むか分からないため、常に選ぶ。
  const selected = new Set(testFiles.filter((file) => !records.has(file)));
  const reasons: string[] = [];

  for (const path of changed) {
    if (testSet.has(path)) {
      selected.add(path);
      continue;
    }
    const reached = fixed.has(path) ? [] : testFiles.filter((file) => records.get(file)?.has(path));
    // 固定一覧の変更と、どのテストにも届かない入力ファイルの変更は全部実行にする。
    if (reached.length === 0) {
      reasons.push(path);
    }
    for (const file of reached) {
      selected.add(file);
    }
  }

  if (reasons.length > 0) {
    return { kind: 'all', reasons };
  }
  return { kind: 'tests', tests: testFiles.filter((file) => selected.has(file)) };
}

export type ChangedFilesInput = {
  root: string;
  base: string;
};

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function nulSeparated(text: string): string[] {
  return text.split('\0').filter((path) => path !== '');
}

export function mergeBase(root: string, base: string): string {
  return git(root, ['merge-base', base, 'HEAD']).trim();
}

// base との分岐点以降の commit・未 commit の変更・未追跡ファイルを、root 配下の絶対パスで返す。
// --no-renames により rename は旧パスと新パスの両方を数える。
export function changedFiles({ root, base }: ChangedFilesInput): string[] {
  const comparison = mergeBase(root, base);
  // --relative と ls-files の既定出力は root からの相対パスで、root の外は含まない。
  const tracked = git(root, [
    'diff',
    '--name-only',
    '--no-renames',
    '--relative',
    '-z',
    comparison,
  ]);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])].map((path) =>
    join(root, path),
  );
}
