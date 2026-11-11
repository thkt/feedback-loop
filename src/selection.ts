import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ignoresChange, isAssurance, mappedTests, requiresFullRun } from './config.ts';
import type { FeedbackConfig } from './config.ts';

type Change = { path: string; targets: string[] };
// alwaysは、変更との対応によらず選ぶqualityです。
// reachesAssuranceは、assuranceのテストに届く変更です。届く先を調べられるrunnerだけが返します。
type Reachability = {
  reached: Map<string, string[]>;
  always: string[];
  reachesAssurance?: Set<string>;
};
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
  // qualityに届かない変更が、すべてignoredChangesの宣言か、assuranceのテストファイルか、assuranceにしか届かない変更である。
  // 各フラグは、その種類の変更があったかを表す。
  // assuranceReachは、assuranceにしか届かない変更のパス。
  | ({ kind: 'exempt' } & Exempt)
  // 実行するテストがなく、宣言された変更もassuranceの変更もない。
  | { kind: 'none' };

// ranはテストを実行して成功した。exemptとnoneは、選択の結果として実行するテストがなかった。
export type TestOutcome = { kind: 'ran' } | Extract<Selection, { kind: 'exempt' | 'none' }>;

// 届く先のない変更を全件へ広げない理由。理由がなければundefinedを返します。
function exemption(
  path: string,
  config: FeedbackConfig,
  declared: Set<string>,
  reachesAssurance: Set<string>,
) {
  // assuranceは全体checkとCIが実行するため、qualityに届かなくても全件へ広げません。
  // 明示依存の入力は、対応先がassuranceだけでも、ほかの入力と同じく全件へ広げます。
  const mapped = mappedTests(path, config).length > 0;
  if (!mapped && isAssurance(path, config)) {
    return 'assurance';
  }
  // ignoredChangesの宣言は、assuranceにしか届かない変更より先に当てます。宣言した変更の表示を変えないためです。
  if (declared.has(path)) {
    return 'ignored';
  }
  return !mapped && reachesAssurance.has(path) ? 'assuranceReach' : undefined;
}

type Exempt = { ignored: boolean; assurance: boolean; assuranceReach: string[] };

function recordExemption(exempt: Exempt, reason: keyof Exempt, path: string) {
  if (reason === 'assuranceReach') {
    exempt.assuranceReach.push(path);
  } else {
    exempt[reason] = true;
  }
}

function hasExemption(exempt: Exempt) {
  return exempt.ignored || exempt.assurance || exempt.assuranceReach.length > 0;
}

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
  // qualityに届かなかった変更に、宣言された変更、assuranceのテストファイル、assuranceにしか届かない変更があったか。
  // qualityに届いた変更は、宣言やassuranceであっても選択に使います。
  const exempt: Exempt = { ignored: false, assurance: false, assuranceReach: [] };
  const reachesAssurance = reachability?.reachesAssurance ?? new Set<string>();
  for (const { path, targets } of changes) {
    const reached = [...targets, ...(reachability?.reached.get(path) ?? [])];
    if (reached.length === 0 && reachability !== undefined && !fullRun.includes(path)) {
      const reason = exemption(path, config, declared, reachesAssurance);
      if (reason === undefined) {
        unreached.push(path);
      } else {
        recordExemption(exempt, reason, path);
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
  return hasExemption(exempt) ? { kind: 'exempt', ...exempt } : { kind: 'none' };
}
