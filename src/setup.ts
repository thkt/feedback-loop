import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { classification } from './classification.ts';
import { readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { defaultBase, gitOutput } from './git.ts';
import { installedFiles, packageManagers } from './installed.ts';
import type { PackageManager } from './installed.ts';
import { readBunSuites } from './bun-report.ts';
import { commandRunner } from './command.ts';
import { assertObject, errorMessage, stringRecord, versionAtLeast } from './values.ts';

// build.tsが生成時にdefineで埋め込みます。このファイルは生成したsetup.mjsから実行します。
declare const minimumBun: string;

/** rootを含むGit checkoutのルート。gitはリンクを解決したパスを返すため、比べる側も解決したパスを使う。 */
function gitRoot(root: string) {
  const top = gitOutput(root, ['rev-parse', '--show-toplevel']);
  assert(top !== undefined, '--repoはGit checkoutの中のディレクトリを指定してください');
  return realpathSync(top);
}

function inspect(root: string) {
  const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertObject(pkg);
  const scripts = stringRecord(pkg.scripts ?? {});
  const devDependencies = stringRecord(pkg.devDependencies ?? {});
  const dependencies = stringRecord(pkg.dependencies ?? {});
  const hints = new Set<string>();
  if (typeof pkg.packageManager === 'string') {
    hints.add(pkg.packageManager.split('@')[0] ?? 'unknown');
  }
  for (const [path, manager] of [
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'unknown'],
    ['pnpm-lock.yaml', 'pnpm'],
  ] as const) {
    if (existsSync(join(root, path))) {
      hints.add(manager);
    }
  }
  const first = [...hints][0];
  const packageManager: PackageManager | null =
    (hints.size === 1 && packageManagers.find((manager) => manager === first)) || null;
  const configFiles = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /(?:config|lock|mise|bunfig|feedback-loop|eslint|prettier|biome|oxlint|oxfmt|fallow)/.test(
          entry.name,
        ),
    )
    .map((entry) => entry.name);
  // CI定義はGitのルートにある。rootがその下なら../で始まるパスになる。
  const workflow = join(gitRoot(root), '.github/workflows');
  if (existsSync(workflow)) {
    configFiles.push(...readdirSync(workflow).map((name) => relative(root, join(workflow, name))));
  }
  const base = defaultBase(root);
  return {
    packageManager,
    base,
    scripts,
    devDependencies,
    dependencies,
    configFiles: configFiles.sort(),
    runtime: pkg.engines ?? pkg.packageManager ?? null,
    tools: Object.keys({ ...dependencies, ...devDependencies }).filter((name) =>
      /eslint|prettier|biome|oxlint|oxfmt|fallow|typescript|vitest/.test(name),
    ),
    diagnostics: [
      [packageManager, 'package managerが未指定、競合、または未対応です'],
      [
        base,
        '比較元を決められません。origin/HEADがなく、mainとmasterが両方あるか、どちらもありません',
      ],
    ]
      .filter(([found]) => !found)
      .map(([, message]) => message),
    pkg,
  };
}

type Inspection = ReturnType<typeof inspect>;
type ManagedInspection = Inspection & { packageManager: PackageManager };

function inspectManaged(root: string): ManagedInspection {
  const inspected = inspect(root);
  const { packageManager } = inspected;
  assert(packageManager, 'package managerを選択できません');
  return { ...inspected, packageManager };
}

function install(root: string, inspected: ManagedInspection, packages: string[]) {
  assert(packages.length > 0, '--package NAME@固定版を指定してください');
  const missing: string[] = [];
  const requested = new Map<string, string>();
  for (const spec of packages) {
    const match = /^(oxlint|oxfmt|fallow)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
    assert(match, `自動導入はoxlint・oxfmt・fallowの固定版だけに対応します: ${spec}`);
    const [, name = '', version] = match;
    assert(version);
    assert(
      !requested.has(name) || requested.get(name) === version,
      `複数の版が指定されています: ${name}`,
    );
    requested.set(name, version);
    const current = inspected.devDependencies[name] ?? inspected.dependencies[name];
    assert(
      current === undefined || current === version,
      `既存版を置換しません: ${name}=${current}`,
    );
    if (current === undefined && !missing.includes(spec)) {
      missing.push(spec);
    }
  }
  if (missing.length === 0) {
    console.log('指定した固定版は導入済みです。変更しません');
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
    '導入後のdevDependenciesが指定した固定版と一致しません',
  );
}

function generatedFiles(config: FeedbackConfig, packageManager: PackageManager) {
  return installedFiles(
    (name) => readFileSync(join(import.meta.dir, name), 'utf8'),
    packageManager,
    config.runner,
  );
}

