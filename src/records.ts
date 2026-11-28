import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, hasErrorCode, isRecord, sha256 } from './values.ts';
import type { AffectedChanges } from './changes.ts';
import { gitOutput } from './git.ts';
import { lockfileNames } from './lockfiles.ts';

type LoadedRecords =
  | { kind: 'usable'; records: Map<string, Set<string>>; stale: number }
  // reasonは、全qualityを実行する理由として表示する文である。
  | { kind: 'unusable'; reason: string };

type RecordUpdates = {
  ran: Map<string, Set<string>>;
  failed: string[];
};

type Snapshot = { basis: string; comparison: string; changed: Record<string, string | null> };
type Entry = { snapshot: string; files: Record<string, string> };
type DependencyRecords =
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'invalid' }
  | { kind: 'outdated' }
  | { kind: 'valid'; snapshots: Map<string, Snapshot>; entries: Map<string, Entry> };

type CurrentChanges = Pick<
  AffectedChanges,
  'comparison' | 'changed' | 'outside' | 'ancestorLockfiles'
>;

const recordsDirectoryName = '.feedback-loop-records';
const recordsVersion = 3;

function recordsPath(root: string): string {
  return join(root, recordsDirectoryName, 'records.json');
}

/**
 * 実行部が作業ツリーに置くファイルの置き場を作り、そのパスを返す。
 * Codexの既定サンドボックスではGitのディレクトリへ書けないため、worktreeの下に置き、中身をGitの追跡から外す。
 */
export function recordsDirectory(root: string): string {
  const directory = join(root, recordsDirectoryName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.gitignore'), '*\n');
  return directory;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const strings: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      return undefined;
    }
    strings[key] = item;
  }
  return strings;
}

function snapshotFrom(value: unknown): Snapshot | undefined {
  if (
    !isRecord(value) ||
    typeof value.basis !== 'string' ||
    typeof value.comparison !== 'string' ||
    !isRecord(value.changed)
  ) {
    return undefined;
  }
  const changed: Record<string, string | null> = {};
  for (const [path, hash] of Object.entries(value.changed)) {
    if (typeof hash !== 'string' && hash !== null) {
      return undefined;
    }
    changed[path] = hash;
  }
  return { basis: value.basis, comparison: value.comparison, changed };
}

function entryFrom(value: unknown, snapshots: Map<string, Snapshot>): Entry | undefined {
  if (!isRecord(value) || typeof value.snapshot !== 'string' || !snapshots.has(value.snapshot)) {
    return undefined;
  }
  const files = stringRecord(value.files);
  return files === undefined ? undefined : { snapshot: value.snapshot, files };
}

function recordsFrom(parsed: unknown): DependencyRecords {
  if (isRecord(parsed) && parsed.version === 2) {
    return { kind: 'outdated' };
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== recordsVersion ||
    !isRecord(parsed.snapshots) ||
    !isRecord(parsed.tests)
  ) {
    return { kind: 'invalid' };
  }
  const snapshots = new Map<string, Snapshot>();
  for (const [id, value] of Object.entries(parsed.snapshots)) {
    const snapshot = snapshotFrom(value);
    if (snapshot === undefined) {
      return { kind: 'invalid' };
    }
    snapshots.set(id, snapshot);
  }
  const entries = new Map<string, Entry>();
  for (const [file, value] of Object.entries(parsed.tests)) {
    const entry = entryFrom(value, snapshots);
    if (entry === undefined) {
      return { kind: 'invalid' };
    }
    entries.set(file, entry);
  }
  return { kind: 'valid', snapshots, entries };
}

function readDependencyRecords(path: string): DependencyRecords {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'unreadable', error };
  }
  try {
    return recordsFrom(JSON.parse(text));
  } catch {
    return { kind: 'invalid' };
  }
}

export function openRecords(root: string, current: CurrentChanges, testFiles: string[]) {
  const path = recordsPath(root);
  const loaded = readDependencyRecords(path);
  const digests = new Map<string, string>();
  const hash = (file: string) => digest(root, file, digests);
  // 実行前に求めた状態とhashを保存にも使う。実行中に変わった入力は、次回に古い記録として選び直される。
  const snapshot = currentSnapshot(root, current, hash);
  const snapshotId = sha256(JSON.stringify(snapshot));
  const records: LoadedRecords =
    loaded.kind === 'valid'
      ? validatedRecords(root, loaded, current, testFiles, hash, snapshot.basis)
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
          snapshot: snapshotId,
          files: Object.fromEntries([...modules].sort().map((module) => [module, hash(module)])),
        });
      }
      for (const file of failed) {
        entries.delete(file);
      }
      const snapshots = new Map(loaded.kind === 'valid' ? loaded.snapshots : []);
      snapshots.set(snapshotId, snapshot);
      writeRecords(root, snapshots, entries);
    },
  };
}

