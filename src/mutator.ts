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
import { vitestRunnerArgs } from './mutator-vitest.ts';
import { recordsDirectory } from './records.ts';
import { assertObject, assertRepoRelativePath, isRecord } from './values.ts';

export type MutationRequest = { module: string; key: string | undefined; withAssurance: boolean };

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
  outcome: Verdict | 'ignored' | 'uncompilable';
};

const bunDefaultTimeoutMs = 5000;
const timeoutFactor = 3;
const testFilePattern = /(?:\.test|_test|\.spec|_spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const preloadOriginalVariable = 'FEEDBACK_LOOP_MUTATION_BUN_OPTIONS';
const mutatorTestVariables = new Set([
  'MUTATOR_ACTIVE',
  'MUTATOR_BUN_MANIFEST',
  'MUTATOR_BUN_OUT',
  'MUTATOR_HIT_LIMIT',
  'MUTATOR_WATCH_PARENT',
]);
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
  const offending = bunArgs.find((arg) => !arg.startsWith('-') || /\s/.test(arg));
  assert(
    offending === undefined,
    `bunArgsの「${offending}」は、mutationでは渡せません。壊し方を実行せずに止めます。bunArgsの各要素は-で始め、空白を含めず、値を取る引数は--env-file=.env.testのように=でつないでください。スクリプトなら、${wrappingGuide}`,
  );
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

function mutatorFiles(root: string) {
  const directory = join(recordsDirectory(root), 'mutator');
  mkdirSync(directory, { recursive: true });
  const config = join(directory, 'mutator.config.json');
  writeFileSync(config, '{}\n');
  const report = join(directory, 'report');
  rmSync(report, { recursive: true, force: true });
  mkdirSync(join(root, '.mutator'), { recursive: true });
  writeFileSync(join(root, '.mutator', '.gitignore'), '*\n');
  return { directory, config, report };
}

function bunRunnerArgs(root: string, config: FeedbackConfig, tests: string[], directory: string) {
  const testSet = new Set(tests);
  const ignored = bunTestFiles(root)
    .filter((file) => !testSet.has(file))
    .toSorted();
  const bunfig = join(directory, 'bunfig.toml');
  writeFileSync(
    bunfig,
    `[test]\npathIgnorePatterns = [${ignored.map((file) => JSON.stringify(escapeGlob(file))).join(', ')}]\n`,
  );
  const workers = String(config.bunWorkers);
  return [
    '--runner',
    'bun',
    '--bun-config',
    bunfig,
    '--no-typecheck',
    '--concurrency',
    workers,
    '--max-workers',
    workers,
  ];
}

function inheritedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !mutatorTestVariables.has(name)),
  );
}

