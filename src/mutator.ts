import assert from 'node:assert/strict';
import {
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classification } from './classification.ts';
import type { Run } from './command.ts';
import { isFile, mutantsRecordFile, repoPath } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { mutationPreloadPath } from './installed.ts';
import { recordsDirectory } from './records.ts';
import { assertObject, assertRepoRelativePath, isRecord } from './values.ts';

export type MutationRequest = { module: string; key: string | undefined };

export type Item = {
  key: string;
  path: string;
  line: number;
  rule: string;
  original: string;
  replacement: string;
};

export type MutationReport = {
  survived: Item[];
  uncovered: Item[];
  timedOut: Item[];
  errors: (Item & { reason: string })[];
};

type Verdict =
  | { verdict: 'killed' | 'survived' | 'uncovered' | 'timedOut' }
  | { verdict: 'error'; reason: string };

export type KeyReport = Item & Verdict;

type Judged = {
  item: Item;
  range: { start: number; end: number };
  outcome: Verdict | 'ignored';
  accepted: string | undefined;
};

const bunDefaultTimeoutMs = 5000;
const timeoutFactor = 3;
const testFilePattern = /(?:\.test|_test|\.spec|_spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const preloadOriginalVariable = 'FEEDBACK_LOOP_MUTATION_BUN_OPTIONS';
const wrappingGuide =
  'references/contract.mdの「ファイルの配置と接続」のとおり、環境変数はcheck:affectedとmutationのscriptを包んで渡してください';

function moduleFile(root: string, path: string) {
  const local = repoPath(root, path);
  assertRepoRelativePath(local);
  assert(isFile(join(root, local)), `対象のモジュールがrepoの中のファイルではありません: ${path}`);
  return local;
}

function escapeGlob(path: string) {
  return path.replace(/[*?[\]{}()]/g, '[$&]');
}

function testTimeoutMs(testArgs: string[]) {
  let value: string | undefined;
  for (const [index, arg] of testArgs.entries()) {
    if (arg === '--timeout') {
      value = testArgs[index + 1];
    } else if (arg.startsWith('--timeout=')) {
      value = arg.slice('--timeout='.length);
    }
  }
  if (value === undefined) {
    return bunDefaultTimeoutMs;
  }
  const parsed = Number(value);
  assert(
    Number.isSafeInteger(parsed) && parsed > 0,
    `testArgsの--timeoutを正の整数として読めません: ${value}`,
  );
  return parsed;
}

function testBunArgs(bunArgs: string[]) {
  for (const [index, arg] of bunArgs.entries()) {
    assert(
      !/\s/.test(arg),
      `bunArgsの「${arg}」は空白を含むため、mutationでは渡せません。壊し方を実行せずに止めます。BUN_OPTIONSは空白で引数を区切ります`,
    );
    if (arg.startsWith('-')) {
      continue;
    }
    const option = bunArgs[index - 1];
    assert(
      option === undefined || !option.startsWith('-') || option.includes('='),
      `bunArgsの「${option} ${arg}」は、mutationでは読めません。壊し方を実行せずに止めます。スクリプトなら、${wrappingGuide}。値を取る引数なら、${option}=${arg}の形で書いてください`,
    );
    assert.fail(
      `bunArgsのスクリプト（${arg}）は、mutationでは使えません。壊し方を実行せずに止めます。${wrappingGuide}`,
    );
  }
  return bunArgs;
}

function assertInstallOnlyBunfig(root: string) {
  const path = join(root, 'bunfig.toml');
  if (!existsSync(path)) {
    return;
  }
  let table = '';
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1] ?? '';
    } else if (line !== '' && !line.startsWith('#')) {
      assert(
        table === 'install' ||
          table.startsWith('install.') ||
          (table === '' && line.startsWith('install.')),
        'bunfig.tomlが[install]のほかの設定を持つため、壊し方を実行せずに止めます。mutationは導入先のbunfig.tomlを引き継がず、[install]だけのbunfig.tomlで動きます',
      );
    }
  }
}

function resolveMutator(root: string) {
  for (let directory = root; ; directory = dirname(directory)) {
    const manifest = join(directory, 'node_modules', '@mizchi', 'mutator', 'package.json');
    if (existsSync(manifest)) {
      return join(dirname(realpathSync(manifest)), 'dist', 'index.js');
    }
    if (dirname(directory) === directory) {
      return assert.fail(
        `@mizchi/mutatorを読み込めません。導入先のdevDependenciesに固定版で入れてください: ${root}から親のディレクトリのnode_modulesにありません`,
      );
    }
  }
}

