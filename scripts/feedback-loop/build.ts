import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 生成物は実行時にこのrepoのcheckout・git・node_modulesを参照しません。
const harness = resolve(import.meta.dir, '../..');
import { isRecord } from '../shared/values.ts';
import { packageManagerToken } from './config.ts';
const generator = 'thkt/feedback-loop scripts/feedback-loop/build.ts';
const skill = 'plugins/setup-feedback-loop/skills/setup-feedback-loop';
const references = [
  'agents-md.md',
  'claude-code.md',
  'codex.md',
  'collect.md',
  'contract.md',
  'runners.md',
  'tools.md',
  'typecheck.md',
];

function requiredBun() {
  const pkg: unknown = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8'));
  assert(isRecord(pkg));
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(String(pkg.packageManager));
  assert(match?.[1], 'package.jsonのpackageManagerからBunの版を読めません');
  return match[1];
}

async function bundle(entry: string, target: 'bun' | 'node', define: Record<string, string>) {
  const cwd = process.cwd();
  let build;
  try {
    // 対象repoや呼出し元のtsconfig・bunfigではなく、このrepoの設定で解決します。
    process.chdir(harness);
    build = await Bun.build({
      entrypoints: [join(harness, entry)],
      target,
      format: 'esm',
      minify: false,
      define,
    });
  } finally {
    process.chdir(cwd);
  }
  assert(build.success, `生成に失敗しました: ${build.logs.map((log) => log.message).join('\n')}`);
  assert(build.outputs.length === 1 && build.outputs[0]);
  return build.outputs[0].text();
}

/** スキルディレクトリ配下の生成物を、相対パスと内容の組で返す。 */
export async function generate() {
  const bun = requiredBun();
  const header = `// 生成元: ${generator}。直接編集せず、正本を変更して再生成してください\n`;
  const files = new Map<string, string>();
  files.set(
    'scripts/setup.mjs',
    header +
      (await bundle('scripts/feedback-loop/setup.ts', 'bun', {
        requiredBun: JSON.stringify(bun),
      })),
  );
  const runtime = await bundle('scripts/feedback-loop/runtime.ts', 'node', {
    targetPackageManager: JSON.stringify(packageManagerToken),
  });
  assert(runtime.includes(packageManagerToken), 'runtimeにpackage managerの置換箇所がありません');
  files.set('scripts/runtime.mjs', header + runtime);
  files.set(
    'scripts/record-modules.ts',
    readFileSync(join(harness, 'scripts/test-runtime/record-modules.ts'), 'utf8'),
  );
  for (const name of references) {
    const source = `references/${name}`;
    files.set(
      source,
      `<!-- 生成元: ${source}。直接編集せず、正本を変更して再生成してください -->\n\n` +
        readFileSync(join(harness, source), 'utf8'),
    );
  }
  return files;
}

function listGenerated(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listGenerated(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

/** 生成物を書き出す。checkでは書かずに、正本との食い違いを返す。 */
export async function sync(root: string, check: boolean) {
  const files = await generate();
  const stale: string[] = [];
  for (const [path, body] of files) {
    const target = join(root, path);
    if (existsSync(target) && readFileSync(target, 'utf8') === body) {
      continue;
    }
    stale.push(path);
    if (!check) {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, body);
    }
  }
  // 生成先の余分なファイルは消さずに報告します。scripts/は生成物だけを置く場所です。
  const extra = listGenerated(join(root, 'scripts'), 'scripts/').filter((path) => !files.has(path));
  return { stale, extra };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  assert(
    args.every((arg) => arg === '--check'),
    `未対応の引数: ${args.join(' ')}`,
  );
  const { stale, extra } = await sync(join(harness, skill), check);
  for (const path of stale) {
    console.error(`${check ? '正本と食い違う生成物' : '生成'}: ${path}`);
  }
  for (const path of extra) {
    console.error(`生成対象外のファイル: ${path}`);
  }
  if (extra.length > 0 || (check && stale.length > 0)) {
    console.error(
      check
        ? '生成物が正本と一致しません。bun run build:feedback-loopで再生成してください'
        : '生成対象外のファイルを確認してください',
    );
    process.exitCode = 1;
  }
}
