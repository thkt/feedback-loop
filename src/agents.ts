import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gitRoot } from './inspect.ts';
import type { PackageManager } from './installed.ts';

/** directoryは、Gitのルートから見たpackageのディレクトリ。ルート自身なら空文字列。 */
function agentSection(
  directory: string,
  packageManager: PackageManager,
  checkCommand: string | undefined,
) {
  const quoted = /^[\w./-]+$/.test(directory)
    ? directory
    : `'${directory.replaceAll("'", "'\\''")}'`;
  const enter = directory ? `cd ${quoted} && ` : '';
  const subject = directory ? `\`${directory}/\`のコードやテスト` : 'コードやテスト';
  const check = checkCommand ?? `${enter}${packageManager} run check`;
  return `## 変更後の確認

${subject}を変更したら、作業を終える前に\`${enter}${packageManager} run check:feedback\`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では\`${check}\`も実行する。\`check:feedback\`の成功を全体checkの成功として報告しない。
`;
}

/** 既存の指示は統合せず、定型の節と読込み行だけを配置予定へ加える。 */
export function planAgentInstructions(
  root: string,
  packageManager: PackageManager,
  checkCommand: string | undefined,
) {
  const updates = new Map<string, string>();
  // エージェントはGitのルートで起動するため、指示はGitのルートへ置く。配置先はrootからの相対パスで表す。
  const top = gitRoot(root);
  const placed = (name: string) => relative(root, join(top, name));
  const agentsPath = join(top, 'AGENTS.md');
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  if (/^## 変更後の確認[ \t]*\r?$/m.test(agents)) {
    console.log('AGENTS.mdの「## 変更後の確認」は既存の内容を保持します');
  } else {
    const prefix = agents ? `${agents}${agents.endsWith('\n') ? '\n' : '\n\n'}` : '';
    updates.set(
      placed('AGENTS.md'),
      prefix + agentSection(relative(top, root), packageManager, checkCommand),
    );
  }
  const claudePath = join(top, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    const claude = readFileSync(claudePath, 'utf8');
    if (!/^@AGENTS\.md[ \t]*\r?$/m.test(claude)) {
      updates.set(placed('CLAUDE.md'), `@AGENTS.md\n${claude}`);
    }
  } else if (existsSync(join(top, 'CLAUDE.local.md'))) {
    console.log('CLAUDE.local.mdは変更しません。利用者が@AGENTS.mdの行を追加してください');
  }
  return updates;
}
