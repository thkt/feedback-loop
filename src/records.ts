import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, hasErrorCode, isRecord, sha256 } from './values.ts';

type LoadedRecords =
  | { kind: 'usable'; records: Map<string, Set<string>> }
  // reasonは、全qualityを実行する理由として表示する文である。
  | { kind: 'unusable'; reason: string };

type RecordUpdates = {
  ran: Map<string, Set<string>>;
  failed: string[];
};

type Entry = { basis: string; files: Record<string, string> };
type DependencyRecords =
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'invalid' }
  | { kind: 'valid'; entries: Map<string, Entry> };

function recordsPath(root: string): string {
  return join(root, '.feedback-loop-records', 'records.json');
}

function readDependencyRecords(path: string): DependencyRecords {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'unreadable', error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.tests)) {
    return { kind: 'invalid' };
  }
  const entries = new Map<string, Entry>();
  for (const [file, value] of Object.entries(parsed.tests)) {
    if (!isRecord(value) || typeof value.basis !== 'string' || !isRecord(value.files)) {
      return { kind: 'invalid' };
    }
    const files: Record<string, string> = {};
    for (const [module, hash] of Object.entries(value.files)) {
      if (typeof hash !== 'string') {
        return { kind: 'invalid' };
      }
      files[module] = hash;
    }
    entries.set(file, { basis: value.basis, files });
  }
  return { kind: 'valid', entries };
}

export function openRecords(
  root: string,
  changed: string[],
  testFiles: string[],
  ancestorLockfiles: string[],
) {
  const path = recordsPath(root);
  const loaded = readDependencyRecords(path);
  const digests = new Map<string, string>();
  const hash = (file: string) => digest(root, file, digests);
  // 実行前に求めた基点とhashを保存にも使う。実行中に変わった入力は、次回に古い記録として全件へ広がる。
  const basis = sourceBasis(root, hash, ancestorLockfiles);
  const records: LoadedRecords =
    loaded.kind === 'valid'
      ? validatedRecords(loaded.entries, changed, testFiles, hash, basis)
      : { kind: 'unusable', reason: unusableReason(path, loaded) };
  return {
    records,
    save: ({ ran, failed }: RecordUpdates): void => {
      if (loaded.kind === 'unreadable') {
        throw loaded.error;
      }
      const entries = loaded.kind === 'valid' ? loaded.entries : new Map<string, Entry>();
      for (const [file, modules] of ran) {
        entries.set(file, {
          basis,
          files: Object.fromEntries([...modules].sort().map((module) => [module, hash(module)])),
        });
      }
      for (const file of failed) {
        entries.delete(file);
      }
      writeRecords(path, entries);
    },
  };
}

const noRecords = '依存記録がありません';

function unusableReason(
  path: string,
  loaded: Exclude<DependencyRecords, { kind: 'valid' }>,
): string {
  switch (loaded.kind) {
    case 'missing':
      return noRecords;
    case 'unreadable':
      return `${path} を読めないため、記録なしとして扱います: ${errorMessage(loaded.error)}`;
    case 'invalid':
      return `${path} の形が不正なため、記録なしとして扱います`;
  }
}

function digest(root: string, path: string, digests: Map<string, string>): string {
  const cached = digests.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const absolute = resolve(root, path);
  const hash = existsSync(absolute) ? sha256(readFileSync(absolute)) : 'missing';
  digests.set(path, hash);
  return hash;
}

function sourceBasis(
  root: string,
  hash: (file: string) => string,
  ancestorLockfiles: string[],
): string {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0) {
    throw new Error(`記録の基点を取得できません: ${head.stderr}`);
  }
  return JSON.stringify([
    head.stdout.trim(),
    process.version,
    process.versions.bun,
    // 導入先ではimport.meta.urlが同梱のruntime.mjsを指し、実行部の変更はそのhashに現れる。記録器だけが別ファイルである。
    ...[
      fileURLToPath(import.meta.url),
      join(dirname(fileURLToPath(import.meta.url)), 'record-modules.ts'),
    ].map(hash),
    ...[
      '.feedback-loop.json',
      'bunfig.toml',
      'package.json',
      'bun.lock',
      'package-lock.json',
      'pnpm-lock.yaml',
    ].map(hash),
    // rootにlockfileがない構成で使う、祖先のlockfile。なければ基点は変わらない。
    ...ancestorLockfiles.map(hash),
  ]);
}

function validatedRecords(
  entries: Map<string, Entry>,
  changed: string[],
  testFiles: string[],
  hash: (file: string) => string,
  basis: string,
): LoadedRecords {
  try {
    const accounted = new Set(changed);
    const current = new Set(testFiles);
    // 対象外の記録の古い基点で、現行quality全体を無効にしません。
    const relevant = [...entries].filter(([file]) => current.has(file));
    const valid = new Map(
      relevant
        .filter(
          ([, entry]) =>
            entry.basis === basis &&
            Object.entries(entry.files).every(
              ([module, recorded]) => accounted.has(module) || recorded === hash(module),
            ),
        )
        .map(([file, entry]) => [file, new Set(Object.keys(entry.files))]),
    );
    if (valid.size !== relevant.length) {
      return { kind: 'unusable', reason: '依存記録が古いため採用しません' };
    }
    // 現行のqualityの記録が1件もなければ、古くはないが使える記録がない。
    return valid.size > 0
      ? { kind: 'usable', records: valid }
      : { kind: 'unusable', reason: noRecords };
  } catch (error) {
    return { kind: 'unusable', reason: `依存記録の入力を確認できません: ${String(error)}` };
  }
}

function writeRecords(path: string, entries: Map<string, Entry>): void {
  // Codexの既定サンドボックスではGitのディレクトリへ書けないため、worktreeの下に置きます。
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.gitignore'), '*\n');
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temp,
      `${JSON.stringify({ version: 2, tests: Object.fromEntries(entries) }, null, 2)}\n`,
    );
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
