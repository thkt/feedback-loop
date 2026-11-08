import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mappedTests, repoPath, requiresFullRun } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { selectAffected } from '../test-runtime/affected.ts';
import { loadRecords } from '../test-runtime/affected-records.ts';

type Change = { path: string; targets: string[] };
type Reachability = { reached: Map<string, string[]>; unrecorded: string[] };
type Source = {
  warning?: string;
  missingRecords?: boolean;
  // 照会を省いたときはundefinedを返し、到達先なしの判定もしません。
  reach: (changes: Change[], fullRunKnown: boolean) => Promise<Reachability | undefined>;
};

export async function selectQuality(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
  source: Source,
) {
  const changes = changed.map((file) => {
    const path = repoPath(root, file);
    const targets = [...(quality.includes(path) ? [path] : []), ...mappedTests(path, config)];
    // 明示依存の先がassuranceだけの変更は、届くqualityがない変更として全件へ広げます。
    return { path, targets: targets.filter((test) => quality.includes(test)) };
  });
  // 規則1・2: 全件入力と、Vitestでの削除。変更の順に並べます。
  const fullRun = changes
    .filter(
      ({ path }) =>
        requiresFullRun(path, config) ||
        (config.runner === 'vitest' && !existsSync(join(root, path))),
    )
    .map(({ path }) => path);
  const reachability = await source.reach(changes, fullRun.length > 0);
  const selected = new Set(reachability?.unrecorded);
  // 規則4: 選ぶ先が空の変更。規則1・2に当たった変更は重ねて理由にしません。
  const unreached: string[] = [];
  for (const { path, targets } of changes) {
    const reached = [...targets, ...(reachability?.reached.get(path) ?? [])];
    if (reached.length === 0 && reachability !== undefined && !fullRun.includes(path)) {
      unreached.push(path);
    }
    reached.forEach((file) => selected.add(file));
  }
  const reasons = [
    ...fullRun,
    ...(source.warning === undefined ? [] : [source.warning]),
    ...unreached,
    ...(source.missingRecords ? ['信頼できる依存記録なし'] : []),
  ];
  const all = reasons.length > 0;
  return { all, reasons, files: all ? quality : quality.filter((file) => selected.has(file)) };
}

export function selectBunQuality(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
) {
  const testFiles = quality.map((path) => join(root, path));
  const { records, warning } = loadRecords(root, changed, testFiles);
  return selectQuality(root, config, quality, changed, {
    warning,
    missingRecords: records.size === 0,
    async reach(changes) {
      const inputsByTest = new Map(records);
      for (const { path, targets } of changes) {
        for (const test of targets) {
          const file = join(root, test);
          // 明示対応を補い、同じ入力へ到達する実行記録も選択に残します。
          inputsByTest.set(file, new Set([...(inputsByTest.get(file) ?? []), join(root, path)]));
        }
      }
      const result = selectAffected({ changed, testFiles, records: inputsByTest });
      return {
        reached: new Map(
          [...result.reached].map(([path, files]) => [
            repoPath(root, path),
            files.map((file) => repoPath(root, file)),
          ]),
        ),
        unrecorded: result.unrecorded.map((file) => repoPath(root, file)),
      };
    },
  });
}
