export const packageManagers = ['bun', 'npm', 'pnpm'] as const;
export type PackageManager = (typeof packageManagers)[number];

// 導入先に配置するruntimeの、package.jsonからの相対パスです。package scriptsと再実行の案内が同じ値を使います。
export const runtimePath = 'scripts/feedback-loop/runtime.mjs';

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

/**
 * 導入先へ配置するパスと内容を返す。
 * readは、スキルのscripts/にある生成物の名前を受け取って内容を返す。
 */
export function installedFiles(
  read: (name: string) => string,
  packageManager: PackageManager,
  runner: 'bun' | 'vitest',
) {
  const files = new Map([
    [runtimePath, read('runtime.mjs').replaceAll(packageManagerToken, packageManager)],
  ]);
  // npm/Vitestの実行にはBunを要求しません。記録器はBunのrunnerでだけ配置します。
  if (runner === 'bun') {
    files.set('scripts/feedback-loop/record-modules.ts', read('record-modules.ts'));
  }
  return files;
}