function runtimeCommands(config: FeedbackConfig) {
  let runtime = { bun: 'bun', vitest: 'node' }[config.runner];
  if (config.bunArgs.includes('--no-env-file')) {
    runtime += ' --no-env-file';
  }
  return {
    'test:affected': `${runtime} scripts/feedback-loop/runtime.mjs affected`,
    'check:classification': `${runtime} scripts/feedback-loop/runtime.mjs classification`,
  };
}

function writeFiles(root: string, updates: Map<string, string>) {
  for (const [path, body] of updates) {
    console.log(`配置: ${path}`);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

function planGeneratedFiles(
  root: string,
  generated: Map<string, string>,
  mode: 'apply' | 'update',
) {
  const updates = new Map<string, string>();
  const conflicts: string[] = [];
  for (const [path, body] of generated) {
    const target = join(root, path);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    if (current === body) {
      continue;
    }
    if (
      current === undefined ||
      (mode === 'update' &&
        gitOutput(root, ['status', '--porcelain', '--untracked-files=all', '--', path]) === '')
    ) {
      updates.set(path, body);
    } else {
      conflicts.push(path);
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

function update(root: string, inspected: ManagedInspection) {
  const config = readConfig(root);
  const { updates, conflicts } = planGeneratedFiles(
    root,
    generatedFiles(config, inspected.packageManager),
    'update',
  );
  assert(
    conflicts.length === 0,
    `未コミットの変更または未追跡のファイルがあるため、どのファイルも更新しません。コミットするか変更を戻してから再実行してください: ${conflicts.join(', ')}`,
  );
  reportConnectionDiffs(inspected, runtimeCommands(config));
  writeFiles(root, updates);
  console.log(
    updates.size === 0
      ? '生成物は最新です。変更しません'
      : '生成物を更新しました。check:classificationとcheck:feedbackを実行して確認してください',
  );
}

/** directoryは、Gitのルートから見たpackageのディレクトリ。ルート自身なら空文字列。 */
function agentSection(
  directory: string,
  packageManager: PackageManager,
  checkCommand: string | undefined,
) {
  const quoted = /^[\w./-]+$/.test(directory)
    ? directory
    : `'${directory.replaceAll("'", "'\\''")}'`;
  const enter = directory ? `cd ${quoted} && ` : '';
  const subject = directory ? `\`${directory}/\`のコードやテスト` : 'コードやテスト';
  const check = checkCommand ?? `${enter}${packageManager} run check`;
  return `## 変更後の確認

${subject}を変更したら、作業を終える前に\`${enter}${packageManager} run check:feedback\`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では\`${check}\`も実行する。\`check:feedback\`の成功を全体checkの成功として報告しない。
`;
}

/** 既存の指示は統合せず、定型の節と読込み行だけを配置予定へ加える。 */
function planAgentInstructions(
  root: string,
  packageManager: PackageManager,
  checkCommand: string | undefined,
) {
  const updates = new Map<string, string>();
  // エージェントはGitのルートで起動するため、指示はGitのルートへ置く。配置先はrootからの相対パスで表す。
  const top = gitRoot(root);
  const placed = (name: string) => relative(root, join(top, name));
  const agentsPath = join(top, 'AGENTS.md');
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  if (/^## 変更後の確認[ \t]*\r?$/m.test(agents)) {
    console.log('AGENTS.mdの「## 変更後の確認」は既存の内容を保持します');
  } else {
    const prefix = agents ? `${agents}${agents.endsWith('\n') ? '\n' : '\n\n'}` : '';
    updates.set(
      placed('AGENTS.md'),
      prefix + agentSection(relative(top, root), packageManager, checkCommand),
    );
  }
  const claudePath = join(top, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    const claude = readFileSync(claudePath, 'utf8');
    if (!/^@AGENTS\.md[ \t]*\r?$/m.test(claude)) {
      updates.set(placed('CLAUDE.md'), `@AGENTS.md\n${claude}`);
    }
  } else if (existsSync(join(top, 'CLAUDE.local.md'))) {
    console.log('CLAUDE.local.mdは変更しません。利用者が@AGENTS.mdの行を追加してください');
  }
  return updates;
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
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(' ');
  const run = commandRunner(join(import.meta.dir, 'runtime.mjs'), retryCommand);
  await classification(root, config, run);
  const commands = { ...runtimeCommands(config), 'check:feedback': feedback };
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
  install   不足する固定版の依存を導入します
            --package <oxlint|oxfmt|fallow>@<版>（複数指定可）
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
        const { pkg: _pkg, ...report } = inspect(repo);
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
  console.error(`setup-feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
