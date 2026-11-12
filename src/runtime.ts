import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classification } from './classification.ts';
import { isAssurance, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { runtimePath } from './installed.ts';
import type { PackageManager } from './installed.ts';
import { runBunTests } from './bun.ts';
import { runVitestTests } from './vitest.ts';
import { changesSince, defaultBase, resolveCommit } from './git.ts';
import { commandRunner, runMonitor } from './command.ts';
import { errorMessage, hasErrorCode, isRecord, shellQuote } from './values.ts';

// 導入時に判定したpackage managerを、生成時のdefineで埋め込みます。
// 生成の時点では置き換え前の文字列なので、=== 'npm'のような比較は定数として畳まれ、導入後も偽のままになります。
// 値で分ける処理は、argumentSeparatorのように表を引きます。
declare const targetPackageManager: PackageManager;
function packageScripts(root: string): Record<string, unknown> {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : {};
  } catch {
    // package.jsonを読めない場合は、applyが接続する名前を案内します。案内のために実行を止めません。
    return {};
  }
}

type Operation = 'affected' | 'classification' | 'changed';

/** 再実行の案内に出すscript名。 */
function retryScript(root: string, operation: Exclude<Operation, 'changed'>): string {
  const connected = `check:${operation}`;
  const scripts = packageScripts(root);
  // applyが接続する名前があれば、その名前を案内します。その名前のscriptが別のscriptを包んでいても、内側の名前を案内しません。
  if (typeof scripts[connected] === 'string') {
    return connected;
  }
  // 接続する名前がない導入先では、同じ操作を呼ぶscriptを探します。改名前のtest:affectedだけの導入先がこれに当たります。
  // npm 11.20.0・pnpm 12.18.0・Bun 1.4.4は、実行中のscript名をnpm_lifecycle_eventで渡します。
  // npxは「npx」を設定し、外側のscriptの名前を引き継ぐ場合もあるため、同じ操作を呼ぶscriptの名前だけを使います。
  const sameOperation = `${runtimePath} ${operation}`;
  const candidates = [
    process.env.npm_lifecycle_event ?? '',
    `test:${operation}`,
    ...Object.keys(scripts),
  ];
  return (
    candidates.find((name) => {
      const script = scripts[name];
      return typeof script === 'string' && script.includes(sameOperation);
    }) ?? connected
  );
}

// 診断が案内する再実行のコマンド。
function retryCommand(root: string, operation: Operation) {
  if (operation !== 'changed') {
    return `${targetPackageManager} run ${retryScript(root, operation)}`;
  }
  // changedを呼ぶscriptは導入先が書き、lintとformatのように複数ある。どれを起動したかは、script名からしか分からない。
  // package managerが起動したscriptがあれば、その名前を案内する。
  // なければ起動したコマンドをそのまま案内する。この場合、コマンドはnode_modules/.binを探さない。
  const name = process.env.npm_lifecycle_event ?? '';
  return typeof packageScripts(root)[name] === 'string'
    ? `${targetPackageManager} run ${name}`
    : [basename(process.execPath), ...process.argv.slice(1)].map(shellQuote).join(' ');
}

type Run = ReturnType<typeof commandRunner>;

// script名の後に引数を渡すときの区切り。npmは--の後の引数だけをscriptへ渡す。
const argumentSeparator: Record<PackageManager, string> = { bun: '', npm: ' --', pnpm: '' };

// affectedの引数から、この実行だけの比較元を読む。指定がなければundefinedを返す。
// --base以外の引数は読まない。hookが足すファイルのパスなどを、引数として受け取る導入先があるためである。
function baseOverride(args: string[]) {
  // scriptに書いた--baseより、実行時に足した--baseを優先する。
  const index = args.findLastIndex((arg) => arg === '--base' || arg.startsWith('--base='));
  if (index === -1) {
    // npmは、--の前に書いた--baseを自分の設定として読み、参照だけをscriptへ渡す。
    // 設定や外側のscriptから引き継いだだけのnpm_config_baseでは止めないよう、渡った引数がある場合に限る。
    assert(
      !(
        argumentSeparator[targetPackageManager] !== '' &&
        process.env.npm_config_base === 'true' &&
        args.length > 0
      ),
      `npmが--baseを自分の設定として読み、参照だけを渡しました（${args.join(' ')}）。check:affectedを呼ぶscriptを「npm run <script> -- --base <参照>」の形で直接呼んでください`,
    );
    return undefined;
  }
  const option = args[index] ?? '';
  const base = option === '--base' ? args[index + 1] : option.slice('--base='.length);
  assert(base, `--baseには参照を指定してください: ${args.join(' ')}`);
  return base;
}

