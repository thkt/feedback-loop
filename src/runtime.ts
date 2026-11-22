import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  affectedChanges,
  baseVariable,
  comparisonBase,
  existingChanges,
  runtimeBase,
} from './changes.ts';
import type { ComparisonBase, RuntimeBase } from './changes.ts';
import { classification } from './classification.ts';
import { isAssurance, isFile, mutantsRecordFile, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { runtimePath } from './installed.ts';
import type { PackageManager } from './installed.ts';
import { runBunTests } from './bun.ts';
import { runVitestTests } from './vitest.ts';
import { commandRunner, ReportedFailure, reportedExitCode, runMonitor } from './command.ts';
import type { Run } from './command.ts';
import { readEquivalents } from './equivalents.ts';
import { changesOutsideImprovement, mutation, mutationByKey } from './mutation.ts';
import { restoreRemaining } from './mutation-guard.ts';
import type {
  KeyReport,
  KeyRequest,
  MutationReport,
  MutationRequest,
  RecordMatch,
} from './mutation.ts';
import { errorMessage, isRecord, shellQuote } from './values.ts';

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

type Operation = 'affected' | 'classification' | 'changed' | 'mutation';

// applyがcheck:<操作>の名前で接続する操作。
type ConnectedOperation = 'affected' | 'classification';

function isConnected(operation: Operation): operation is ConnectedOperation {
  return operation === 'affected' || operation === 'classification';
}

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
function retryScript(root: string, operation: ConnectedOperation): string {
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
  if (isConnected(operation)) {
    const suffix =
      options.length === 0
        ? ''
        : `${argumentSeparator[targetPackageManager]} ${options.map(shellQuote).join(' ')}`;
    return `${targetPackageManager} run ${retryScript(root, operation)}${suffix}`;
  }
  // mutationを呼ぶscriptは、モジュールを書き込んでいることがある。script名に引数を足すと二重になるため、起動したコマンドをそのまま案内する。
  if (operation === 'mutation') {
    return [basename(process.execPath), ...process.argv.slice(1)].map(shellQuote).join(' ');
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

// 実行時に指定した比較元は、出どころを添えて表示する。alwaysなら、設定と既定の規則で決めた比較元も表示する。
function showBase(base: ComparisonBase, always = false) {
  if (base.runtime !== undefined || always) {
    console.log(`比較元: ${base.ref}（${base.runtime ?? base.subject}）`);
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

// changedの引数を、--の前の補助への指定と、--の後の実行するコマンドに分ける。
function changedRequest(args: string[]) {
  const separator = args.indexOf('--');
  assert(
    separator !== -1 && separator < args.length - 1,
    'changedは「changed [--ext <拡張子>] [--base <参照>] -- <コマンド>」の形で呼びます',
  );
  return { ...changedOptions(args.slice(0, separator)), command: args.slice(separator + 1) };
}

// 分岐点以降に変更した実在するファイルを、コマンドの引数に足して実行する。
// 対象が0件ならコマンドを実行しない。引数のないlintやformatterは、全ファイルを対象にするためである。
async function runOnChanged(
  root: string,
  config: FeedbackConfig,
  run: Run,
  { extensions, command }: ReturnType<typeof changedRequest>,
  specified: RuntimeBase | undefined,
) {
  const comparison = comparisonBase(root, config, specified);
  const files = (await existingChanges(root, comparison))
    .filter(
      (path) =>
        (extensions === undefined || extensions.some((extension) => path.endsWith(extension))) &&
        // 作業ツリーで消しただけのファイルと、ディレクトリになったパスを除く。
        isFile(join(root, path)),
    )
    .sort()
    // -で始まる名前を、コマンドがオプションとして読まないようにする。
    .map((path) => (path.startsWith('-') ? `./${path}` : path));
  // 対象が0件のときは、どの比較元で0件だったかを、指定がなくても表示する。
  // scriptの名前の後に足した--baseは、実行するコマンドへ渡り、比較元にならない。
  showBase(comparison, files.length === 0);
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

async function affected(
  root: string,
  config: FeedbackConfig,
  run: Run,
  specified: RuntimeBase | undefined,
) {
  // 比較元を決められないか読めなければ、収集を始める前に止めます。
  const base = comparisonBase(root, config, specified);
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
  showBase(base);
  console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
  // Vitestは外の変更からもテストへ届くため、届くかどうかを選択の後に判定します。
  assert(
    changed.length > 0 || (config.runner === 'vitest' && outside.length > 0),
    '変更なし: テストを実行しません',
  );
  // 壊し方の記録ファイルはテストを選ぶ理由にしないため、変えたときに形だけを確かめます。
  if (changed.includes(mutantsRecordFile)) {
    readEquivalents(root);
  }
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
  // 影響しないと宣言した変更と、壊し方の記録ファイルと、このコマンドで実行しないassuranceの変更だけなら、実行するテストがないことは失敗ではありません。
  const subjects = [
    ...(outcome.ignored.length > 0 ? ['ignoredChangesに当たる変更'] : []),
    ...(outcome.mutantsRecord.length > 0 ? ['壊し方の記録ファイルの変更'] : []),
    ...(outcome.assurance.length > 0 ? ['assuranceのテストファイルの変更'] : []),
    ...(outcome.assuranceReach.length > 0 ? ['assuranceのテストにしか届かない変更'] : []),
  ];
  console.log(`変更なし: ${subjects.join('と')}だけのため、テストを実行していません`);
}

// mutationの引数を、対象のモジュールか確かめる鍵と、最初に走らせるテストに分ける。
// pnpmは、script名の後に書いた--をそのまま渡す。
function mutationRequest(
  args: string[],
): MutationRequest | KeyRequest | 'check-changes' | 'restore' {
  const usage = `mutationは「mutation <モジュール> [--tests <テストファイル>...]」か「mutation --key <鍵> --tests <テストファイル>...」か「mutation --check-changes」か「mutation --restore」の形で呼びます: ${args.join(' ')}`;
  const given = args.filter((arg) => arg !== '--');
  for (const [flag, request] of [
    ['--check-changes', 'check-changes'],
    ['--restore', 'restore'],
  ] as const) {
    if (given.includes(flag)) {
      assert(given.length === 1, usage);
      return request;
    }
  }
  const byKey = given[0] === '--key';
  const [subject, ...options] = byKey ? given.slice(1) : given;
  assert(
    subject !== undefined && (byKey ? subject !== '--tests' : !subject.startsWith('-')),
    usage,
  );
  if (options.length === 0) {
    assert(
      !byKey,
      `--keyで確かめるときは、--testsにテストファイルを渡してください: ${args.join(' ')}`,
    );
    return { module: subject, tests: undefined };
  }
  const [flag, ...tests] = options;
  assert(
    flag === '--tests' && tests.length > 0 && tests.every((test) => !test.startsWith('-')),
    usage,
  );
  return byKey ? { key: subject, tests } : { module: subject, tests };
}

// 一覧を標準出力へ書く。staleは、理由によらず記録から外す。changedの壊し方は記録で除かれず一覧へ戻るので、判断し直すのは一覧の手順のままである。
// staleの案内は、エラーで終わった壊し方があっても先に書く。staleは終了コードを変えない。
function reportList(report: MutationReport) {
  console.log(JSON.stringify(report, null, 2));
  if (report.stale.length > 0) {
    console.error(
      `記録した壊し方のうち${report.stale.length}件を、${mutantsRecordFile}から外してください（理由は一覧のstaleにあります）: ${report.stale.map(({ key }) => key).join(' ')}`,
    );
  }
  assert(
    report.errors.length === 0,
    `エラーで終わった壊し方が${report.errors.length}件あります。errorsのreasonを確かめてください`,
  );
  if (report.survived.length === 0) {
    console.error(
      `改善するものがありません: 既存のテストをすり抜けた壊し方はありません（時間切れ${report.timedOut.length}件）`,
    );
  }
}

// 1件の結果を標準出力へ書く。時間切れは、一覧と同じく拾ったに数える。
function reportKey({ report, record }: { report: KeyReport; record: RecordMatch }) {
  console.log(JSON.stringify(report, null, 2));
  if (record === 'changed') {
    console.error(
      `この鍵の${mutantsRecordFile}の記録は、置き換える前の字が今の壊し方と違い、別の式を指します。記録から外してください: ${report.key}`,
    );
  } else if (record === 'equivalent' && report.verdict === 'killed') {
    console.error(
      `この鍵は${mutantsRecordFile}に記録されていますが、渡したテストが拾いました。記録から外してください: ${report.key}`,
    );
  }
  assert(
    report.verdict !== 'survived',
    `渡したテストは、この壊し方を拾いません（survived）: ${report.key}`,
  );
  if (report.verdict === 'error') {
    assert.fail(`壊し方がエラーで終わりました: ${report.reason}`);
  }
}

function reportOutside(outside: string[]) {
  assert(
    outside.length === 0,
    `改善の処理が変えてよいファイルの外の変更があります: ${outside.join(', ')}`,
  );
  console.error('改善の処理が変えてよいファイルの外の変更はありません');
}

// 再実行の案内を添えて、コマンドの実行部を作る。optionsとspecifiedは実行時の指定で、同じ指定で再実行できる形で足す。
function runnerFor(root: string, operation: Operation, options: string[], specified?: RuntimeBase) {
  // 環境変数で指定した比較元は、再実行の案内の先頭に同じ指定を付ける。
  const assignment =
    specified?.from === 'environment' ? `${baseVariable}=${shellQuote(specified.ref)} ` : '';
  return commandRunner(
    fileURLToPath(import.meta.url),
    assignment + retryCommand(root, operation, options),
  );
}

// 操作ごとに、引数を読んでから実行する。
const operations: Record<Operation, (root: string, args: string[]) => Promise<void>> = {
  // classificationは比較元を使わない。
  async classification(root, args) {
    const json = jsonRequested(args);
    const run = runnerFor(root, 'classification', json ? ['--json'] : []);
    // 全体checkとCIは、記録ファイルがあればその形も確かめる。
    readEquivalents(root);
    const classes = await classification(root, readConfig(root), run);
    // 全体checkとCIは、成功するたびにこの出力を読む。パスの一覧は、求められたときだけ出す。
    console.log(
      json
        ? JSON.stringify(classes, null, 2)
        : `分類: all ${classes.all.length}件、quality ${classes.quality.length}件、assurance ${classes.assurance.length}件（パスの一覧: ${retryCommand(root, 'classification', ['--json'])}）`,
    );
  },
  async affected(root, args) {
    const specified = runtimeBase(baseOverride(args));
    const options = specified?.from === 'option' ? ['--base', specified.ref] : [];
    const run = runnerFor(root, 'affected', options, specified);
    await affected(root, readConfig(root), run, specified);
  },
  async changed(root, args) {
    const request = changedRequest(args);
    const specified = runtimeBase(request.base);
    const run = runnerFor(root, 'changed', [], specified);
    await runOnChanged(root, readConfig(root), run, request, specified);
  },
  // 標準出力には一覧のJSONだけを書く。実行の表示と進み具合は、標準エラーへ書く。
  async mutation(root, args) {
    const request = mutationRequest(args);
    if (request === 'check-changes') {
      reportOutside(await changesOutsideImprovement(root, readConfig(root)));
      return;
    }
    if (request === 'restore') {
      restoreRemaining(root);
      return;
    }
    const run = runnerFor(root, 'mutation', []);
    if ('key' in request) {
      reportKey(await mutationByKey(root, readConfig(root), run, request));
    } else {
      reportList(await mutation(root, readConfig(root), run, request));
    }
  },
};

function isOperation(name: string | undefined): name is Operation {
  return name !== undefined && Object.hasOwn(operations, name);
}

function failWhenOutputCloses() {
  for (const output of [process.stdout, process.stderr]) {
    output.on('error', () => {
      process.exitCode = 1;
    });
  }
}

try {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'execute-child') {
    await runMonitor();
  } else {
    failWhenOutputCloses();
    assert(
      isOperation(operation),
      '操作はclassification・affected・changed・mutationのいずれかです',
    );
    await operations[operation](process.cwd(), args);
  }
} catch (error) {
  if (!(error instanceof ReportedFailure)) {
    console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  }
  // 監視プロセスは、診断を表示したことを、終了コードで起動した側へ伝える。
  process.exitCode = process.argv[2] === 'execute-child' ? reportedExitCode : 1;
}
