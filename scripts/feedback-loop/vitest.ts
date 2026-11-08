import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assuranceExcludes, assertObject, repoPath } from './config.ts';
import { selectQuality } from './selection.ts';
import type { FeedbackConfig } from './config.ts';

type VitestAPI = {
  parseCLI: (args: string[]) => { options: Record<string, unknown> };
  createVitest: (
    mode: 'test',
    options: Record<string, unknown>,
  ) => Promise<{
    config: { related?: string[] };
    getRelevantTestSpecifications: () => Promise<{ moduleId: string }[]>;
    close: () => Promise<void>;
  }>;
};

function vitestAPI(value: unknown): asserts value is VitestAPI {
  assertObject(value);
  assert(
    typeof value.parseCLI === 'function' && typeof value.createVitest === 'function',
    '導入版Vitestの公開収集APIを利用できません',
  );
}

// Vitest自身の依存グラフで変更ごとに確認し、到達先不明の入力を混在させない。
export async function selectVitest(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
  apiPath: string,
) {
  return selectQuality(root, config, quality, changed, {
    async reach(changes, fullRunKnown) {
      // 全件と決まっていれば、Vitestの依存グラフを作りません。
      if (fullRunKnown) {
        return undefined;
      }
      const reached = new Map<string, string[]>();
      const pending = changes.map(({ path }) => path).filter((path) => !quality.includes(path));
      if (pending.length === 0) {
        return { reached, unrecorded: [] };
      }
      const api: unknown = await import(pathToFileURL(apiPath).href);
      vitestAPI(api);
      const exclude = assuranceExcludes(root, config);
      const parsed = api.parseCLI([
        'vitest',
        'related',
        ...pending,
        ...config.testArgs,
        ...exclude,
        '--run',
      ]);
      const context = await api.createVitest('test', { ...parsed.options, watch: false });
      try {
        for (const path of pending) {
          context.config.related = [join(root, path)];
          const specs = await context.getRelevantTestSpecifications();
          const files = specs.map((spec) => repoPath(root, spec.moduleId));
          const targets = files.filter((file) => quality.includes(file));
          // assuranceは除外済みなので、残りはcollectとVitestの収集のずれである。黙って捨てると未実行を成功にしてしまう。
          assert(
            targets.length === files.length,
            `Vitestの到達先がquality集合と一致しません: ${files.filter((file) => !quality.includes(file)).join(', ')}`,
          );
          reached.set(path, targets);
        }
      } finally {
        await context.close();
      }
      return { reached, unrecorded: [] };
    },
  });
}
