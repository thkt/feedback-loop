import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../shared/values.ts';

// 実行したテストファイルの記録を、worktree の下に保存します。
// Codex の既定のサンドボックスは Git のディレクトリを読取り専用にするため、そこには置きません。
// 形は { "<テストファイルの絶対パス>": ["<読み込んだモジュールの絶対パス>", ...] } です。

export type LoadedRecords = {
  records: Map<string, Set<string>>;
  warning: string | undefined;
};

export type SaveInput = {
  root: string;
  // 今回実行したテストファイルと、そのファイルが読み込んだモジュールです。
  ran: Map<string, Set<string>>;
  // 今回実行して失敗したテストファイルです。
  failed: string[];
  // 今回の開始時に、前回の未完了を示すファイルが残っていた場合に指定します。
  interrupted?: boolean;
};

export function recordsPath(root: string): string {
  return join(root, '.feedback-loop-records', 'test-deps.json');
}

/** 保存先を作る。中の.gitignoreが自身を含む全ファイルを除くので、対象repoの.gitignoreを変更しない。 */
export function ensureRecordsDir(root: string): void {
  const directory = dirname(recordsPath(root));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.gitignore'), '*\n');
}

function parseRecords(text: string): Map<string, Set<string>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const records = new Map<string, Set<string>>();
  for (const [file, modules] of Object.entries(parsed)) {
    if (!Array.isArray(modules) || !modules.every((m) => typeof m === 'string')) {
      return undefined;
    }
    records.set(file, new Set(modules));
  }
  return records;
}

export function loadRecords(root: string, changed: string[], testFiles: string[]): LoadedRecords {
  const path = recordsPath(root);
  const { records, warning, original } = readRecords(path);
  if (warning !== undefined || original === undefined) {
    return { records, warning };
  }
  if (existsSync(`${path}.pending`)) {
    return { records: new Map(), warning: '前回の実行が未完了のため全件へ広げます' };
  }
  return validatedRecords(root, path, records, changed, testFiles);
}

function readRecords(path: string): LoadedRecords & { original?: Buffer; readError?: unknown } {
  let original: Buffer;
  try {
    original = readFileSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { records: new Map(), warning: undefined };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      records: new Map(),
      warning: `${path} を読めないため、記録なしとして扱います: ${reason}`,
      readError: error,
    };
  }
  const records = parseRecords(original.toString('utf8'));
  if (records === undefined) {
    return {
      records: new Map(),
      warning: `${path} の形が不正なため、記録なしとして扱います`,
      original,
    };
  }
  return { records, warning: undefined, original };
}

function digest(path: string, digests: Map<string, string>): string {
  const cached = digests.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const hash = existsSync(path)
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : 'missing';
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

type Provenance = { basis: string; files: Record<string, string> };

function readProvenance(recordsFile: string): Map<string, Provenance> {
  const path = `${recordsFile}.basis.json`;
  if (!existsSync(path)) {
    return new Map();
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`記録の基点が不正です: ${path}`);
  }
  const result = new Map<string, Provenance>();
  for (const [file, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.basis !== 'string' || !isRecord(value.files)) {
      throw new Error(`記録の基点が不正です: ${path}`);
    }
    const files: Record<string, string> = {};
    for (const [module, hash] of Object.entries(value.files)) {
      if (typeof hash !== 'string') {
        throw new Error(`記録のhashが不正です: ${path}`);
      }
      files[module] = hash;
    }
    result.set(file, { basis: value.basis, files });
  }
  return result;
}

function validatedRecords(
  root: string,
  path: string,
  records: Map<string, Set<string>>,
  changed: string[],
  testFiles: string[],
): LoadedRecords {
  try {
    const provenance = readProvenance(path);
    const digests = new Map<string, string>();
    const basis = sourceBasis(root, digests);
    const accounted = new Set(changed);
    const current = new Set(testFiles);
    // 対象外の原記録は保存したまま、現行の候補に使う記録だけを照合します。
    const relevant = [...records].filter(([file]) => current.has(file));
    const valid = new Map(
      relevant.filter(([file, modules]) => {
        const entry = provenance.get(file);
        return (
          entry?.basis === basis &&
          [...modules].every(
            (module) => accounted.has(module) || entry.files[module] === digest(module, digests),
          )
        );
      }),
    );
    return valid.size === relevant.length
      ? { records: valid, warning: undefined }
      : { records: new Map(), warning: '古い、または基点不明の依存記録は採用せず全件へ広げます' };
  } catch (error) {
    return { records: new Map(), warning: `依存記録の基点を確認できません: ${String(error)}` };
  }
}

export function saveRecords({ root, ran, failed, interrupted = false }: SaveInput): void {
  const path = recordsPath(root);
  const { records, original, readError } = readRecords(path);
  // 失敗した場合と未完了の実行を挟んだ場合に、置換前の原記録を内容別に保持します。
  if (failed.length > 0 || interrupted) {
    if (readError !== undefined) {
      throw readError;
    }
    if (original !== undefined) {
      const hash = createHash('sha256').update(original).digest('hex');
      writeFileSync(`${path}.${hash}.previous`, original);
    }
  }
  for (const [file, modules] of ran) {
    records.set(file, modules);
  }
  for (const file of failed) {
    records.delete(file);
  }
  const body = Object.fromEntries(
    [...records].map(([file, modules]) => [file, [...modules].sort()]),
  );
  ensureRecordsDir(root);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  let provenance = new Map<string, Provenance>();
  try {
    provenance = readProvenance(path);
  } catch {
    // 不正な基点は再採用せず、今回成功した記録だけに基点を付けます。
  }
  const digests = new Map<string, string>();
  const basis = sourceBasis(root, digests);
  for (const [file, modules] of ran) {
    provenance.set(file, {
      basis,
      files: Object.fromEntries([...modules].map((module) => [module, digest(module, digests)])),
    });
  }
  for (const file of failed) {
    provenance.delete(file);
  }
  writeFileSync(
    `${path}.basis.json`,
    `${JSON.stringify(Object.fromEntries(provenance), null, 2)}\n`,
  );
  rmSync(`${path}.pending`, { force: true });
}
