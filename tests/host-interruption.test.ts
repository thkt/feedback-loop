import { expect, test } from 'bun:test';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bunRuntime, cancelWithoutLeftovers } from './support/feedback-loop-cancellation.ts';
import {
  config,
  files,
  fixture,
  header,
  installed,
  run,
  seed,
} from './support/feedback-loop-batch.ts';

test('ホストがプロセスグループを強制終了しても、Bunのleaderとworkerが残らず、次の実行は関連選択へ戻る', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({ ...config, bunWorkers: 2 }),
      'test/b.test.ts': `${header}import { writeFileSync } from 'node:fs';
test('b', async () => {
  if (process.env.CANCEL_TRACE) {
    writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
    await new Promise(() => {});
  }
  expect(1).toBe(1);
}, 30000);\n`,
    },
    async (f) => {
      installed(f);
      await seed(f);
      await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
      const cancelled = await cancelWithoutLeftovers(f, bunRuntime, 'group SIGKILL');
      expect(cancelled.aliveBefore).toEqual([true, true]);
      await unlink(join(f.repo, 'new-input.txt'));
      const repaired = run(f, ['run', 'check:affected']);
      expect(repaired.code, repaired.output).toBe(0);
      expect(repaired.output).toContain('quality選択: 1');
      expect(repaired.output).not.toContain('quality全件の理由:');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      const affected = run(f, ['run', 'check:affected']);
      expect(affected.code, affected.output).toBe(0);
      expect(affected.output).toContain('quality選択: 1');
      expect(affected.output).not.toContain('quality全件の理由:');
    },
  );
}, 20000);
