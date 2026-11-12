import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classification } from './classification.ts';
import { isAssurance, readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { runtimePath } from './installed.ts';
import { ancestorLockfileCandidates, fromRoot } from './lockfiles.ts';
import type { PackageManager } from './installed.ts';
import { runBunTests } from './bun.ts';
import { runVitestTests } from './vitest.ts';
import { changesSince, defaultBase } from './git.ts';
import { commandRunner, runMonitor } from './command.ts';
import { errorMessage, isRecord } from './values.ts';

// 導入時に判定したpackage managerを、生成時のdefineで埋め込みます。
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

/** 再実行の案内に出すscript名。 */
function retryScript(root: string, operation: 'affected' | 'classification'): string {
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

type Run = ReturnType<typeof commandRunner>;

async function affected(root: string, config: FeedbackConfig, run: Run) {
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
  const { comparison, top } = compared.value;
  // rootにlockfileがない構成では、rootのpackageは祖先のlockfileを使います。
  // そのlockfileの変更と削除は、rootの中のlockfileと同じく全qualityを実行する理由にします。
  const candidates = ancestorLockfileCandidates(root, top, targetPackageManager);
  const lockfiles = candidates.filter((path) =>
    compared.value.outside.some((changed) => fromRoot(root, changed) === path),
  );
  const changed = [...compared.value.changed, ...lockfiles];
  const outside = compared.value.outside.filter(
    (path) => !lockfiles.includes(fromRoot(root, path)),
  );
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
  const ctx = {
    root,
    config: { ...config, globalChanges: [...config.globalChanges, ...lockfiles] },
    comparison,
    quality: classes.quality,
    changed,
    outside,
    ancestorLockfiles: candidates.filter((path) => existsSync(join(root, path))),
    run,
  };
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
      operation === 'classification' || operation === 'affected',
      '操作はclassificationまたはaffectedです',
    );
    const run = commandRunner(
      fileURLToPath(import.meta.url),
      `${targetPackageManager} run ${retryScript(root, operation)}`,
    );
    if (operation === 'classification') {
      assert(args.length === 0, `classificationは引数を取りません: ${args.join(' ')}`);
      console.log(JSON.stringify(await classification(root, readConfig(root), run), null, 2));
    } else {
      await affected(root, readConfig(root), run);
    }
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
