import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  generatedVersion,
  installedFiles,
  packageManagerToken,
  versionLine,
} from '../src/installed.ts';
import { isRecord } from '../src/values.ts';

// 生成物は実行時にこのrepoのcheckout・git・node_modulesを参照しません。
const repoRoot = resolve(import.meta.dir, '..');
const generator = 'thkt/feedback-loop scripts/build.ts';
const skill = 'plugins/setup-feedback-loop/skills/setup-feedback-loop';
const references = ['agents.md', 'contract.md', 'runners.md', 'tools.md'];

function minimumBun() {
  const pkg: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert(isRecord(pkg));
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(String(pkg.packageManager));
  assert(match?.[1], 'package.jsonのpackageManagerからBunのバージョンを読めません');
  return match[1];
}

// 生成物に書くバージョン。プラグインのバージョンと同じにする。
function pluginVersion() {
  const plugin: unknown = JSON.parse(
    readFileSync(join(repoRoot, 'plugins/setup-feedback-loop/.claude-plugin/plugin.json'), 'utf8'),
  );
  assert(isRecord(plugin));
  const version = String(plugin.version);
  assert(/^\d+\.\d+\.\d+$/.test(version), `plugin.jsonのversionを読めません: ${version}`);
  return version;
}

async function bundle(entry: string, target: 'bun' | 'node', define: Record<string, string>) {
  const cwd = process.cwd();
  let build;
  try {
    // 対象repoや呼出し元のtsconfig・bunfigではなく、このrepoの設定で解決します。
    process.chdir(repoRoot);
    build = await Bun.build({
      entrypoints: [join(repoRoot, entry)],
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

export async function generate() {
  const bun = minimumBun();
  const header =
    `// 生成元: ${generator}。直接編集せず、正本を変更して再生成してください\n` +
    versionLine(pluginVersion());
  // apply --updateは、この先頭行からバージョンを読めなければ、配置済みのバージョンと比べない。
  assert(generatedVersion(header) !== undefined, '生成物の先頭行からバージョンを読めません');
  const files = new Map<string, string>();
  files.set(
    'scripts/setup.mjs',
    header +
      (await bundle('src/setup.ts', 'bun', {
        minimumBun: JSON.stringify(bun),
      })),
  );
  const runtime = await bundle('src/runtime.ts', 'node', {
    targetPackageManager: JSON.stringify(packageManagerToken),
  });
  assert(runtime.includes(packageManagerToken), 'runtimeにpackage managerの置換箇所がありません');
  files.set('scripts/runtime.mjs', header + runtime);
  files.set(
    'scripts/record-modules.ts',
    header + readFileSync(join(repoRoot, 'src/record-modules.ts'), 'utf8'),
  );
  for (const name of references) {
    const source = `references/${name}`;
    files.set(
      source,
      `<!-- 生成元: ${source}。直接編集せず、正本を変更して再生成してください -->\n\n` +
        readFileSync(join(repoRoot, source), 'utf8'),
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
async function sync(root: string, check: boolean) {
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
  // scripts/の余分なファイルは報告し、正本から外れたreferences/は再生成時に削除します。
  const extra = listGenerated(join(root, 'scripts'), 'scripts/').filter((path) => !files.has(path));
  for (const path of listGenerated(join(root, 'references'), 'references/')) {
    if (!files.has(path)) {
      if (check) {
        extra.push(path);
      } else {
        rmSync(join(root, path));
      }
    }
  }
  return { stale, extra };
}

/**
 * rootへapplyで配置した導入版のうち、生成物から作る内容と食い違うパスを返す。
 * このrepoのpackage managerとrunnerはBunである。
 */
async function staleInstalled(root: string) {
  const files = await generate();
  const expected = installedFiles(
    (name) => {
      const body = files.get(`scripts/${name}`);
      assert(body !== undefined, `生成物がありません: scripts/${name}`);
      return body;
    },
    'bun',
    'bun',
  );
  return [...expected]
    .filter(([path, body]) => {
      const target = join(root, path);
      return !existsSync(target) || readFileSync(target, 'utf8') !== body;
    })
    .map(([path]) => path);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  assert(
    args.every((arg) => arg === '--check'),
    `未対応の引数: ${args.join(' ')}`,
  );
  const { stale, extra } = await sync(join(repoRoot, skill), check);
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
  const installed = await staleInstalled(repoRoot);
  for (const path of installed) {
    console.error(`生成物と食い違う導入版: ${path}`);
  }
  if (installed.length > 0) {
    console.error(
      `導入版を更新してください: bun ${skill}/scripts/setup.mjs apply --update --repo ${repoRoot}`,
    );
    if (check) {
      process.exitCode = 1;
    }
  }
}