const noRecords = '依存記録がありません';
const staleRecords = '依存記録が古いため採用しません';

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
    case 'outdated':
      return '依存記録の形が古いため採用しません';
    default:
      // kindに種類が増えたら、ここで型エラーになる。
      return loaded satisfies never;
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

function readableHash(hash: (file: string) => string, path: string): string | null {
  try {
    return hash(path);
  } catch {
    return null;
  }
}

function currentSnapshot(
  root: string,
  { comparison, changed, outside, ancestorLockfiles }: CurrentChanges,
  hash: (file: string) => string,
): Snapshot {
  return {
    basis: sourceBasis(hash, ancestorLockfiles),
    comparison,
    changed: Object.fromEntries(
      [...new Set([...changed, ...outside])].sort().map((path) => [path, readableHash(hash, path)]),
    ),
  };
}

function sourceBasis(hash: (file: string) => string, ancestorLockfiles: string[]): string {
  return JSON.stringify([
    process.version,
    process.versions.bun,
    // 導入先ではimport.meta.urlが同梱のruntime.mjsを指し、実行部の変更はそのhashに現れる。記録器だけが別ファイルである。
    ...[
      fileURLToPath(import.meta.url),
      join(dirname(fileURLToPath(import.meta.url)), 'record-modules.ts'),
    ].map(hash),
    ...['.feedback-loop.json', 'bunfig.toml', 'package.json', ...lockfileNames].map(hash),
    // rootにlockfileがない構成で使う、祖先のlockfile。なければ基点は変わらない。
    ...ancestorLockfiles.map(hash),
  ]);
}

function committedChanges(root: string, from: string, to: string): string[] | undefined {
  if (from === to) {
    return [];
  }
  const prefix = gitOutput(root, ['rev-parse', '--show-prefix']);
  const diff = spawnSync(
    'git',
    ['diff', '--name-only', '--no-renames', '--no-relative', '-z', from, to],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (prefix === undefined || diff.status !== 0) {
    return undefined;
  }
  return diff.stdout
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => posix.relative(prefix, path));
}

function unchangedOutsideDiff(
  root: string,
  snapshot: Snapshot,
  current: CurrentChanges,
  hash: (file: string) => string,
): boolean {
  const committed = committedChanges(root, snapshot.comparison, current.comparison);
  if (committed === undefined) {
    return false;
  }
  const accounted = new Set([...current.changed, ...current.outside]);
  const candidates = new Set([...Object.keys(snapshot.changed), ...committed]);
  return [...candidates]
    .filter((path) => !accounted.has(path))
    .every((path) => {
      const recorded = snapshot.changed[path];
      return recorded !== undefined && recorded !== null && readableHash(hash, path) === recorded;
    });
}

function validatedRecords(
  root: string,
  { snapshots, entries }: Extract<DependencyRecords, { kind: 'valid' }>,
  current: CurrentChanges,
  testFiles: string[],
  hash: (file: string) => string,
  basis: string,
): LoadedRecords {
  try {
    const accounted = new Set(current.changed);
    const currentTests = new Set(testFiles);
    // 対象外の記録の古い基点で、現行qualityの記録を捨てません。
    const relevant = [...entries].filter(([file]) => currentTests.has(file));
    const verdicts = new Map<string, boolean>();
    const snapshotFresh = (id: string) => {
      let fresh = verdicts.get(id);
      if (fresh === undefined) {
        const snapshot = snapshots.get(id);
        fresh =
          snapshot !== undefined &&
          snapshot.basis === basis &&
          unchangedOutsideDiff(root, snapshot, current, hash);
        verdicts.set(id, fresh);
      }
      return fresh;
    };
    const valid = new Map(
      relevant
        .filter(
          ([, entry]) =>
            snapshotFresh(entry.snapshot) &&
            Object.entries(entry.files).every(
              ([module, recorded]) => accounted.has(module) || recorded === hash(module),
            ),
        )
        .map(([file, entry]) => [file, new Set(Object.keys(entry.files))]),
    );
    const stale = relevant.length - valid.size;
    if (valid.size > 0) {
      return { kind: 'usable', records: valid, stale };
    }
    return { kind: 'unusable', reason: stale > 0 ? staleRecords : noRecords };
  } catch (error) {
    return { kind: 'unusable', reason: `依存記録の入力を確認できません: ${String(error)}` };
  }
}

/** 一時ファイルへ書いてから置き換える。書く途中で止まっても、pathに書きかけの内容を残さない。 */
function writeAtomically(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function writeRecords(
  root: string,
  snapshots: Map<string, Snapshot>,
  entries: Map<string, Entry>,
): void {
  const referenced = new Set([...entries.values()].map((entry) => entry.snapshot));
  const kept = [...snapshots].filter(([id]) => referenced.has(id));
  const content = {
    version: recordsVersion,
    snapshots: Object.fromEntries(kept),
    tests: Object.fromEntries(entries),
  };
  writeAtomically(
    join(recordsDirectory(root), 'records.json'),
    `${JSON.stringify(content, null, 2)}\n`,
  );
}
