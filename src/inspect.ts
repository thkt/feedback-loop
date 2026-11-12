import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defaultBase, gitOutput } from './git.ts';
import { packageManagers } from './installed.ts';
import { ancestorLockfiles, fromRoot, lockfilesIn } from './lockfiles.ts';
import type { PackageManager } from './installed.ts';
import { assertObject, errorMessage, stringRecord } from './values.ts';

/** rootを含むGit checkoutのルート。gitはリンクを解決したパスを返すため、比べる側も解決したパスを使う。 */
export function gitRoot(root: string) {
  const top = gitOutput(root, ['rev-parse', '--show-toplevel']);
  assert(top !== undefined, '--repoはGit checkoutの中のディレクトリを指定してください');
  return realpathSync(top);
}

type Inherited = { lockfiles: string[]; declared: unknown };
type DetectedManager =
  | { packageManager: PackageManager; inherited?: Inherited }
  | { packageManager: null; reason: string };

type Hints = { names: string[] } | { reason: string };

// packageManagerの値とlockfileが指すpackage managerの名前。sourceは、診断に書くpackage.jsonのパスである。
function hintsOf(
  declared: unknown,
  lockfiles: ReturnType<typeof lockfilesIn>,
  source: string,
): Hints {
  const names: string[] = lockfiles.map(({ manager }) => manager);
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (!name) {
      return {
        reason: `${source}のpackageManagerの値「${declared}」からpackage managerを読み取れません`,
      };
    }
    names.unshift(name);
  }
  return { names: [...new Set(names)] };
}

// directoryのpackage.jsonが指定するpackageManager。package.jsonがなければundefinedを返す。
function declaredIn(directory: string, source: string): unknown {
  const path = join(directory, 'package.json');
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const pkg: unknown = JSON.parse(readFileSync(path, 'utf8'));
    assertObject(pkg);
    return pkg.packageManager;
  } catch (error) {
    return assert.fail(`${source}を読めません: ${errorMessage(error)}`);
  }
}

/**
 * 判定に使う名前と、その出どころ。rootにpackageManagerもlockfileもなければ、祖先のいちばん近いlockfileと、
 * 同じディレクトリのpackageManagerを使う。inheritedは、その祖先のlockfileのパスとpackageManagerである。
 */
function hintSource(
  root: string,
  top: string,
  declared: unknown,
): { hints: Hints; where: string; inherited?: Inherited } {
  const local = hintsOf(declared, lockfilesIn(root), 'package.json');
  const ancestor =
    'names' in local && local.names.length === 0 ? ancestorLockfiles(root, top) : undefined;
  if (ancestor === undefined) {
    return { hints: local, where: '' };
  }
  const source = fromRoot(root, join(ancestor.directory, 'package.json'));
  const declaredAbove = declaredIn(ancestor.directory, source);
  return {
    hints: hintsOf(declaredAbove, ancestor.lockfiles, source),
    // 診断にそのディレクトリを書き、rootでの判定の診断と区別する。
    where: `（${fromRoot(root, ancestor.directory)}で判定）`,
    inherited: {
      lockfiles: ancestor.lockfiles.map(({ name }) =>
        fromRoot(root, join(ancestor.directory, name)),
      ),
      declared: declaredAbove,
    },
  };
}

/** 判定に使う名前が、対応するpackage managerを1つだけ指す場合に選ぶ。 */
function detectPackageManager(root: string, top: string, declared: unknown): DetectedManager {
  const { hints, where, inherited } = hintSource(root, top, declared);
  if ('reason' in hints) {
    return { packageManager: null, reason: hints.reason };
  }
  const [hint, ...others] = hints.names;
  if (hint === undefined) {
    return {
      packageManager: null,
      reason: 'package managerを判定できません。package.jsonのpackageManagerかlockfileが必要です',
    };
  }
  if (others.length > 0) {
    return {
      packageManager: null,
      reason: `package managerの指定が競合しています: ${hints.names.join(', ')}${where}`,
    };
  }
  const packageManager = packageManagers.find((manager) => manager === hint);
  return packageManager === undefined
    ? {
        packageManager: null,
        reason: `${hint}には対応していません。対応するのは${packageManagers.join('・')}です${where}`,
      }
    : { packageManager, inherited };
}

export function inspect(root: string) {
  const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertObject(pkg);
  const scripts = stringRecord(pkg.scripts ?? {});
  const devDependencies = stringRecord(pkg.devDependencies ?? {});
  const dependencies = stringRecord(pkg.dependencies ?? {});
  // 設定はGitのルートにも置かれる。rootがその下なら、ルートの分は../で始まるパスになる。
  const top = gitRoot(root);
  const manager = detectPackageManager(root, top, pkg.packageManager);
  const inherited = manager.packageManager === null ? undefined : manager.inherited;
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
    // 祖先のlockfileで判定したときの、そのlockfileのパス。rootで判定したときはnullである。
    packageManagerFrom: inherited?.lockfiles ?? null,
    base: comparison.base,
    scripts,
    devDependencies,
    dependencies,
    // 判定に使った祖先のlockfileは、Gitのルートより近い祖先にあっても返す。
    configFiles: [...new Set([...configFiles, ...(inherited?.lockfiles ?? [])])].sort(),
    runtime: pkg.engines ?? pkg.packageManager ?? inherited?.declared ?? null,
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
