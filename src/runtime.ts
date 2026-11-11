import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classification } from './classification.ts';
import { isAssurance, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import type { PackageManager } from './installed.ts';
import { runBunTests } from './bun.ts';
import { runVitestTests } from './vitest.ts';
import { changesSince, defaultBase } from './git.ts';
import { commandRunner, runMonitor } from './command.ts';
import { errorMessage, isRecord } from './values.ts';

// 導入時に判定したpackage managerを、生成時のdefineで埋め込みます。
declare const targetPackageManager: PackageManager;
const runtimeScript = 'scripts/feedback-loop/runtime.mjs';

/** 再実行の案内に出すscript名。利用者が呼んだscriptを指します。 */
function retryScript(root: string, operation: string): string {
  const connected = operation === 'classification' ? 'check:classification' : 'check:affected';
  let scripts: Record<string, unknown> = {};
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (isRecord(pkg) && isRecord(pkg.scripts)) {
      scripts = pkg.scripts;
    }
  } catch {
    // package.jsonを読めない場合は、applyが接続する名前を案内します。案内のために実行を止めません。
  }
  const calls = (name: string, command: string) => {
    const script = scripts[name];
    return typeof script === 'string' && script.includes(command);
  };
  // npm 11.20.0・pnpm 12.18.0・Bun 1.4.4は、実行中のscript名をnpm_lifecycle_eventで渡します。
  // npxは「npx」を設定し、外側のscriptの名前を引き継ぐ場合もあるため、runtimeを呼ぶscriptの名前だけを使います。
  const invoked = process.env.npm_lifecycle_event;
  if (invoked !== undefined && calls(invoked, runtimeScript)) {
    return invoked;
  }
  // package managerを介さない実行では、同じ操作を呼ぶscriptを探します。改名前の名前だけの導入先でも案内が動きます。
  const sameOperation = `${runtimeScript} ${operation}`;
  return (
    [connected, ...Object.keys(scripts)].find((name) => calls(name, sameOperation)) ?? connected
  );
}

const run = commandRunner(
  fileURLToPath(import.meta.url),
  `${targetPackageManager} run ${retryScript(process.cwd(), process.argv[2] ?? 'affected')}`,
);

async function affected(root: string, config: FeedbackConfig) {
  const changes = (async () => {
    const comparison = config.base === undefined ? defaultBase(root) : { base: config.base };
    if (comparison.base === null) {
      assert.fail(
        `比較元を決められません。.feedback-loop.jsonにbaseを指定してください: ${comparison.reason}`,
      );
    }
    return changesSince(root, comparison.base);
  })();
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
      `assuranceのテストファイルはcheck:affectedの実行対象に選びません。全体checkとCIで実行します: ${assurance.join(', ')}`,
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
    ...(outcome.ignored ? ['ignoredChangesに当たる変更'] : []),
    ...(outcome.assurance ? ['assuranceのテストファイルの変更'] : []),
  ];
  console.log(`変更なし: ${subjects.join('と')}だけのため、テストを実行していません`);
}

try {
  const root = process.cwd();
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'execute-child') {
    await runMonitor();
  } else if (operation === 'classification') {
    assert(args.length === 0, `classificationは引数を取りません: ${args.join(' ')}`);
    console.log(JSON.stringify(await classification(root, readConfig(root), run), null, 2));
  } else {
    assert(operation === 'affected', '操作はclassificationまたはaffectedです');
    await affected(root, readConfig(root));
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