function bunTestFiles(root: string, directory = ''): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name.startsWith('.')
        ? []
        : bunTestFiles(root, path);
    }
    return testFilePattern.test(entry.name) ? [path] : [];
  });
}

function mutatorFiles(root: string, quality: string[]) {
  const directory = join(recordsDirectory(root), 'mutator');
  mkdirSync(directory, { recursive: true });
  const qualitySet = new Set(quality);
  const ignored = bunTestFiles(root)
    .filter((file) => !qualitySet.has(file))
    .toSorted();
  const bunfig = join(directory, 'bunfig.toml');
  writeFileSync(
    bunfig,
    `[test]\npathIgnorePatterns = [${ignored.map((file) => JSON.stringify(escapeGlob(file))).join(', ')}]\n`,
  );
  const config = join(directory, 'mutator.config.json');
  writeFileSync(config, '{}\n');
  const report = join(directory, 'report');
  rmSync(report, { recursive: true, force: true });
  mkdirSync(join(root, '.mutator'), { recursive: true });
  writeFileSync(join(root, '.mutator', '.gitignore'), '*\n');
  return { bunfig, config, report };
}

function testEnvironment(config: FeedbackConfig) {
  const user = process.env.BUN_OPTIONS;
  const options = [
    ...(user === undefined || user.trim() === '' ? [] : [user]),
    `--preload=./${mutationPreloadPath}`,
    `--timeout=${testTimeoutMs(config.testArgs) * timeoutFactor}`,
    ...testBunArgs(config.bunArgs),
  ];
  return {
    ...process.env,
    BUN_OPTIONS: options.join(' '),
    [preloadOriginalVariable]: JSON.stringify(user ?? null),
  };
}

type MteMutant = {
  id: string;
  mutatorName: string;
  replacement: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
  status: string;
  statusReason?: string;
};

function offset(lineStarts: number[], { line, column }: { line: number; column: number }) {
  const start = lineStarts[line - 1];
  assert(start !== undefined, `mutatorの報告の行がソースにありません: ${line}`);
  return start + column - 1;
}

function lineStartsOf(source: string) {
  const starts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function assertTargeted(root: string, path: string) {
  const unknownTarget = (cause: string) =>
    `mutatorの報告に${path}の項目が無く、${cause}ため、mutatorが${path}を対象にしたかを確かめられません。@mizchi/mutatorの版を確かめてください`;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(readFileSync(join(root, '.mutator', 'snapshot.json'), 'utf8'));
  } catch {
    assert.fail(unknownTarget('.mutator/snapshot.jsonを読めない'));
  }
  assert(
    isRecord(snapshot) && isRecord(snapshot.scopes),
    unknownTarget('.mutator/snapshot.jsonのscopesの形が想定と違う'),
  );
  assert(
    Object.hasOwn(snapshot.scopes, path),
    `mutatorは${path}を壊す対象にしませんでした。mutatorは、node_modulesの下、型の宣言のファイル（*.d.ts）、テストのファイル（*.test.*、*.spec.*、__tests__/の下）、JavaScriptとTypeScriptでないファイルを対象にしません`,
  );
}

function readMteMutants(root: string, reportDirectory: string, path: string) {
  const file = join(reportDirectory, 'mutation.json');
  assert(
    existsSync(file),
    'mutatorが報告を書かずに終わりました。標準エラーのmutatorの診断を確かめてください（壊す前のテストの失敗など）',
  );
  const report: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assertObject(report);
  assertObject(report.files);
  const entry = report.files[path];
  if (entry === undefined) {
    assertTargeted(root, path);
    return { source: '', mutants: [] };
  }
  assertObject(entry);
  assert(typeof entry.source === 'string' && Array.isArray(entry.mutants));
  return { source: entry.source, mutants: entry.mutants.map(mteMutant) };
}

function mteMutant(value: unknown): MteMutant {
  assertObject(value);
  assert(
    typeof value.id === 'string' &&
      typeof value.mutatorName === 'string' &&
      typeof value.replacement === 'string' &&
      typeof value.status === 'string' &&
      isRecord(value.location),
    'mutatorの報告の壊し方の形が想定と違います',
  );
  const { start, end } = value.location;
  assert(isRecord(start) && isRecord(end));
  assert(
    typeof start.line === 'number' &&
      typeof start.column === 'number' &&
      typeof end.line === 'number' &&
      typeof end.column === 'number',
  );
  return {
    id: value.id,
    mutatorName: value.mutatorName,
    replacement: value.replacement,
    status: value.status,
    location: {
      start: { line: start.line, column: start.column },
      end: { line: end.line, column: end.column },
    },
    ...(typeof value.statusReason === 'string' ? { statusReason: value.statusReason } : {}),
  };
}

