import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assuranceExcludes, mappedTests, object, repoPath, requiresFullRun } from './config.ts';
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
  object(value);
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
  const relative = changed.map((path) => repoPath(root, path));
  const reasons = relative.filter(
    (path) => requiresFullRun(path, config) || !existsSync(join(root, path)),
  );
  const selected = new Set(quality.filter((path) => relative.includes(path)));
  const pending: string[] = [];
  const mappedInputs = new Set<string>();
  for (const path of relative) {
    const mapped = mappedTests(path, config);
    if (mapped.length > 0) {
      mappedInputs.add(path);
      mapped.forEach((test) => selected.add(test));
    }
    if (!quality.includes(path)) {
      pending.push(path);
    }
  }
  if (reasons.length === 0 && pending.length > 0) {
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
        const reached = files.filter((file) => quality.includes(file));
        // assuranceは除外済みなので、残りはcollectとVitestの収集のずれである。黙って捨てると未実行を成功にしてしまう。
        assert(
          reached.length === files.length,
          `Vitestの到達先がquality集合と一致しません: ${files.filter((file) => !quality.includes(file)).join(', ')}`,
        );
        if (reached.length === 0 && !mappedInputs.has(path)) {
          reasons.push(path);
        }
        reached.forEach((file) => selected.add(file));
      }
    } finally {
      await context.close();
    }
  }
  return {
    files: reasons.length > 0 ? quality : quality.filter((path) => selected.has(path)),
    reasons,
  };
}
