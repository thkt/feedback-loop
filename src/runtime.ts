import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { classification, readConfig } from './config.ts';
import { runBunTests } from './bun.ts';
import { runVitestTests } from './vitest.ts';
import { changedFiles, defaultBase, mergeBase } from './git.ts';
import { commandRunner, runMonitor } from './command.ts';
import { errorMessage } from './values.ts';

// 導入時に判定したpackage managerを、生成時のdefineで埋め込みます。
declare const targetPackageManager: 'bun' | 'npm';
const run = commandRunner(
  fileURLToPath(import.meta.url),
  `${targetPackageManager} run test:affected`,
);

try {
  const root = process.cwd();
  const operation = process.argv[2];
  if (operation === 'execute-child') {
    await runMonitor();
  } else {
    assert(
      operation === 'classification' || operation === 'affected',
      '操作はclassificationまたはaffectedです',
    );
    if (operation === 'classification') {
      const args = process.argv.slice(3);
      assert(args.length === 0, `classificationは引数を取りません: ${args.join(' ')}`);
    }
    const config = readConfig(root);
    if (operation === 'classification') {
      console.log(JSON.stringify(await classification(root, config, run), null, 2));
    } else {
      const changes = (async () => {
        const base = config.base ?? defaultBase(root);
        assert(
          base,
          '比較元を決められません。.feedback-loop.jsonにbaseを指定してください: origin/HEADがなく、mainとmasterが両方あるか、どちらもありません',
        );
        const comparison = await mergeBase(root, base);
        return { comparison, changed: await changedFiles({ root, comparison }) };
      })();
      const [collected, compared] = await Promise.allSettled([
        classification(root, config, run),
        changes,
      ]);
      // 両方失敗しても、従来どおり収集の診断を先に返します。
      if (collected.status === 'rejected') {
        throw collected.reason;
      }
      if (compared.status === 'rejected') {
        throw compared.reason;
      }
      const classes = collected.value;
      const { comparison, changed } = compared.value;
      console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
      assert(changed.length > 0, '変更なし: テストを実行しません');
      assert(classes.quality.length > 0, '候補0件: qualityがありません');
      if (config.prepare.length > 0) {
        await run(config.prepare);
      }
      const ctx = { root, config, comparison, quality: classes.quality, changed, run };
      await (config.runner === 'bun' ? runBunTests : runVitestTests)(ctx);
      console.log('選択したqualityが成功しました。全体checkの成功ではありません');
    }
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
