import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export type SelectionInput = {
  changed: string[];
  testFiles: string[];
  records: Map<string, Set<string>>;
};

export function selectAffected({ changed, testFiles, records }: SelectionInput) {
  return {
    reached: new Map(
      changed.map((path) => [
        path,
        testFiles.includes(path)
          ? [path]
          : testFiles.filter((file) => records.get(file)?.has(path)),
      ]),
    ),
    // 記録のないテストファイルは何を読むか分からないため、常に選ぶ。
    unrecorded: testFiles.filter((file) => !records.has(file)),
  };
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