// 実行時の比較元を、同じ比較元で再実行できる形で足す。
function retryArguments(override: string | undefined) {
  return override === undefined
    ? ''
    : `${argumentSeparator[targetPackageManager]} --base ${shellQuote(override)}`;
}

// .feedback-loop.jsonのbaseか既定の規則で比較元を決め、そこからの変更を返す。
async function configuredChanges(root: string, config: FeedbackConfig, existingOnly = false) {
  const comparison = config.base === undefined ? defaultBase(root) : { base: config.base };
  if (comparison.base === null) {
    assert.fail(
      `比較元を決められません。.feedback-loop.jsonにbaseを指定してください: ${comparison.reason}`,
    );
  }
  return changesSince(root, comparison.base, existingOnly);
}

// changedの引数のうち、--の前に書いた補助への指定から、対象の拡張子を読む。指定がなければundefinedを返す。
function changedExtensions(options: string[]) {
  let values: string[] | undefined;
  try {
    values = parseArgs({ args: options, options: { ext: { type: 'string', multiple: true } } })
      .values.ext;
  } catch {
    assert.fail(`changedの指定は--ext <拡張子>だけです: ${options.join(' ')}`);
  }
  if (values === undefined) {
    return undefined;
  }
  // 複数の--extは、すべての拡張子を対象にする。
  const extensions = values
    .flatMap((value) => value.split(','))
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`));
  // どのパスにも当たらない指定は、lintを実行しないまま成功にする。globや空白を含む指定を受け取らない。
  assert(
    extensions.every((extension) => /^\.[\w.-]+$/.test(extension)),
    `--extには拡張子をカンマ区切りで指定してください: ${values.join(' ')}`,
  );
  return extensions;
}

// gitは、ファイルでないパスも変更として返す。壊れたsymlink、ディレクトリへのsymlink、入れ子のrepoがこれに当たる。
// ディレクトリを渡されたlintは、その中の全ファイルを対象にする。
function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    // 実在しないパスだけを対象から外す。親がファイルに変わったパスは、BunではENOTDIRになる。
    // 権限がないなど、読めない理由がほかにあれば、対象0件の成功にせず失敗させる。
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

// 実行の表示に並べるファイルの数。
const shownFiles = 20;

// OSは、1回のコマンドに渡せる引数の長さを制限する（macOSは環境変数と合わせて1MiB）。
// パスの長さの合計が上限に届かないよう、分けて実行する。
const batchBytes = 100_000;

function batches(files: string[]) {
  const result: string[][] = [];
  let size = 0;
  for (const file of files) {
    const length = Buffer.byteLength(file) + 1;
    const current = result.at(-1);
    if (current === undefined || size + length > batchBytes) {
      result.push([file]);
      size = length;
    } else {
      current.push(file);
      size += length;
    }
  }
  return result;
}

// 分岐点以降に変更した実在するファイルを、コマンドの引数に足して実行する。
// 対象が0件ならコマンドを実行しない。引数のないlintやformatterは、全ファイルを対象にするためである。
async function changed(root: string, config: FeedbackConfig, run: Run, args: string[]) {
  const separator = args.indexOf('--');
  assert(
    separator !== -1 && separator < args.length - 1,
    'changedは「changed [--ext <拡張子>] -- <コマンド>」の形で呼びます',
  );
  const extensions = changedExtensions(args.slice(0, separator));
  const command = args.slice(separator + 1);
  const changes = await configuredChanges(root, config, true);
  const files = changes.changed
    .filter(
      (path) =>
        (extensions === undefined || extensions.some((extension) => path.endsWith(extension))) &&
        // 作業ツリーで消しただけのファイルと、ディレクトリになったパスを除く。
        isFile(join(root, path)),
    )
    .sort()
    // -で始まる名前を、コマンドがオプションとして読まないようにする。
    .map((path) => (path.startsWith('-') ? `./${path}` : path));
  if (files.length === 0) {
    console.log(`変更したファイルがありません。コマンドを実行しません: ${command.join(' ')}`);
    return;
  }
  for (const batch of batches(files)) {
    // 実行の表示に全パスを並べると、診断を読むエージェントの文脈を埋める。先頭だけを表示する。
    const shown = batch.slice(0, shownFiles);
    const rest = batch.length - shown.length;
    await run([...command, ...batch], {
      display: [...command, ...shown, ...(rest > 0 ? [`…ほか${rest}件`] : [])],
    });
  }
}

async function affected(root: string, config: FeedbackConfig, run: Run, override?: string) {
  // 参照を読めなければ、収集を始める前に止めます。
  const overridden =
    override === undefined ? undefined : resolveCommit(root, override, '--baseに指定した参照');
  const changes =
    overridden === undefined
      ? configuredChanges(root, config)
      : // 浅いcloneや別の履歴の参照は、commitとして読めてもHEADとの分岐点がない。
        changesSince(root, overridden).catch((error: unknown) =>
          assert.fail(
            `--baseに指定した参照とHEADの分岐点を求められません: ${override}（${errorMessage(error)}）`,
          ),
        );
  const [collected, compared] = await Promise.allSettled([
    classification(root, config, run),
    changes,
  ]);
  // 両方失敗したときに診断が完了順で入れ替わらないよう、収集の診断を先に返します。
  if (collected.status === 'rejected') {
    throw collected.reason;
  }
  if (compared.status === 'rejected') {
    throw compared.reason;
  }
  const classes = collected.value;
  const { comparison, changed, outside } = compared.value;
  if (override !== undefined) {
    console.log(`比較元: ${override}（実行時の指定）`);
  }
  console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
  // Vitestは外の変更からもテストへ届くため、届くかどうかを選択の後に判定します。
  assert(
    changed.length > 0 || (config.runner === 'vitest' && outside.length > 0),
    '変更なし: テストを実行しません',
  );
  assert(classes.quality.length > 0, '候補0件: qualityがありません');
  if (config.prepare.length > 0) {
    await run(config.prepare);
  }
  const assurance = changed.filter((path) => isAssurance(path, config));
  if (assurance.length > 0) {
    console.log(
      `assuranceのテストファイルは、このコマンドの実行対象に選びません。全体checkとCIで実行します: ${assurance.join(', ')}`,
    );
  }
  const ctx = { root, config, comparison, quality: classes.quality, changed, outside, run };
  const outcome = await (config.runner === 'bun' ? runBunTests : runVitestTests)(ctx);
  assert(outcome.kind !== 'none', '変更なし: テストを実行しません');
  if (outcome.kind === 'ran') {
    console.log('選択したqualityが成功しました。全体checkの成功ではありません');
    return;
  }
  // 影響しないと宣言した変更と、このコマンドで実行しないassuranceの変更だけなら、実行するテストがないことは失敗ではありません。
  const subjects = [
    ...(outcome.ignored.length > 0 ? ['ignoredChangesに当たる変更'] : []),
    ...(outcome.assurance.length > 0 ? ['assuranceのテストファイルの変更'] : []),
    ...(outcome.assuranceReach.length > 0 ? ['assuranceのテストにしか届かない変更'] : []),
  ];
  console.log(`変更なし: ${subjects.join('と')}だけのため、テストを実行していません`);
}

try {
  const root = process.cwd();
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'execute-child') {
    await runMonitor();
  } else {
    assert(
      operation === 'classification' || operation === 'affected' || operation === 'changed',
      '操作はclassification・affected・changedのいずれかです',
    );
    const override = operation === 'affected' ? baseOverride(args) : undefined;
    const run = commandRunner(
      fileURLToPath(import.meta.url),
      `${retryCommand(root, operation)}${retryArguments(override)}`,
    );
    if (operation === 'classification') {
      assert(args.length === 0, `classificationは引数を取りません: ${args.join(' ')}`);
      console.log(JSON.stringify(await classification(root, readConfig(root), run), null, 2));
    } else if (operation === 'changed') {
      await changed(root, readConfig(root), run, args);
    } else {
      await affected(root, readConfig(root), run, override);
    }
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
