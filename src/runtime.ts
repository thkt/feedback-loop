import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { classification, readConfig } from './config.ts';
import { runBunTests } from './bun.ts';
import { runVitestTests } from './vitest.ts';
import { changedFiles, defaultBase } from './git.ts';
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
    const classes = await classification(root, config, run);
    if (operation === 'classification') {
      console.log(JSON.stringify(classes, null, 2));
    } else {
      const base = config.base ?? defaultBase(root);
      assert(
        base,
        '比較元を決められません。.feedback-loop.jsonにbaseを指定してください: origin/HEADがなく、mainとmasterが両方あるか、どちらもありません',
      );
      const changed = changedFiles({ root, base });
      console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
      assert(changed.length > 0, '変更なし: テストを実行しません');
      assert(classes.quality.length > 0, '候補0件: qualityがありません');
      if (config.prepare.length > 0) {
        await run(config.prepare);
      }
      const ctx = { root, config, base, quality: classes.quality, changed, run };
      await (config.runner === 'bun' ? runBunTests : runVitestTests)(ctx);
      console.log('選択したqualityが成功しました。全体checkの成功ではありません');
    }
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
