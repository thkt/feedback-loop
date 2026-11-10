import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defaultBase, gitOutput } from './git.ts';
import { packageManagers } from './installed.ts';
import type { PackageManager } from './installed.ts';
import { assertObject, stringRecord } from './values.ts';

/** rootを含むGit checkoutのルート。gitはリンクを解決したパスを返すため、比べる側も解決したパスを使う。 */
export function gitRoot(root: string) {
  const top = gitOutput(root, ['rev-parse', '--show-toplevel']);
  assert(top !== undefined, '--repoはGit checkoutの中のディレクトリを指定してください');
  return realpathSync(top);
}

export function inspect(root: string) {
  const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertObject(pkg);
  const scripts = stringRecord(pkg.scripts ?? {});
  const devDependencies = stringRecord(pkg.devDependencies ?? {});
  const dependencies = stringRecord(pkg.dependencies ?? {});
  const hints = new Set<string>();
  if (typeof pkg.packageManager === 'string') {
    hints.add(pkg.packageManager.split('@')[0] ?? '');
  }
  for (const [path, manager] of [
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['pnpm-lock.yaml', 'pnpm'],
  ] as const) {
    if (existsSync(join(root, path))) {
      hints.add(manager);
    }
  }
  // 指定が1つで、対応するpackage managerの場合だけ選ぶ。未指定、競合、未対応はnullにする。
  const [hint, ...others] = hints;
  const packageManager: PackageManager | null =
    (others.length === 0 && packageManagers.find((manager) => manager === hint)) || null;
  // 設定はGitのルートにも置かれる。rootがその下なら、ルートの分は../で始まるパスになる。
  const top = gitRoot(root);
  const configFiles = [...new Set([root, top])].flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          /(?:config|lock|mise|bunfig|feedback-loop|eslint|prettier|biome|oxlint|oxfmt|fallow)/.test(
            entry.name,
          ),
      )
      .map((entry) => relative(root, join(directory, entry.name))),
  );
  const workflow = join(top, '.github/workflows');
  if (existsSync(workflow)) {
    configFiles.push(...readdirSync(workflow).map((name) => relative(root, join(workflow, name))));
  }
  const base = defaultBase(root);
  return {
    packageManager,
    base,
    scripts,
    devDependencies,
    dependencies,
    configFiles: configFiles.sort(),
    runtime: pkg.engines ?? pkg.packageManager ?? null,
    tools: Object.keys({ ...dependencies, ...devDependencies }).filter((name) =>
      /eslint|prettier|biome|oxlint|oxfmt|fallow|typescript|vitest/.test(name),
    ),
    diagnostics: [
      [packageManager, 'package managerが未指定、競合、または未対応です'],
      [
        base,
        '比較元を決められません。origin/HEADがなく、mainとmasterが両方あるか、どちらもありません',
      ],
    ]
      .filter(([found]) => !found)
      .map(([, message]) => message),
    pkg,
  };
}

export type Inspection = ReturnType<typeof inspect>;
export type ManagedInspection = Inspection & { packageManager: PackageManager };

export function inspectManaged(root: string): ManagedInspection {
  const inspected = inspect(root);
  const { packageManager } = inspected;
  assert(packageManager, 'package managerを選択できません');
  return { ...inspected, packageManager };
}
