import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FeedbackConfig } from './config.ts';
import { excludePattern } from './vitest.ts';

const projectsMessage = 'test.projects を持つ Vitest の設定では、mutation を使えません';
const includeSourceMessage = 'test.includeSource を持つ Vitest の設定では、mutation を使えません';

const configFlags = ['--config', '-c'];
const configNames = ['vitest.config', 'vite.config'];
const configExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];

function configFromTestArgs(testArgs: string[]) {
  let value: string | undefined;
  for (const [index, arg] of testArgs.entries()) {
    const flag = configFlags.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag === undefined) {
      continue;
    }
    value = arg === flag ? testArgs[index + 1] : arg.slice(flag.length + 1);
    assert(
      value !== undefined && value !== '' && !value.startsWith('-'),
      `testArgs の ${flag} に、Vitest の設定ファイルのパスがありません`,
    );
  }
  return value;
}

function foundVitestConfig(root: string) {
  return configNames
    .flatMap((name) => configExtensions.map((extension) => join(root, `${name}.${extension}`)))
    .find((path) => existsSync(path));
}

function generatedConfig(repoConfig: string | undefined, include: string[]) {
  const load =
    repoConfig === undefined
      ? 'const loaded = {};\n'
      : `import loaded from ${JSON.stringify(repoConfig)};\n`;
  return `${load}export default async (env) => {
  const resolved = (await (typeof loaded === 'function' ? loaded(env) : loaded)) ?? {};
  if (resolved.test?.projects !== undefined) {
    throw new Error(${JSON.stringify(projectsMessage)});
  }
  if ((resolved.test?.includeSource ?? []).length > 0) {
    throw new Error(${JSON.stringify(includeSourceMessage)});
  }
  return { ...resolved, test: { ...resolved.test, include: ${JSON.stringify(include)} } };
};
`;
}

export function vitestRunnerArgs(root: string, config: FeedbackConfig) {
  const given = configFromTestArgs(config.testArgs);
  return (tests: string[], directory: string) => {
    const file = join(directory, 'vitest.config.mjs');
    writeFileSync(
      file,
      generatedConfig(
        given === undefined ? foundVitestConfig(root) : resolve(root, given),
        tests.map((path) => excludePattern(root, path)),
      ),
    );
    return ['--runner', 'vitest', '--config', file];
  };
}
