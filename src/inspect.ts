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

type DetectedManager =
  | { packageManager: PackageManager }
  | { packageManager: null; reason: string };

/** package.jsonのpackageManagerとlockfileが、対応するpackage managerを1つだけ指す場合に選ぶ。 */
function detectPackageManager(root: string, declared: unknown): DetectedManager {
  const hints = new Set<string>();
  if (typeof declared === 'string') {
    hints.add(declared.split('@')[0] ?? '');
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
  const [hint, ...others] = hints;
  if (hint === undefined) {
    return {
      packageManager: null,
      reason: 'package managerを判定できません。package.jsonのpackageManagerかlockfileが必要です',
    };
  }
  if (others.length > 0) {
    return {
      packageManager: null,
      reason: `package managerの指定が競合しています: ${[...hints].join(', ')}`,
    };
  }
  const packageManager = packageManagers.find((manager) => manager === hint);
  return packageManager === undefined
    ? {
        packageManager: null,
        reason: `${hint}には対応していません。対応するのは${packageManagers.join('・')}です`,
      }
    : { packageManager };
}

export function inspect(root: string) {
  const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertObject(pkg);
  const scripts = stringRecord(pkg.scripts ?? {});
  const devDependencies = stringRecord(pkg.devDependencies ?? {});
  const dependencies = stringRecord(pkg.dependencies ?? {});
  const manager = detectPackageManager(root, pkg.packageManager);
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
  const comparison = defaultBase(root);
  return {
    packageManager: manager.packageManager,
    base: comparison.base,
    scripts,
    devDependencies,
    dependencies,
    configFiles: configFiles.sort(),
    runtime: pkg.engines ?? pkg.packageManager ?? null,
    tools: Object.keys({ ...dependencies, ...devDependencies }).filter((name) =>
      /eslint|prettier|biome|oxlint|oxfmt|fallow|typescript|vitest/.test(name),
    ),
    diagnostics: [
      ...(manager.packageManager === null ? [manager.reason] : []),
      ...(comparison.base === null ? [`比較元を決められません。${comparison.reason}`] : []),
    ],
    pkg,
    manager,
  };
}

export type Inspection = ReturnType<typeof inspect>;
export type ManagedInspection = Inspection & { packageManager: PackageManager };

export function inspectManaged(root: string): ManagedInspection {
  const inspected = inspect(root);
  const { manager } = inspected;
  if (manager.packageManager === null) {
    assert.fail(`package managerを選択できません: ${manager.reason}`);
  }
  return { ...inspected, packageManager: manager.packageManager };
}
