export const packageManagers = ['bun', 'npm', 'pnpm'] as const;
export type PackageManager = (typeof packageManagers)[number];

// 導入先に配置するruntimeの、package.jsonからの相対パスです。package scriptsと再実行の案内が同じ値を使います。
export const runtimePath = 'scripts/feedback-loop/runtime.mjs';

// 生成したruntime.mjsで、導入時にpackage managerへ置き換える文字列です。
export const packageManagerToken = '__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__';

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
