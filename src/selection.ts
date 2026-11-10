import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ignoresChange, mappedTests, requiresFullRun } from './config.ts';
import type { FeedbackConfig } from './config.ts';

type Change = { path: string; targets: string[] };
// alwaysは、変更との対応によらず選ぶqualityです。
type Reachability = { reached: Map<string, string[]>; always: string[] };
type Source = {
  // 依存記録を使えない場合に渡す。warningは、記録があるのに使えない理由である。
  unusableRecords?: { warning: string | undefined };
  // 照会を省いたときはundefinedを返し、到達先なしの判定もしません。
  reach: (changes: Change[], fullRunKnown: boolean) => Promise<Reachability | undefined>;
};

export type Selection =
  // 全qualityを実行する。reasonsはその理由。
  | { kind: 'all'; reasons: string[]; files: string[] }
  | { kind: 'some'; files: string[] }
  // 届く先のない変更が、すべてignoredChangesで宣言されている。
  | { kind: 'ignored' }
  // 実行するテストがなく、宣言された変更もない。
  | { kind: 'none' };

export async function selectQuality(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
  source: Source,
): Promise<Selection> {
  // 宣言が効くのは、テスト自身でも、globalChangesにも明示依存にも当たらない変更だけです。
  const declared = new Set<string>();
  const changes = changed.map((path) => {
    const targets = [...(quality.includes(path) ? [path] : []), ...mappedTests(path, config)];
    if (targets.length === 0 && !requiresFullRun(path, config) && ignoresChange(path, config)) {
      declared.add(path);
    }
    // 明示依存の先がassuranceだけの変更は、届くqualityがない変更として全件へ広げます。
    return { path, targets: targets.filter((test) => quality.includes(test)) };
  });
  const fullRun = changes
    .filter(
      ({ path }) =>
        requiresFullRun(path, config) ||
        (config.runner === 'vitest' && !declared.has(path) && !existsSync(join(root, path))),
    )
    .map(({ path }) => path);
  const reachability = await source.reach(changes, fullRun.length > 0);
  const selected = new Set(reachability?.always);
  // 全件実行の理由になった変更は、選ぶ先が空でも理由に重ねません。
  const unreached: string[] = [];
  // 宣言された変更のうち、どのテストにも届かなかったもの。届いた変更は宣言があっても選択に使います。
  const ignored: string[] = [];
  for (const { path, targets } of changes) {
    const reached = [...targets, ...(reachability?.reached.get(path) ?? [])];
    if (reached.length === 0 && reachability !== undefined && !fullRun.includes(path)) {
      (declared.has(path) ? ignored : unreached).push(path);
    }
    reached.forEach((file) => selected.add(file));
  }
  const reasons = [
    ...fullRun,
    ...(source.unusableRecords?.warning === undefined ? [] : [source.unusableRecords.warning]),
    ...unreached,
    ...(source.unusableRecords === undefined ? [] : ['信頼できる依存記録なし']),
  ];
  if (reasons.length > 0) {
    return { kind: 'all', reasons, files: quality };
  }
  const files = quality.filter((file) => selected.has(file));
  if (files.length > 0) {
    return { kind: 'some', files };
  }
  return { kind: ignored.length > 0 ? 'ignored' : 'none' };
}
