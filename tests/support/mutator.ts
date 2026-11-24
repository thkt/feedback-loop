import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files } from './feedback-loop-batch.ts';
import { vitestModules } from './vitest.ts';

export const mutatorConfig = {
  ...config,
  bunWorkers: 1,
  testArgs: ['--timeout', '4000'],
};

export const mutatorFiles = {
  ...files,
  '.gitignore': 'node_modules\n',
  '.feedback-loop.json': JSON.stringify(mutatorConfig),
};

export async function linkModules(directory: string) {
  await symlink(vitestModules, join(directory, 'node_modules'));
}
