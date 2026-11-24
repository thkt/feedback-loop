import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FeedbackConfig } from './config.ts';
import { excludePattern } from './vitest.ts';

const projectsMessage = 'test.projects を持つ Vitest の設定では、mutation を使えません';

const configNames = ['vitest.config', 'vite.config'];
const configExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];

function configFromTestArgs(testArgs: string[]) {
  let value: string | undefined;
  for (const [index, arg] of testArgs.entries()) {
    if (arg === '--config') {
      value = testArgs[index + 1];
    } else if (arg.startsWith('--config=')) {
      value = arg.slice('--config='.length);
    }
  }
  return value;
}

function repoVitestConfig(root: string, config: FeedbackConfig) {
  const given = configFromTestArgs(config.testArgs);
  if (given !== undefined) {
    return resolve(root, given);
  }
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
  return { ...resolved, test: { ...resolved.test, include: ${JSON.stringify(include)} } };
};
`;
}

export function vitestRunnerArgs(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  directory: string,
) {
  const file = join(directory, 'vitest.config.mjs');
  writeFileSync(
    file,
    generatedConfig(
      repoVitestConfig(root, config),
      quality.map((path) => excludePattern(root, path)),
    ),
  );
  return ['--runner', 'vitest', '--config', file];
}
