import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { classification } from './classification.ts';
import { readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { planAgentInstructions } from './agents.ts';
import { gitOutput } from './git.ts';
import { gitRoot, inspect, inspectManaged } from './inspect.ts';
import type { Inspection, ManagedInspection } from './inspect.ts';
import { generatedVersion, installedFiles, runtimePath } from './installed.ts';
import type { PackageManager } from './installed.ts';
import { readBunSuites } from './bun-report.ts';
import { commandRunner, ReportedFailure } from './command.ts';
import { errorMessage, shellQuote, versionAtLeast } from './values.ts';

// build.tsが生成時にdefineで埋め込みます。このファイルは生成したsetup.mjsから実行します。
declare const minimumBun: string;

function install(root: string, inspected: ManagedInspection, packages: string[]) {
  assert(packages.length > 0, '--package NAME@固定バージョンを指定してください');
  const missing: string[] = [];
  const requested = new Map<string, string>();
  for (const spec of packages) {
    const match = /^(oxlint|oxfmt|fallow)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
    assert(match, `自動導入はoxlint・oxfmt・fallowの固定バージョンだけに対応します: ${spec}`);
    const [, name = '', version] = match;
    assert(version);
    assert(
      !requested.has(name) || requested.get(name) === version,
      `複数のバージョンが指定されています: ${name}`,
    );
    requested.set(name, version);
    const current = inspected.devDependencies[name] ?? inspected.dependencies[name];
    assert(
      current === undefined || current === version,
      `既存のバージョンを置換しません: ${name}=${current}`,
    );
    if (current === undefined && !missing.includes(spec)) {
      missing.push(spec);
    }
  }
  if (missing.length === 0) {
    console.log('指定した固定バージョンは導入済みです。変更しません');
    return;
  }
  // pnpmの引数: https://pnpm.io/cli/add#--save-dev--d--d と #--save-exact--e--e
  const args = [
    ...{
      bun: ['add', '--dev', '--exact'],
      npm: ['install', '--save-dev', '--save-exact'],
      pnpm: ['add', '--save-dev', '--save-exact'],
    }[inspected.packageManager],
    ...missing,
  ];
  console.log(`導入: ${inspected.packageManager} ${args.join(' ')}`);
  const result = spawnSync(inspected.packageManager, args, { cwd: root, stdio: 'inherit' });
  assert(
    !result.error && result.status === 0,
    `依存導入未完了: ${missing.join(', ')}; ${String(result.error ?? result.signal ?? result.status)}。部分変更を保持しています。package.jsonとlockfileを確認してください`,
  );
  const after = inspect(root);
  assert(
    missing.every((spec) => {
      const [name = '', version] = spec.split('@');
      return after.devDependencies[name] === version;
    }),
    '導入後のdevDependenciesが指定した固定バージョンと一致しません',
  );
}

function generatedFiles(config: FeedbackConfig, packageManager: PackageManager) {
  return installedFiles(
    (name) => readFileSync(join(import.meta.dir, name), 'utf8'),
    packageManager,
    config.runner,
  );
}

// 0.2.1までの導入がcheck:affectedを接続していた名前。test:*の一括実行に混ざるため改名した。
const legacyAffected = 'test:affected';
const affectedScript = `${runtimePath} affected`;

function runtimeCommands(config: FeedbackConfig) {
  let runtime = { bun: 'bun', vitest: 'node' }[config.runner];
  if (config.bunArgs.includes('--no-env-file')) {
    runtime += ' --no-env-file';
  }
  return {
    'check:affected': `${runtime} ${affectedScript}`,
    'check:classification': `${runtime} ${runtimePath} classification`,
  };
}

/**
 * package.jsonへ接続するcheck:affectedとcheck:classification。
 * 導入担当が環境変数の読み込みなどで包んだ既存scriptは、生成するコマンドを含んでいれば保持する。
 * 改名前の名前で包んだscriptも、check:affectedの値として引き継ぐ。
 */
function connectedCommands(config: FeedbackConfig, scripts: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(runtimeCommands(config)).map(([name, command]) => {
      const candidates = [
        scripts[name],
        ...(name === 'check:affected' ? [scripts[legacyAffected]] : []),
      ];
      return [name, candidates.find((value) => value?.includes(command)) ?? command];
    }),
  );
}

