import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { classification } from './classification.ts';
import { readConfig } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import type { PackageManager } from './installed.ts';
import { runBunTests } from './bun.ts';
import { runVitestTests } from './vitest.ts';
import { changesSince, defaultBase } from './git.ts';
import { commandRunner, runMonitor } from './command.ts';
import { errorMessage } from './values.ts';

// 導入時に判定したpackage managerを、生成時のdefineで埋め込みます。
declare const targetPackageManager: PackageManager;
const run = commandRunner(
  fileURLToPath(import.meta.url),
  `${targetPackageManager} run test:affected`,
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
  const ctx = { root, config, comparison, quality: classes.quality, changed, outside, run };
  const outcome = await (config.runner === 'bun' ? runBunTests : runVitestTests)(ctx);
  assert(outcome !== 'none', '変更なし: テストを実行しません');
  // 利用者が影響しないと宣言した変更だけなら、実行するテストがないことは失敗ではありません。
  console.log(
    outcome === 'ignored'
      ? '変更なし: ignoredChangesに当たる変更だけのため、テストを実行していません'
      : '選択したqualityが成功しました。全体checkの成功ではありません',
  );
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
