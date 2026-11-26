// 生成元: thkt/feedback-loop scripts/build.ts。直接編集せず、正本を変更して再生成してください
// バージョン: 0.5.3
import { readFileSync } from 'node:fs';

const originalBunOptions = process.env.FEEDBACK_LOOP_MUTATION_BUN_OPTIONS;

const childrenCreated = '    const children = new Set();\n';
const childrenStopped =
  '        async close() {\n            for (const child of children)\n                killGroup(child);\n';

function stopChildrenOnExit(source: string) {
  if (source.split(childrenCreated).length !== 2 || source.split(childrenStopped).length !== 2) {
    console.error(
      '@mizchi/mutator-bunの取消の処理を書き換えられませんでした。mutatorの版で取消の処理が変わっています。psを実行できない環境では、取消の後にテストのプロセスが残ることがあります',
    );
    return source;
  }
  return source
    .replace(
      childrenCreated,
      `${childrenCreated}    const stopChildren = () => {\n        for (const child of children)\n            killGroup(child);\n    };\n    process.once('exit', stopChildren);\n`,
    )
    .replace(
      childrenStopped,
      "        async close() {\n            process.off('exit', stopChildren);\n            stopChildren();\n",
    );
}

if (originalBunOptions !== undefined && process.env.MUTATOR_BUN_MANIFEST !== undefined) {
  const value: unknown = JSON.parse(originalBunOptions);
  if (typeof value === 'string') {
    process.env.BUN_OPTIONS = value;
  } else {
    delete process.env.BUN_OPTIONS;
  }
} else if (originalBunOptions !== undefined) {
  Bun.plugin({
    name: 'feedback-loop-mutator-bun-cancel',
    setup(build) {
      build.onLoad(
        { filter: /[\\/]@mizchi[\\/]mutator-bun[\\/]dist[\\/]session\.js$/ },
        ({ path }) => ({ contents: stopChildrenOnExit(readFileSync(path, 'utf8')), loader: 'js' }),
      );
    },
  });
}
