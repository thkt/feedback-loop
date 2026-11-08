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
  reach: (changes: Change[], fullRunKnown: boolean) => Promise<Reachability>;
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
    return {
      path,
      targets: [...(quality.includes(path) ? [path] : []), ...mappedTests(path, config)],
    };
  });
  const selected = new Set(changes.flatMap(({ targets }) => targets));
  const excluded = new Set<string>();
  const reasons: string[] = [];
  const rules = [
    // 規則1・2は変更順に混ぜ、該当した変更を規則4で重ねて理由にしません。
    () =>
      changes
        .filter(({ path }) => {
          const full =
            requiresFullRun(path, config) ||
            (config.runner === 'vitest' && !existsSync(join(root, path)));
          if (full) {
            excluded.add(path);
          }
          return full;
        })
        .map(({ path }) => path),
    () => (source.warning ? [source.warning] : []),
    async () => {
      const { reached, unrecorded } = await source.reach(changes, reasons.length > 0);
      unrecorded.forEach((file) => selected.add(file));
      const unreached: string[] = [];
      for (const { path, targets } of changes) {
        if (excluded.has(path)) {
          continue;
        }
        const files = reached.get(path);
        // Vitestが全件入力を見つけた場合は、依存グラフの照会自体を省きます。
        if (files === undefined) {
          continue;
        }
        const union = new Set([...targets, ...files]);
        if (union.size === 0) {
          unreached.push(path);
        }
        union.forEach((file) => selected.add(file));
      }
      return unreached;
    },
    () => (source.missingRecords ? ['信頼できる依存記録なし'] : []),
  ];
  for (const rule of rules) {
    reasons.push(...(await rule()));
  }
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
