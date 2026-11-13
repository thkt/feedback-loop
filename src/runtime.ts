import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { affectedChanges, comparisonBase, existingChanges } from './changes.ts';
import { classification } from './classification.ts';
import { isAssurance, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { runtimePath } from './installed.ts';
import type { PackageManager } from './installed.ts';
import { runBunTests } from './bun.ts';
import { runVitestTests } from './vitest.ts';
import { commandRunner, ReportedFailure, reportedExitCode, runMonitor } from './command.ts';
import type { Run } from './command.ts';
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

// scriptの本文が、実行部のその操作を呼ぶか。実行部のパスは引用して書ける。
function callsOperation(script: unknown, operation: Operation) {
  return (
    typeof script === 'string' &&
    script
      .split(runtimePath)
      .slice(1)
      .some((rest) => new RegExp(`^["']?\\s+${operation}(\\s|$)`).test(rest))
  );
}

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
  const candidates = [
    process.env.npm_lifecycle_event ?? '',
    `test:${operation}`,
    ...Object.keys(scripts),
  ];
  return candidates.find((name) => callsOperation(scripts[name], operation)) ?? connected;
}

// script名の後に引数を渡すときの区切り。npmは--の後の引数だけをscriptへ渡す。
const argumentSeparator: Record<PackageManager, string> = { bun: '', npm: ' --', pnpm: '' };

// 診断が案内する再実行のコマンド。optionsは実行時の指定で、同じ指定で再実行できる形で足す。
function retryCommand(root: string, operation: Operation, options: string[]) {
  if (operation !== 'changed') {
    const suffix =
      options.length === 0
        ? ''
        : `${argumentSeparator[targetPackageManager]} ${options.map(shellQuote).join(' ')}`;
    return `${targetPackageManager} run ${retryScript(root, operation)}${suffix}`;
  }
  // changedを呼ぶscriptは導入先が書き、lintとformatのように複数ある。どれを起動したかは、script名からしか分からない。
  // package managerが起動したscriptがchangedを呼んでいれば、その名前を案内する。
  // なければ起動したコマンドをそのまま案内する。この場合、コマンドはnode_modules/.binを探さない。
  const name = process.env.npm_lifecycle_event ?? '';
  // scriptから起動したシェルは、changedを呼ばないscriptの名前をnpm_lifecycle_eventで引き継ぐ。
  return callsOperation(packageScripts(root)[name], operation)
    ? `${targetPackageManager} run ${name}`
    : [basename(process.execPath), ...process.argv.slice(1)].map(shellQuote).join(' ');
}

function showOverride(override: string | undefined) {
  if (override !== undefined) {
    console.log(`比較元: ${override}（実行時の指定）`);
  }
}

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

// classificationの引数から、件数の代わりにパスの一覧をJSONで出す指定を読む。
// pnpmは、script名の後に書いた--をそのまま渡す。
function jsonRequested(args: string[]) {
  const options = args.filter((arg) => arg !== '--');
  assert(
    options.every((option) => option === '--json'),
    `classificationの指定は--jsonだけです: ${args.join(' ')}`,
  );
  return options.length > 0;
}

// changedの引数のうち、--の前に書いた補助への指定を読む。
// extensionsは対象の拡張子、baseはこの実行だけの比較元で、どちらも指定がなければundefinedである。
function changedOptions(options: string[]) {
  let values: { ext?: string[]; base?: string };
  try {
    values = parseArgs({
      args: options,
      options: { ext: { type: 'string', multiple: true }, base: { type: 'string' } },
    }).values;
  } catch {
    // parseArgsは、次が-で始まる--baseを、値のない指定として拒否する。
    const valueless = options.some(
      (option, index) => option === '--base' && (options[index + 1] ?? '-').startsWith('-'),
    );
    assert(!valueless, `--baseには参照を指定してください: ${options.join(' ')}`);
    assert.fail(`changedの指定は--ext <拡張子>と--base <参照>だけです: ${options.join(' ')}`);
  }
  assert(values.base !== '', `--baseには参照を指定してください: ${options.join(' ')}`);
  return { extensions: extensionsFrom(values.ext), base: values.base };
}