function outcomeOf({ status, statusReason }: MteMutant): Verdict | 'ignored' {
  switch (status) {
    case 'Killed':
    case 'RuntimeError':
      return { verdict: 'killed' };
    case 'Survived':
      return { verdict: 'survived' };
    case 'NoCoverage':
      return { verdict: 'uncovered' };
    case 'Timeout':
      return { verdict: 'timedOut' };
    case 'Ignored':
      return 'ignored';
    default:
      return {
        verdict: 'error',
        reason: `mutatorが判定を返しませんでした（${status}${statusReason === undefined ? '' : `: ${statusReason}`}）`,
      };
  }
}

function judge(path: string, source: string, mutant: MteMutant): Judged {
  const starts = lineStartsOf(source);
  const range = {
    start: offset(starts, mutant.location.start),
    end: offset(starts, mutant.location.end),
  };
  return {
    item: {
      key: mutant.id,
      path,
      line: mutant.location.start.line,
      rule: mutant.mutatorName,
      original: source.slice(range.start, range.end),
      replacement: mutant.replacement,
    },
    range,
    outcome: outcomeOf(mutant),
    accepted: /^accepted: (.*)$/s.exec(mutant.statusReason ?? '')?.[1],
  };
}

type Callable = (...args: unknown[]) => unknown;

function isCallable(value: unknown): value is Callable {
  return typeof value === 'function';
}

async function loadBunChecker(mutatorEntry: string) {
  const typecheckEntry = realpathSync(
    createRequire(mutatorEntry).resolve('@mizchi/mutator-typecheck'),
  );
  const module: unknown = await import(pathToFileURL(join(dirname(typecheckEntry), 'bun.js')).href);
  assert(
    isRecord(module) && isCallable(module.createBunChecker),
    '@mizchi/mutator-typecheckのcreateBunCheckerを読み込めません。mutatorの版を確かめてください',
  );
  return module.createBunChecker;
}

function method(target: Record<string, unknown>, name: string) {
  const value = target[name];
  assert(isCallable(value), `createBunCheckerの戻り値に${name}がありません`);
  return (...args: unknown[]) => value.apply(target, args);
}

function stringMap(value: unknown) {
  assert(
    value instanceof Map &&
      [...value].every(([key, error]) => typeof key === 'string' && typeof error === 'string'),
    'createBunCheckerの検査の結果の形が想定と違います',
  );
  return new Map([...value].map(([key, error]) => [String(key), String(error)]));
}

async function typeErrors(root: string, mutatorEntry: string, candidates: Judged[]) {
  const tsconfig = join(root, 'tsconfig.json');
  if (candidates.length === 0 || !existsSync(tsconfig)) {
    return new Map<string, string>();
  }
  console.error(`型検査: ${candidates.length}件`);
  const createBunChecker = await loadBunChecker(mutatorEntry);
  const checker = createBunChecker({ root, tsconfig }, 'bun check');
  assertObject(checker);
  const close = method(checker, 'close');
  try {
    return stringMap(
      method(
        checker,
        'check',
      )(
        candidates.map(({ item, range }) => ({
          key: item.key,
          file: join(root, item.path),
          range,
          replacement: item.replacement,
        })),
      ),
    );
  } finally {
    close();
  }
}

type Prepared = {
  path: string;
  mutatorEntry: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  report: string;
};

async function prepare(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: MutationRequest,
): Promise<Prepared> {
  assert(config.runner === 'bun', 'mutationは、Bunテストの導入先だけで使えます');
  const path = moduleFile(root, request.module);
  const env = testEnvironment(config);
  assertInstallOnlyBunfig(root);
  const mutatorEntry = resolveMutator(root);
  assert(
    isFile(join(root, mutationPreloadPath)),
    `${mutationPreloadPath}がありません。setup-feedback-loopのapply --updateで置いてください`,
  );
  const classes = await classification(root, config, run);
  assert(classes.quality.length > 0, '候補0件: qualityがありません');
  if (config.prepare.length > 0) {
    await run(config.prepare, { stdout: 'ignore' });
  }
  const files = mutatorFiles(root, classes.quality);
  const workers = String(config.bunWorkers);
  const argv = [
    process.versions.bun ? process.execPath : 'bun',
    join(dirname(mutatorEntry), 'cli.js'),
    '--runner',
    'bun',
    '--include',
    escapeGlob(path),
    '--bun-config',
    files.bunfig,
    '--config-file',
    files.config,
    '--no-arid',
    '--no-typecheck',
    '--concurrency',
    workers,
    '--max-workers',
    workers,
    '--reporter',
    'json',
    '--report-dir',
    files.report,
    ...(request.key === undefined ? [] : ['--only', request.key, '--reporter', 'agent']),
  ];
  return { path, mutatorEntry, argv, env, report: files.report };
}

