import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generate } from '../../scripts/build.ts';

let built: Promise<string> | undefined;
const roots: string[] = [];
process.on('exit', () => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 正本から生成したスキルを、このrepoのcheckout外の一時ディレクトリへ置く。
 * 返すのはそのスキルディレクトリの絶対パスで、CLIは`scripts/setup.mjs`にある。
 */
function skillDir() {
  built ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), 'feedback-loop-skill-'));
    roots.push(root);
    // checkoutの中に置くと、スキルがこのrepoのgitとnode_modulesに頼っていても、テストが通ってしまう。
    assert(
      spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root }).status !== 0,
      `スキルの置き場がGit checkoutの中にあります: ${root}`,
    );
    for (const [path, body] of await generate()) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return root;
  })();
  return built;
}

export async function skillSetup() {
  return join(await skillDir(), 'scripts/setup.mjs');
}
