import { isTestFile, mutantsRecordFile } from './config.ts';
import type { FeedbackConfig } from './config.ts';
import { comparisonBase, statusChangesFrom } from './changes.ts';

function disallowedChange(
  config: FeedbackConfig,
  { status, path }: { status: string; path: string },
) {
  if (path.startsWith('../')) {
    return `${path}（package.jsonのディレクトリの外の変更）`;
  }
  if (path.startsWith('.github/')) {
    return `${path}（.github/の下の変更）`;
  }
  if (status === 'A') {
    return undefined;
  }
  if (status === 'D') {
    return `${path}（比較元にあるファイルの削除）`;
  }
  const editable = status === 'M' && (path === mutantsRecordFile || isTestFile(path, config));
  return editable ? undefined : `${path}（テストのファイルと${mutantsRecordFile}の外の変更）`;
}

export async function changesOutsideImprovement(root: string, config: FeedbackConfig) {
  const changes = await statusChangesFrom(root, comparisonBase(root, config));
  return changes.flatMap((change) => {
    const reason = disallowedChange(config, change);
    return reason === undefined ? [] : [reason];
  });
}