async function runMutator(root: string, run: Run, prepared: Prepared) {
  await run(prepared.argv, {
    cwd: root,
    env: prepared.env,
    stdout: 'ignore',
    allowFailure: true,
    terminateOnHangup: true,
  });
  const { source, mutants } = readMteMutants(root, prepared.report, prepared.path);
  return mutants.map((mutant) => judge(prepared.path, source, mutant));
}

function acceptedButKilled(agentReport: string) {
  let report: unknown;
  try {
    report = JSON.parse(agentReport);
  } catch {
    return assert.fail('mutatorのagentの報告をJSONとして読めません');
  }
  if (!isRecord(report) || report.acceptance === undefined) {
    return [];
  }
  const { acceptance } = report;
  assert(
    isRecord(acceptance) &&
      Array.isArray(acceptance.killed) &&
      acceptance.killed.every((key) => typeof key === 'string'),
    'mutatorのagentの報告のacceptanceの形が想定と違います',
  );
  return acceptance.killed;
}

async function runMutatorForKey(root: string, run: Run, prepared: Prepared) {
  const { stdout } = await run(prepared.argv, {
    cwd: root,
    env: prepared.env,
    stdout: 'capture',
    allowFailure: true,
    terminateOnHangup: true,
  });
  const { source, mutants } = readMteMutants(root, prepared.report, prepared.path);
  return {
    judged: mutants.map((mutant) => judge(prepared.path, source, mutant)),
    killedRecords: acceptedButKilled(stdout),
  };
}

function isUndetected(outcome: Judged['outcome']) {
  return (
    outcome !== 'ignored' && (outcome.verdict === 'survived' || outcome.verdict === 'uncovered')
  );
}

export async function mutation(
  root: string,
  config: FeedbackConfig,
  run: Run,
  module: string,
): Promise<MutationReport> {
  const prepared = await prepare(root, config, run, { module, key: undefined });
  const judged = await runMutator(root, run, prepared);
  const errors = await typeErrors(
    root,
    prepared.mutatorEntry,
    judged.filter(({ outcome }) => isUndetected(outcome)),
  );
  const report: MutationReport = { survived: [], uncovered: [], timedOut: [], errors: [] };
  for (const { item, outcome } of judged) {
    if (outcome === 'ignored' || errors.has(item.key)) {
      continue;
    }
    if (outcome.verdict === 'error') {
      report.errors.push({ ...item, reason: outcome.reason });
    } else if (outcome.verdict !== 'killed') {
      report[outcome.verdict].push(item);
    }
  }
  return report;
}

export async function mutationByKey(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: { module: string; key: string },
): Promise<KeyReport> {
  const prepared = await prepare(root, config, run, request);
  const { judged, killedRecords } = await runMutatorForKey(root, run, prepared);
  const found = judged.find(({ item }) => item.key === request.key);
  assert(
    found !== undefined,
    `鍵に当たる壊し方が今の${prepared.path}から作られません: ${request.key}`,
  );
  const { path, line, rule, original, replacement } = found.item;
  const verdict = found.outcome === 'ignored' ? '拾わない' : found.outcome.verdict;
  assert(
    found.accepted === undefined && !killedRecords.includes(request.key),
    `この鍵は${mutantsRecordFile}に記録されています${found.accepted === undefined ? '' : `（${found.accepted}）`}。今この鍵に当たる壊し方は、${path}の${line}行目、${rule}、「${original}」を「${replacement}」に置き換えるものです。今のテストの判定は「${verdict}」です。記録にある鍵の結果は、標準出力に書かず、非ゼロで終わります: ${request.key}`,
  );
  return keyReport(root, prepared, found);
}

async function keyReport(root: string, prepared: Prepared, found: Judged): Promise<KeyReport> {
  const { item, outcome } = found;
  assert(outcome !== 'ignored', `この鍵の壊し方は、mutatorが実行の対象から外しました: ${item.key}`);
  if (!isUndetected(outcome)) {
    return { ...item, ...outcome };
  }
  const typeError = (await typeErrors(root, prepared.mutatorEntry, [found])).get(item.key);
  return typeError === undefined
    ? { ...item, ...outcome }
    : { ...item, verdict: 'error', reason: typeError };
}