function writeFiles(root: string, updates: Map<string, string>) {
  for (const [path, body] of updates) {
    console.log(`配置: ${path}`);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

/** 生成物を配置先へどう扱うか。sameは変更なし、placeは新規の配置、replaceは置き換え、conflictは置き換えずに止める。 */
function placement(
  root: string,
  path: string,
  body: string,
  mode: 'apply' | 'update',
): 'same' | 'place' | 'replace' | 'conflict' {
  const target = join(root, path);
  if (!existsSync(target)) {
    return 'place';
  }
  if (readFileSync(target, 'utf8') === body) {
    return 'same';
  }
  // applyは内容の違う既存ファイルを置き換えない。--updateは、gitが変更なしと見るファイルだけを置き換える。
  const committed =
    mode === 'update' &&
    gitOutput(root, ['status', '--porcelain', '--untracked-files=all', '--', path]) === '';
  return committed ? 'replace' : 'conflict';
}

function planGeneratedFiles(
  root: string,
  generated: Map<string, string>,
  mode: 'apply' | 'update',
) {
  const updates = new Map<string, string>();
  const conflicts: string[] = [];
  for (const [path, body] of generated) {
    switch (placement(root, path, body, mode)) {
      case 'same':
        break;
      case 'place':
      case 'replace':
        updates.set(path, body);
        break;
      case 'conflict':
        conflicts.push(path);
        break;
    }
  }
  return { updates, conflicts };
}

function reportConnectionDiffs(inspected: Inspection, commands: Record<string, string>) {
  for (const [name, command] of Object.entries(commands)) {
    if (inspected.scripts[name] !== command) {
      console.log(
        `package.jsonは変更しません。差分: ${name}: ${inspected.scripts[name] ?? '(未定義)'} → ${command}`,
      );
    }
  }
  if (inspected.scripts['check:feedback'] === undefined) {
    console.log('package.jsonは変更しません。差分: check:feedback: (未定義)');
  }
}

const renameDiff = (name: string, from: string, to: string) =>
  console.log(`改名前のscriptは変更しません。差分: ${name}: ${from} → ${to}`);

/** 改名前のtest:affectedと、npmとBunがその前後に実行するhookの改名を示す。 */
function reportLegacyScripts(scripts: Record<string, string>, legacy: string) {
  renameDiff(legacyAffected, legacy, '(削除。check:affectedへ改名)');
  for (const hook of ['pre', 'post']) {
    const value = scripts[`${hook}${legacyAffected}`];
    if (value !== undefined) {
      renameDiff(`${hook}${legacyAffected}`, value, `(${hook}check:affectedへ改名)`);
    }
  }
}

/**
 * 改名前の名前が残る導入先へ、消す名前と、その名前を呼ぶscriptの書き換えを示す。
 * test:affectedを消した後に残った呼出しも示す。
 */
function reportRenameDiffs(scripts: Record<string, string>) {
  const legacy = scripts[legacyAffected];
  if (legacy !== undefined) {
    // 生成するコマンドを含まないtest:affectedは、導入先が独自に定義したscriptである。
    if (!legacy.includes(affectedScript)) {
      return;
    }
    reportLegacyScripts(scripts, legacy);
  }
  // test:affected:unitのような別の名前は置き換えない。
  const call = /(?<![\w:-])test:affected(?![\w:-])/g;
  for (const [name, value] of Object.entries(scripts)) {
    const renamed = value.replace(call, 'check:affected');
    // check:affectedの値は、接続先との差分が別に示す。
    if (name !== legacyAffected && name !== 'check:affected' && renamed !== value) {
      renameDiff(name, value, renamed);
    }
  }
}

// 配置済みのバージョンが、配置する生成物のバージョンより新しいパスを、配置済みのバージョンを添えて返す。
// どちらかにバージョンの行がなければ、比べない。リリース済みの0.4.2までの生成物がこれに当たる。
function newerInstalled(root: string, generated: Map<string, string>) {
  return [...generated].flatMap(([path, body]) => {
    const target = join(root, path);
    const placed = existsSync(target) ? generatedVersion(readFileSync(target, 'utf8')) : undefined;
    const bundled = generatedVersion(body);
    return placed !== undefined && bundled !== undefined && !versionAtLeast(bundled, placed)
      ? [`${path}（${placed}）`]
      : [];
  });
}

function update(root: string, inspected: ManagedInspection) {
  const config = readConfig(root);
  const generated = generatedFiles(config, inspected.packageManager);
  const version = generatedVersion(generated.get(runtimePath) ?? '');
  // 古いバージョンのプラグインで、新しいバージョンの生成物を置き換えない。
  const newer = newerInstalled(root, generated);
  const { updates, conflicts } = planGeneratedFiles(root, generated, 'update');
  assert(
    newer.length === 0,
    `配置済みの生成物が、このプラグインのバージョン（${version}）より新しいため、どのファイルも更新しません。プラグインを更新してから再実行してください: ${newer.join(', ')}`,
  );
  assert(
    conflicts.length === 0,
    `未コミットの変更または未追跡のファイルがあるため、どのファイルも更新しません。コミットするか変更を戻してから再実行してください: ${conflicts.join(', ')}`,
  );
  reportConnectionDiffs(inspected, connectedCommands(config, inspected.scripts));
  reportRenameDiffs(inspected.scripts);
  writeFiles(root, updates);
  console.log(
    updates.size === 0
      ? `生成物は最新です（${version}）。変更しません`
      : '生成物を更新しました。check:classificationとcheck:feedbackを実行して確認してください',
  );
}

async function apply(
  root: string,
  inspected: ManagedInspection,
  feedback: string,
  checkCommand: string | undefined,
) {
  assert(feedback, '--feedback-commandに診断用コマンドを指定してください');
  assert(
    checkCommand !== undefined || inspected.scripts.check !== undefined,
    '全体checkが未指定です。--check-commandに全体checkのコマンドを指定してください',
  );
  const config = readConfig(root);
  const retryCommand = [
    process.execPath,
    ...process.execArgv,
    import.meta.path,
    'apply',
    '--repo',
    root,
    '--feedback-command',
    feedback,
    ...(checkCommand === undefined ? [] : ['--check-command', checkCommand]),
  ]
    .map(shellQuote)
    .join(' ');
  const run = commandRunner(join(import.meta.dir, 'runtime.mjs'), retryCommand);
  await classification(root, config, run);
  const commands = {
    ...connectedCommands(config, inspected.scripts),
    'check:feedback': feedback,
  };
  for (const [name, command] of Object.entries(commands)) {
    assert(
      inspected.scripts[name] === undefined || inspected.scripts[name] === command,
      `既存コマンドと衝突しています: ${name}`,
    );
  }
  const { updates, conflicts } = planGeneratedFiles(
    root,
    generatedFiles(config, inspected.packageManager),
    'apply',
  );
  assert(conflicts.length === 0, `配置済みファイルと衝突しています: ${conflicts.join(', ')}`);
  const nextPackage = { ...inspected.pkg, scripts: { ...inspected.scripts, ...commands } };
  if (JSON.stringify(nextPackage) !== JSON.stringify(inspected.pkg)) {
    updates.set('package.json', `${JSON.stringify(nextPackage, null, 2)}\n`);
  }
  for (const [path, body] of planAgentInstructions(root, inspected.packageManager, checkCommand)) {
    updates.set(path, body);
  }
  console.log(JSON.stringify({ scripts: commands }));
  reportRenameDiffs(nextPackage.scripts);
  writeFiles(root, updates);
  console.log('補助ファイルを配置しました');
  console.log(
    '静的検査・通常check・CIの接続、AGENTS.mdの既存指示との統合と動作確認は導入担当が完了してください',
  );
}

async function compareTests(root: string, argv: string[]) {
  assert(argv[0] === 'bun' && argv.includes('test'), '--の後にbun testのargvが必要です');
  const config = readConfig(root);
  assert(config.runner === 'bun', 'compare-testsはBunだけで使用できます');
  const run = commandRunner(
    join(import.meta.dir, 'runtime.mjs'),
    'setup.mjs compare-testsを同じ引数で再実行',
  );
  const { all } = await classification(root, config, run);
  const temp = mkdtempSync(join(tmpdir(), 'feedback-loop-compare-'));
  try {
    const report = join(temp, 'junit.xml');
    await run([...argv, '--reporter=junit', '--reporter-outfile', report], {
      cwd: root,
      captureStdout: true,
      allowFailure: true,
    });
    const { suites } = readBunSuites(readFileSync(report, 'utf8'), root);
    const executed = new Set(suites.keys());
    const listed = new Set(all);
    const missing = all.filter((path) => !executed.has(path));
    const extra = [...executed].filter((path) => !listed.has(path)).sort();
    console.log(JSON.stringify({ missing, extra }));
    process.exitCode = missing.length + extra.length === 0 ? 0 : 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const usage = `使い方: bun setup.mjs <操作> --repo <package.jsonがあるディレクトリの絶対パス> [引数]

操作:
  inspect   構成を調べてJSONで表示します。ファイルは変更しません
  install   不足する固定バージョンの依存を導入します
            --package <oxlint|oxfmt|fallow>@<バージョン>（複数指定可）
  apply     .feedback-loop.jsonを読み、補助ファイルとpackage scriptsを配置します
            --feedback-command <check:feedbackに設定する診断用コマンド>
            --check-command <AGENTS.mdに記載する全体checkのコマンド>（省略時はcheck script）
            --update  導入済みの生成物を更新します。--feedback-command・--check-commandとは併用しません

  compare-tests  通常checkのBun実行と分類の一覧を照合します
                -- bun test [通常checkと同じ引数]

共通:
  --repo <パス>   Git checkoutの中で、対象のpackage.jsonがあるディレクトリの絶対パス
  -h, --help      この一覧を表示します`;

type Operation = {
  options: string[];
  testArgv?: boolean;
  run: (repo: string) => void | Promise<void>;
};

// 値を取らない引数と、複数回指定できる引数。ここにない引数は値を1つ取り、1回だけ指定できる。
const flagOptions = new Set(['--update']);
const repeatableOptions = new Set(['--package']);

/** `--`より前を操作と引数、後をテストのargvとして分ける。 */
function splitArgv(argv: string[]) {
  const separator = argv.indexOf('--');
  return separator < 0
    ? { options: argv, testArgv: [], separated: false }
    : { options: argv.slice(0, separator), testArgv: argv.slice(separator + 1), separated: true };
}

function parseOptions(args: string[]) {
  const values = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    assert(key, '空の引数は指定できません');
    assert(repeatableOptions.has(key) || !values.has(key), `${key}が重複しています`);
    const supplied = values.get(key) ?? [];
    values.set(key, supplied);
    if (flagOptions.has(key)) {
      supplied.push('true');
    } else {
      // コマンド・パッケージ名・絶対パスは-で始まらないため、-で始まる次の語は値ではなく次の引数として読む。
      supplied.push(args[i + 1]?.startsWith('-') ? '' : (args[++i] ?? ''));
    }
  }
  return values;
}

async function setup({
  options: [name = '', ...args],
  testArgv,
  separated,
}: ReturnType<typeof splitArgv>) {
  const values = parseOptions(args);
  const {
    '--repo': [root = ''] = [],
    '--feedback-command': [feedback = ''] = [],
    '--check-command': [checkCommand] = [],
    '--package': packages = [],
  } = Object.fromEntries(values);
  const operations: Record<string, Operation> = {
    inspect: {
      options: ['--repo'],
      run: (repo) => {
        const { pkg: _pkg, manager: _manager, ...report } = inspect(repo);
        console.log(JSON.stringify(report, null, 2));
      },
    },
    install: {
      options: ['--repo', '--package'],
      run: (repo) => install(repo, inspectManaged(repo), packages),
    },
    apply: {
      options: ['--repo', '--feedback-command', '--check-command'],
      run: (repo) => apply(repo, inspectManaged(repo), feedback, checkCommand),
    },
    'apply --update': {
      options: ['--repo'],
      run: (repo) => update(repo, inspectManaged(repo)),
    },
    'compare-tests': {
      options: ['--repo'],
      testArgv: true,
      run: (repo) => compareTests(repo, testArgv),
    },
  };
  const operation = name === 'apply' && values.delete('--update') ? 'apply --update' : name;
  const definition = Object.hasOwn(operations, operation) && operations[operation];
  assert(definition, '操作はinspect・install・apply・compare-testsです');
  for (const [key, supplied] of values) {
    assert(definition.options.includes(key), `${operation}では${key}を指定できません`);
    assert(
      supplied.every((value) => value.trim()),
      `${key}の値がありません`,
    );
  }
  assert(isAbsolute(root), '--repoにpackage.jsonがあるディレクトリの絶対パスが必要です');
  assert(!separated || definition.testArgv, `${operation}では--を指定できません`);
  gitRoot(root);
  // macOSの/tmpなどのリンクを含むパスも、gitが返すパスと同じ解決済みの形で扱う。
  const repo = realpathSync(root);
  assert(
    existsSync(join(repo, 'package.json')),
    '--repoはpackage.jsonがあるディレクトリを指定してください',
  );
  await definition.run(repo);
}

try {
  assert(
    versionAtLeast(process.versions.bun, minimumBun),
    `Bun ${minimumBun}以上で起動してください（現在: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.version}`}）`,
  );
  const input = splitArgv(process.argv.slice(2));
  if (input.options.some((arg) => arg === '--help' || arg === '-h')) {
    console.log(usage);
    process.exit(0);
  }
  await setup(input);
} catch (error) {
  // 収集や比較のコマンドの失敗は、実行部の監視プロセスが診断を表示している。
  if (!(error instanceof ReportedFailure)) {
    console.error(`setup-feedback-loop未完了: ${errorMessage(error)}`);
  }
  process.exitCode = 1;
}
