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
import { dirname, isAbsolute, join } from 'node:path';
import { classification, packageManagerToken, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { defaultBase, gitOutput } from './git.ts';
import { readBunSuites } from './bun-report.ts';
import { commandRunner, runMonitor } from './command.ts';
import { assertObject, errorMessage } from './values.ts';

// build.tsが生成時にdefineで埋め込みます。このファイルは生成したsetup.mjsから実行します。
declare const requiredBun: string;

function stringMap(value: unknown): Record<string, string> {
  assertObject(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    assert(typeof item === 'string', `${key}は文字列で指定してください`);
    result[key] = item;
  }
  return result;
}

function inspect(root: string) {
  const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertObject(pkg);
  const scripts = stringMap(pkg.scripts ?? {});
  const devDependencies = stringMap(pkg.devDependencies ?? {});
  const dependencies = stringMap(pkg.dependencies ?? {});
  const hints = new Set<string>();
  if (typeof pkg.packageManager === 'string') {
    hints.add(pkg.packageManager.split('@')[0] ?? 'unknown');
  }
  for (const [path, manager] of [
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'unknown'],
    ['pnpm-lock.yaml', 'unknown'],
  ] as const) {
    if (existsSync(join(root, path))) {
      hints.add(manager);
    }
  }
  const first = [...hints][0];
  const packageManager: 'bun' | 'npm' | null =
    hints.size === 1 && (first === 'bun' || first === 'npm') ? first : null;
  const configFiles = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /(?:config|lock|mise|bunfig|feedback-loop|eslint|prettier|biome|fallow|tsconfig)/.test(
          entry.name,
        ),
    )
    .map((entry) => entry.name);
  const workflow = join(root, '.github/workflows');
  if (existsSync(workflow)) {
    configFiles.push(...readdirSync(workflow).map((name) => `.github/workflows/${name}`));
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

function install(root: string, inspected: Inspection, packages: string[]) {
  assert(inspected.packageManager, 'package managerを選択できません');
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
  const args =
    inspected.packageManager === 'bun'
      ? ['add', '--dev', '--exact', ...missing]
      : ['install', '--save-dev', '--save-exact', ...missing];
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

function generatedFiles(config: FeedbackConfig, packageManager: 'bun' | 'npm') {
  const generated = new Map([
    [
      'scripts/feedback-loop/runtime.mjs',
      readFileSync(join(import.meta.dir, 'runtime.mjs'), 'utf8').replaceAll(
        packageManagerToken,
        packageManager,
      ),
    ],
  ]);
  if (config.runner === 'bun') {
    generated.set(
      'scripts/feedback-loop/record-modules.ts',
      readFileSync(join(import.meta.dir, 'record-modules.ts'), 'utf8'),
    );
  }
  return generated;
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

function update(root: string, inspected: Inspection) {
  assert(inspected.packageManager, 'package managerを選択できません');
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

/** 既存の指示は統合せず、定型の節と読込み行だけを配置予定へ加える。 */
function planAgentInstructions(root: string, packageManager: 'bun' | 'npm', check: string) {
  const updates = new Map<string, string>();
  const agentsPath = join(root, 'AGENTS.md');
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  if (/^## 変更後の確認[ \t]*\r?$/m.test(agents)) {
    console.log('AGENTS.mdの「## 変更後の確認」は既存の内容を保持します');
  } else {
    const section = `## 変更後の確認

コードやテストを変更したら、作業を終える前に\`${packageManager} run check:feedback\`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では\`${check}\`も実行する。\`check:feedback\`の成功を全体checkの成功として報告しない。
`;
    const prefix = agents ? `${agents}${agents.endsWith('\n') ? '\n' : '\n\n'}` : '';
    updates.set('AGENTS.md', prefix + section);
  }
  const claudePath = join(root, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    const claude = readFileSync(claudePath, 'utf8');
    if (!/^@AGENTS\.md[ \t]*\r?$/m.test(claude)) {
      updates.set('CLAUDE.md', `@AGENTS.md\n${claude}`);
    }
  } else if (existsSync(join(root, 'CLAUDE.local.md'))) {
    console.log('CLAUDE.local.mdは変更しません。利用者が@AGENTS.mdの行を追加してください');
  }
  return updates;
}

async function apply(
  root: string,
  inspected: Inspection,
  feedback: string,
  checkCommand: string | undefined,
) {
  assert(inspected.packageManager, 'package managerを選択できません');
  assert(feedback, '--feedback-commandに診断用コマンドを指定してください');
  const check =
    checkCommand ??
    (inspected.scripts.check !== undefined ? `${inspected.packageManager} run check` : undefined);
  assert(check, '全体checkが未指定です。--check-commandに全体checkのコマンドを指定してください');
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
    '--check-command',
    check,
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
  for (const [path, body] of planAgentInstructions(root, inspected.packageManager, check)) {
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
  const run = commandRunner(import.meta.path, 'setup.mjs compare-testsを同じ引数で再実行');
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

const usage = `使い方: bun setup.mjs <操作> --repo <Git checkoutの絶対パス> [引数]

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
  --repo <パス>   対象Git checkoutのルートの絶対パス
  -h, --help      この一覧を表示します`;

type Operation = {
  options: string[];
  testArgv?: boolean;
  run: (repo: string) => void | Promise<void>;
};

function parseOptions(args: string[]) {
  const separator = args.indexOf('--');
  const testArgv = separator < 0 ? [] : args.splice(separator).slice(1);
  const values = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    assert(key, '空の引数は指定できません');
    assert(key === '--package' || !values.has(key), `${key}が重複しています`);
    const supplied = values.get(key) ?? [];
    values.set(key, supplied);
    if (key === '--update') {
      supplied.push('true');
    } else {
      // コマンド・パッケージ名・絶対パスは-で始まらないため、-で始まる次の語は値ではなく次の引数として読む。
      supplied.push(args[i + 1]?.startsWith('-') ? '' : (args[++i] ?? ''));
    }
  }
  return { separator, testArgv, values };
}

async function setup([name = '', ...args]: string[]) {
  const { separator, testArgv, values } = parseOptions(args);
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
      run: (repo) => install(repo, inspect(repo), packages),
    },
    apply: {
      options: ['--repo', '--feedback-command', '--check-command'],
      run: (repo) => apply(repo, inspect(repo), feedback, checkCommand),
    },
    'apply --update': {
      options: ['--repo'],
      run: (repo) => update(repo, inspect(repo)),
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
  assert(isAbsolute(root), '--repoにGit checkoutの絶対パスが必要です');
  assert(separator < 0 || definition.testArgv, `${operation}では--を指定できません`);
  const top = gitOutput(root, ['rev-parse', '--show-toplevel']);
  assert(top !== undefined, '--repoはGit checkoutのルートを指定してください');
  // gitはリンクを解決したパスを返すため、macOSの/tmpなどのリンクを含むパスも解決してから比べる。
  const repo = realpathSync(root);
  assert(realpathSync(top) === repo, '--repoはGit checkoutのルートを指定してください');
  await definition.run(repo);
}

try {
  assert(
    process.versions.bun === requiredBun,
    `Bun ${requiredBun}で起動してください（現在: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.version}`}）`,
  );
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const options = separator < 0 ? argv : argv.slice(0, separator);
  if (options.some((arg) => arg === '--help' || arg === '-h')) {
    console.log(usage);
    process.exit(0);
  }
  if (argv[0] === 'execute-child') {
    await runMonitor();
  } else {
    await setup(argv);
  }
} catch (error) {
  console.error(`setup-feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
