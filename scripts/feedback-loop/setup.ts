import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { classification, assertObject, packageManagerToken, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { errorMessage } from '../shared/values.ts';

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

function gitOutput(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** origin/HEADの指す先を優先し、なければmainとmasterのうち1つだけある方を比較元の候補にする。 */
function defaultBase(root: string): string | null {
  const remoteHead = gitOutput(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (remoteHead) {
    return remoteHead;
  }
  for (const prefix of ['refs/remotes/origin/', 'refs/heads/']) {
    const found = ['main', 'master'].filter(
      (name) =>
        gitOutput(root, ['rev-parse', '--verify', '--quiet', `${prefix}${name}`]) !== undefined,
    );
    if (found.length > 0) {
      return found.length === 1 ? `${prefix === 'refs/heads/' ? '' : 'origin/'}${found[0]}` : null;
    }
  }
  return null;
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
    ['bun.lockb', 'bun'],
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

/** スキルに同梱した生成物から、対象repoへ置くファイルを組み立てる。 */
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

/** 対象repoのpackage.jsonへ接続する、runnerから決まるコマンド。 */
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

/** 未コミットの変更がある場合は、配置前に停止する。 */
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
  if (existsSync(join(root, 'scripts/feedback-loop/generated.json'))) {
    console.log('scripts/feedback-loop/generated.jsonは使われなくなったため削除して構いません');
  }
  reportConnectionDiffs(inspected, runtimeCommands(config));
  writeFiles(root, updates);
  console.log(
    updates.size === 0
      ? '生成物は最新です。変更しません'
      : '生成物を更新しました。check:classificationとcheck:feedbackを実行して確認してください',
  );
}

async function apply(root: string, inspected: Inspection, feedback: string | undefined) {
  assert(inspected.packageManager, 'package managerを選択できません');
  assert(feedback && feedback.trim(), '--feedback-commandに診断用コマンドを指定してください');
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
  ]
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(' ');
  await classification(root, config, join(import.meta.dir, 'runtime.mjs'), retryCommand);
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
  console.log(JSON.stringify({ scripts: commands }));
  writeFiles(root, updates);
  console.log('補助ファイルを配置しました');
  console.log(
    '静的検査・通常check・CI・AGENTS.mdの指示の接続と動作確認は導入担当が完了してください',
  );
}

const usage = `使い方: bun setup.mjs <操作> --repo <Git checkoutの絶対パス> [引数]

操作:
  inspect   構成を調べてJSONで表示します。ファイルは変更しません
  install   不足する固定版の依存を導入します
            --package <oxlint|oxfmt|fallow>@<版>（複数指定可）
  apply     .feedback-loop.jsonを読み、補助ファイルとpackage scriptsを配置します
            --feedback-command <check:feedbackに設定する診断用コマンド>
            --update  導入済みの生成物を更新します。--feedback-commandとは併用しません

共通:
  --repo <パス>   対象Git checkoutのルートの絶対パス
  -h, --help      この一覧を表示します`;

type Options = {
  operation: string | undefined;
  root: string;
  feedback: string | undefined;
  updating: boolean;
  packages: string[];
};

function parseOptions([operation, ...args]: string[]): Options {
  let root: string | undefined,
    feedback: string | undefined,
    updating = false;
  const packages: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--update') {
      updating = true;
      continue;
    }
    i += 1;
    const value = args[i];
    assert(value, `${key}の値がありません`);
    if (key === '--repo') {
      assert(root === undefined, '--repoが重複しています');
      root = value;
    } else if (key === '--feedback-command') {
      assert(feedback === undefined, '--feedback-commandが重複しています');
      feedback = value;
    } else {
      assert(key === '--package', `未対応の引数: ${key}`);
      packages.push(value);
    }
  }
  assert(root && isAbsolute(root), '--repoにGit checkoutの絶対パスが必要です');
  assert(!updating || operation === 'apply', '--updateはapplyだけで指定できます');
  assert(!updating || feedback === undefined, '--updateと--feedback-commandは併用できません');
  return { operation, root, feedback, updating, packages };
}

function repoRoot(root: string) {
  const top = gitOutput(root, ['rev-parse', '--show-toplevel']);
  assert(top !== undefined, '--repoはGit checkoutのルートを指定してください');
  // gitはリンクを解決したパスを返すため、macOSの/tmpなどのリンクを含むパスも解決してから比べる。
  const repo = realpathSync(root);
  assert(realpathSync(top) === repo, '--repoはGit checkoutのルートを指定してください');
  return repo;
}

async function runOperation({ operation, root, feedback, updating, packages }: Options) {
  const repo = repoRoot(root);
  const inspected = inspect(repo);
  if (operation === 'inspect') {
    const { pkg: _pkg, ...report } = inspected;
    console.log(JSON.stringify(report, null, 2));
  } else if (operation === 'install') {
    install(repo, inspected, packages);
  } else {
    assert(operation === 'apply', '操作はinspect・install・applyです');
    if (updating) {
      update(repo, inspected);
    } else {
      await apply(repo, inspected, feedback);
    }
  }
}

try {
  assert(
    typeof requiredBun === 'string',
    '正本のsetup.tsは直接実行できません。生成したplugins/setup-feedback-loop/skills/setup-feedback-loop/scripts/setup.mjsを同じ引数で実行してください',
  );
  assert(
    process.versions.bun === requiredBun,
    `Bun ${requiredBun}で起動してください（現在: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.version}`}）`,
  );
  const argv = process.argv.slice(2);
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    console.log(usage);
    process.exit(0);
  }
  await runOperation(parseOptions(argv));
} catch (error) {
  console.error(`setup-feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