function extensionsFrom(values: string[] | undefined) {
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
async function runOnChanged(root: string, config: FeedbackConfig, run: Run, args: string[]) {
  const separator = args.indexOf('--');
  assert(
    separator !== -1 && separator < args.length - 1,
    'changedは「changed [--ext <拡張子>] [--base <参照>] -- <コマンド>」の形で呼びます',
  );
  const { extensions, base } = changedOptions(args.slice(0, separator));
  const command = args.slice(separator + 1);
  const files = (await existingChanges(root, config, base))
    .filter(
      (path) =>
        (extensions === undefined || extensions.some((extension) => path.endsWith(extension))) &&
        // 作業ツリーで消しただけのファイルと、ディレクトリになったパスを除く。
        isFile(join(root, path)),
    )
    .sort()
    // -で始まる名前を、コマンドがオプションとして読まないようにする。
    .map((path) => (path.startsWith('-') ? `./${path}` : path));
  showOverride(base);
  if (files.length === 0) {
    console.log(`変更したファイルがありません。コマンドを実行しません: ${command.join(' ')}`);
    return;
  }
  for (const batch of batches(files)) {
    // 実行の表示に全パスを並べると、診断を読むエージェントの文脈を埋める。先頭だけを表示する。
    const shown = batch.slice(0, shownFiles);
    const rest = batch.length - shown.length;
    // 失敗した回で止め、実行の表示の順を保つため、並行に実行しません。
    // oxlint-disable-next-line no-await-in-loop
    await run([...command, ...batch], {
      display: [...command, ...shown, ...(rest > 0 ? [`…ほか${rest}件`] : [])],
    });
  }
}

async function affected(root: string, config: FeedbackConfig, run: Run, override?: string) {
  // 比較元を決められないか読めなければ、収集を始める前に止めます。
  const base = comparisonBase(root, config, override);
  const [collected, compared] = await Promise.allSettled([
    classification(root, config, run),
    affectedChanges(root, base, targetPackageManager),
  ]);
  // 両方失敗したときに診断が完了順で入れ替わらないよう、収集の診断を先に返します。
  if (collected.status === 'rejected') {
    throw collected.reason;
  }
  if (compared.status === 'rejected') {
    throw compared.reason;
  }
  const classes = collected.value;
  const { changed, outside } = compared.value;
  showOverride(override);
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
  const ctx = { root, config, quality: classes.quality, changes: compared.value, run };
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
    const json = operation === 'classification' && jsonRequested(args);
    const options = [
      ...(override === undefined ? [] : ['--base', override]),
      ...(json ? ['--json'] : []),
    ];
    const run = commandRunner(
      fileURLToPath(import.meta.url),
      retryCommand(root, operation, options),
    );
    if (operation === 'classification') {
      const classes = await classification(root, readConfig(root), run);
      // 全体checkとCIは、成功するたびにこの出力を読む。パスの一覧は、求められたときだけ出す。
      console.log(
        json
          ? JSON.stringify(classes, null, 2)
          : `分類: all ${classes.all.length}件、quality ${classes.quality.length}件、assurance ${classes.assurance.length}件（パスの一覧: ${retryCommand(root, operation, ['--json'])}）`,
      );
    } else if (operation === 'changed') {
      await runOnChanged(root, readConfig(root), run, args);
    } else {
      await affected(root, readConfig(root), run, override);
    }
  }
} catch (error) {
  if (!(error instanceof ReportedFailure)) {
    console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  }
  // 監視プロセスは、診断を表示したことを、終了コードで起動した側へ伝える。
  process.exitCode = process.argv[2] === 'execute-child' ? reportedExitCode : 1;
}