function bunTestEnvironment(config: FeedbackConfig) {
  const user = process.env.BUN_OPTIONS;
  const options = [
    ...(user === undefined || user.trim() === '' ? [] : [user]),
    `--preload=./${mutationPreloadPath}`,
    `--timeout=${testTimeoutMs(config.testArgs) * timeoutFactor}`,
    ...testBunArgs(config.bunArgs),
  ];
  return {
    ...inheritedEnvironment(),
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

function readMteMutants(reportDirectory: string, path: string) {
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
    return { source: '', mutants: [] };
  }
  assertObject(entry);
  assert(typeof entry.source === 'string' && Array.isArray(entry.mutants));
  return { source: entry.source, mutants: entry.mutants.map(mteMutant) };
}

function readJudged(prepared: Prepared) {
  const { source, mutants } = readMteMutants(prepared.report, prepared.path);
  const starts = lineStartsOf(source);
  return mutants.map((mutant) => judge(prepared.path, source, starts, mutant));
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

function outcomeOf({ status, statusReason }: MteMutant): Judged['outcome'] {
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
    case 'CompileError':
      return 'uncompilable';
    default:
      return {
        verdict: 'error',
        reason: `mutatorが判定を返しませんでした（${status}${statusReason === undefined ? '' : `: ${statusReason}`}）`,
      };
  }
}

function judge(path: string, source: string, starts: number[], mutant: MteMutant): Judged {
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
  return new Map<string, string>(value);
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
  argv: string[];
  env: NodeJS.ProcessEnv;
  report: string;
  typeErrors: (candidates: Judged[]) => Promise<Map<string, string>>;
};

type RunnerSetup = {
  command: string;
  env: NodeJS.ProcessEnv;
  args: (tests: string[], directory: string) => string[];
  typeErrors: Prepared['typeErrors'];
};

function bunSetup(root: string, config: FeedbackConfig): RunnerSetup {
  const env = bunTestEnvironment(config);
  assertInstallOnlyBunfig(root);
  const mutatorEntry = resolveMutator(root);
  assert(
    isFile(join(root, mutationPreloadPath)),
    `${mutationPreloadPath}がありません。setup-feedback-loopのapply --updateで置いてください`,
  );
  return {
    command: join(dirname(mutatorEntry), 'cli.js'),
    env,
    args: (tests, directory) => bunRunnerArgs(root, config, tests, directory),
    typeErrors: async (candidates) => typeErrors(root, mutatorEntry, candidates),
  };
}

function vitestSetup(root: string, config: FeedbackConfig): RunnerSetup {
  const mutatorEntry = resolveMutator(root);
  return {
    command: join(dirname(mutatorEntry), 'cli.js'),
    env: inheritedEnvironment(),
    args: vitestRunnerArgs(root, config),
    typeErrors: async () => new Map<string, string>(),
  };
}

async function prepare(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: MutationRequest,
): Promise<Prepared> {
  const path = moduleFile(root, request.module);
  const setup = config.runner === 'bun' ? bunSetup(root, config) : vitestSetup(root, config);
  const classes = await classification(root, config, run);
  assert(classes.quality.length > 0, '候補0件: qualityがありません');
  if (config.prepare.length > 0) {
    await run(config.prepare, { stdout: 'ignore' });
  }
  const files = mutatorFiles(root);
  const runtime = config.runner === 'bun' && !process.versions.bun ? 'bun' : process.execPath;
  const argv = [
    runtime,
    setup.command,
    ...setup.args(
      request.withAssurance ? [...classes.quality, ...classes.assurance] : classes.quality,
      files.directory,
    ),
    '--include',
    escapeGlob(path),
    '--config-file',
    files.config,
    '--no-arid',
    '--reporter',
    'json',
    '--report-dir',
    files.report,
    ...(request.key === undefined ? [] : ['--only', request.key]),
  ];
  return { path, argv, env: setup.env, report: files.report, typeErrors: setup.typeErrors };
}

async function runMutator(root: string, run: Run, prepared: Prepared) {
  await run(prepared.argv, {
    cwd: root,
    env: prepared.env,
    stdout: 'ignore',
    allowFailure: true,
  });
  return readJudged(prepared);
}

function unreadableRecords(detail: string) {
  return `${mutantsRecordFile}を読めません。{"<鍵>": {"reason": "<理由>"}}の形で書いてください（${detail}）`;
}

function recordedReasons(root: string) {
  const file = join(root, mutantsRecordFile);
  const reasons = new Map<string, string>();
  if (!existsSync(file)) {
    return reasons;
  }
  let records: unknown;
  try {
    records = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return assert.fail(unreadableRecords('JSONとして読めません'));
  }
  assert(isRecord(records), unreadableRecords('全体が鍵を名前に持つオブジェクトではありません'));
  for (const [key, entry] of Object.entries(records)) {
    assert(isRecord(entry) && typeof entry.reason === 'string', unreadableRecords(key));
    reasons.set(key, entry.reason);
  }
  return reasons;
}

function isUndetected(outcome: Judged['outcome']) {
  return (
    typeof outcome !== 'string' &&
    (outcome.verdict === 'survived' || outcome.verdict === 'uncovered')
  );
}

export async function mutation(
  root: string,
  config: FeedbackConfig,
  run: Run,
  request: { module: string; withAssurance: boolean },
): Promise<MutationReport> {
  const prepared = await prepare(root, config, run, { ...request, key: undefined });
  const judged = await runMutator(root, run, prepared);
  if (judged.length === 0) {
    console.error(
      `mutatorは${prepared.path}から壊し方を作りませんでした。mutatorが対象にしないファイルか、壊せるコードが無いファイルです`,
    );
  }
  const errors = await prepared.typeErrors(judged.filter(({ outcome }) => isUndetected(outcome)));
  const report: MutationReport = { survived: [], uncovered: [], timedOut: [], errors: [] };
  for (const { item, outcome } of judged) {
    if (outcome === 'ignored' || outcome === 'uncompilable' || errors.has(item.key)) {
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
  request: { module: string; key: string; withAssurance: boolean },
): Promise<KeyReport> {
  const prepared = await prepare(root, config, run, request);
  const reason = recordedReasons(root).get(request.key);
  assert(
    reason === undefined,
    `この鍵は${mutantsRecordFile}に記録されています${reason ? `（${reason}）` : ''}。記録にある鍵は、壊し方を実行せずに止めます。記録から外すと、結果を標準出力に書きます: ${request.key}`,
  );
  const judged = await runMutator(root, run, prepared);
  const found = judged.find(({ item }) => item.key === request.key);
  assert(
    found !== undefined,
    `鍵に当たる壊し方が今の${prepared.path}から作られません: ${request.key}`,
  );
  const { item, outcome } = found;
  assert(outcome !== 'ignored', `この鍵の壊し方は、mutatorが実行の対象から外しました: ${item.key}`);
  if (outcome === 'uncompilable') {
    return { ...item, verdict: 'error', reason: '型検査に通りません' };
  }
  if (!isUndetected(outcome)) {
    return { ...item, ...outcome };
  }
  const typeError = (await prepared.typeErrors([found])).get(item.key);
  return typeError === undefined
    ? { ...item, ...outcome }
    : { ...item, verdict: 'error', reason: typeError };
}
