import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, hasErrorCode, isRecord, sha256 } from '../shared/values.ts';

export type LoadedRecords = {
  records: Map<string, Set<string>>;
  warning: string | undefined;
};

export type SaveInput = {
  root: string;
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
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.tests)) {
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

export function loadRecords(root: string, changed: string[], testFiles: string[]): LoadedRecords {
  const path = recordsPath(root);
  const loaded = readDependencyRecords(path);
  switch (loaded.kind) {
    case 'missing':
      return { records: new Map(), warning: undefined };
    case 'unreadable':
      return {
        records: new Map(),
        warning: `${path} を読めないため、記録なしとして扱います: ${errorMessage(loaded.error)}`,
      };
    case 'invalid':
      return { records: new Map(), warning: `${path} の形が不正なため、記録なしとして扱います` };
    case 'valid':
      return validatedRecords(root, loaded.entries, changed, testFiles);
  }
}

function digest(path: string, digests: Map<string, string>): string {
  const cached = digests.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const hash = existsSync(path) ? sha256(readFileSync(path)) : 'missing';
  digests.set(path, hash);
  return hash;
}

function sourceBasis(root: string, digests: Map<string, string>): string {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0) {
    throw new Error(`記録の基点を取得できません: ${head.stderr}`);
  }
  return JSON.stringify([
    head.stdout.trim(),
    process.version,
    process.versions.bun,
    // 導入先ではimport.meta.urlが同梱のruntime.mjsを指す。affected-records.tsとaffected.tsはruntime.mjsに含まれて隣にないため'missing'になり、その変更はruntime.mjsのhashに現れる。
    // 正本を直接読み込むテストでは自身がこの一覧と重なるため、Setで重複を除く。
    ...[
      ...new Set([
        fileURLToPath(import.meta.url),
        ...['affected-records.ts', 'affected.ts', 'record-modules.ts'].map((name) =>
          join(dirname(fileURLToPath(import.meta.url)), name),
        ),
      ]),
    ].map((path) => digest(path, digests)),
    ...[
      '.feedback-loop.json',
      'bunfig.toml',
      'package.json',
      'bun.lock',
      'bun.lockb',
      'package-lock.json',
    ].map((name) => digest(join(root, name), digests)),
  ]);
}

function validatedRecords(
  root: string,
  entries: Map<string, Entry>,
  changed: string[],
  testFiles: string[],
): LoadedRecords {
  try {
    const digests = new Map<string, string>();
    const basis = sourceBasis(root, digests);
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
              ([module, hash]) => accounted.has(module) || hash === digest(module, digests),
            ),
        )
        .map(([file, entry]) => [file, new Set(Object.keys(entry.files))]),
    );
    return valid.size === relevant.length
      ? { records: valid, warning: undefined }
      : { records: new Map(), warning: '古い、または基点不明の依存記録は採用せず全件へ広げます' };
  } catch (error) {
    return { records: new Map(), warning: `依存記録の基点を確認できません: ${String(error)}` };
  }
}

export function saveRecords({ root, ran, failed }: SaveInput): void {
  const path = recordsPath(root);
  const loaded = readDependencyRecords(path);
  if (loaded.kind === 'unreadable') {
    throw loaded.error;
  }
  const entries = loaded.kind === 'valid' ? loaded.entries : new Map<string, Entry>();
  const digests = new Map<string, string>();
  const basis = sourceBasis(root, digests);
  for (const [file, modules] of ran) {
    entries.set(file, {
      basis,
      files: Object.fromEntries(
        [...modules].sort().map((module) => [module, digest(module, digests)]),
      ),
    });
  }
  for (const file of failed) {
    entries.delete(file);
  }
  // Codexの既定サンドボックスではGitのディレクトリへ書けないため、worktreeの下に置きます。
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.gitignore'), '*\n');
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temp,
      `${JSON.stringify({ version: 1, tests: Object.fromEntries(entries) }, null, 2)}\n`,
    );
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
