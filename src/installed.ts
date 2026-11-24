export const packageManagers = ['bun', 'npm', 'pnpm'] as const;
export type PackageManager = (typeof packageManagers)[number];

// 導入先に生成物を配置するディレクトリの、package.jsonからの相対パスです。
export const installedDirectory = 'scripts/feedback-loop';

// 導入先に配置するruntimeのパスです。package scriptsと再実行の案内が同じ値を使います。
export const runtimePath = `${installedDirectory}/runtime.mjs`;

// 導入先に配置する記録器のパスです。実行部は、Bunのrunnerでこのパスから記録器を読み込みます。
export const recorderPath = `${installedDirectory}/record-modules.ts`;

const improveTestsPath = `${installedDirectory}/improve-tests.md`;

export const mutationPreloadPath = `${installedDirectory}/mutation-preload.ts`;

// 生成したruntime.mjsで、導入時にpackage managerへ置き換える文字列です。
export const packageManagerToken = '__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__';

/** 生成物の先頭に書くバージョンの行。apply --updateが、配置済みの生成物のバージョンをこの行から読む。 */
export function versionLine(version: string) {
  return `// バージョン: ${version}\n`;
}

/**
 * 生成物の2行目からバージョンを読む。リリース済みの0.4.2までの生成物にはバージョンの行がなく、undefinedを返す。
 * 改行をCRLFへ変えるcheckoutでは、行末に\rが残る。
 */
export function generatedVersion(body: string): string | undefined {
  return /^\/\/ バージョン: (\d+\.\d+\.\d+)\s*$/.exec(body.split('\n', 2)[1] ?? '')?.[1];
}

/** 導入先へ配置するパスと内容を返す。 */
export function installedFiles(
  readSkillFile: (skillRelativePath: string) => string,
  packageManager: PackageManager,
  runner: 'bun' | 'vitest',
  mutation: boolean,
) {
  const files = new Map([
    [
      runtimePath,
      readSkillFile('scripts/runtime.mjs').replaceAll(packageManagerToken, packageManager),
    ],
  ]);
  // npm/Vitestの実行にはBunを要求しません。記録器はBunのrunnerでだけ配置します。
  if (runner === 'bun') {
    files.set(recorderPath, readSkillFile('scripts/record-modules.ts'));
  }
  if (mutation) {
    files.set(mutationPreloadPath, readSkillFile('scripts/mutation-preload.ts'));
    files.set(improveTestsPath, readSkillFile('references/improve-tests.md'));
  }
  return files;
}
