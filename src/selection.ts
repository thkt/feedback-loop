import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ignoresChange, isAssurance, mappedTests, requiresFullRun } from './config.ts';
import type { FeedbackConfig } from './config.ts';

type Change = { path: string; targets: string[] };
// alwaysは、変更との対応によらず選ぶqualityです。
type Reachability = { reached: Map<string, string[]>; always: string[] };
type Source = {
  // 変更によらず全qualityを実行する理由。依存記録を使えない場合などに渡す。
  fullRunReason?: string;
  // 照会を省いたときはundefinedを返し、到達先なしの判定もしません。
  reach: (changes: Change[], fullRunKnown: boolean) => Promise<Reachability | undefined>;
};

export type Selection =
  // 全qualityを実行する。reasonsはその理由。
  | { kind: 'all'; reasons: string[]; files: string[] }
  | { kind: 'some'; files: string[] }
  // 届く先のない変更が、すべてignoredChangesの宣言かassuranceのテストファイルである。
  // 各フラグは、その種類の届かない変更があったかを表す。
  | { kind: 'skipped'; ignored: boolean; assurance: boolean }
  // 実行するテストがなく、宣言された変更もassuranceの変更もない。
  | { kind: 'none' };

// ranはテストを実行して成功した。skippedとnoneは、選択の結果として実行するテストがなかった。
export type TestOutcome = { kind: 'ran' } | Extract<Selection, { kind: 'skipped' | 'none' }>;

export async function selectQuality(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
  source: Source,
): Promise<Selection> {
  // 宣言が効くのは、テスト自身でも、globalChangesにも明示依存にも当たらない変更だけです。
  const declared = new Set<string>();
  // assuranceのテストファイルはtest:affectedで実行しないため、届く先がなくても全件へ広げません。
  // assuranceは全体checkとCIが実行します。
  const assurance = new Set<string>();
  const changes = changed.map((path) => {
    const targets = [...(quality.includes(path) ? [path] : []), ...mappedTests(path, config)];
    if (!requiresFullRun(path, config)) {
      if (isAssurance(path, config)) {
        assurance.add(path);
      } else if (targets.length === 0 && ignoresChange(path, config)) {
        declared.add(path);
      }
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
  // 宣言された変更とassuranceの変更のうち、どのテストにも届かなかったもの。
  // 届いた変更は、宣言やassuranceであっても選択に使います。
  const skipped = { ignored: false, assurance: false };
  for (const { path, targets } of changes) {
    const reached = [...targets, ...(reachability?.reached.get(path) ?? [])];
    if (reached.length === 0 && reachability !== undefined && !fullRun.includes(path)) {
      if (assurance.has(path)) {
        skipped.assurance = true;
      } else if (declared.has(path)) {
        skipped.ignored = true;
      } else {
        unreached.push(path);
      }
    }
    reached.forEach((file) => selected.add(file));
  }
  // 変更による理由を先に、変更によらない理由を後に並べます。
  const reasons = [
    ...fullRun,
    ...unreached,
    ...(source.fullRunReason === undefined ? [] : [source.fullRunReason]),
  ];
  if (reasons.length > 0) {
    return { kind: 'all', reasons, files: quality };
  }
  const files = quality.filter((file) => selected.has(file));
  if (files.length > 0) {
    return { kind: 'some', files };
  }
  return skipped.ignored || skipped.assurance ? { kind: 'skipped', ...skipped } : { kind: 'none' };
}
