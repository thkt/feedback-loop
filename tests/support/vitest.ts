import { resolve } from 'node:path';

export const vitestModules = resolve(import.meta.dir, '../../node_modules');
export const vitestHeader = "import { test, expect } from 'vitest';\n";

export function vitestConfig<T extends { bunArgs?: unknown }>(config: T) {
  const result = { ...config, runner: 'vitest', testArgs: ['--pool', 'forks'] };
  Reflect.deleteProperty(result, 'bunArgs');
  return result;
}
