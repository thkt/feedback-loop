import { expect, test } from 'bun:test';
import { generate, generateCommitHook } from '../scripts/build.ts';

test('bundleする生成物はminifyせず100行以上に保つ。生成物は導入先とこのrepoにcommitされ、minifyするとapply --updateと再生成のたびに差分がほぼ全行の書き換えになるため', async () => {
  const files = await generate();
  const bundled = [
    ['scripts/setup.mjs', files.get('scripts/setup.mjs')],
    ['scripts/runtime.mjs', files.get('scripts/runtime.mjs')],
    ['hooks/commit-hook.mjs', await generateCommitHook()],
  ] as const;
  for (const [path, body] of bundled) {
    expect(body, path).toBeString();
    expect(body?.split('\n').length, path).toBeGreaterThanOrEqual(100);
  }
});
