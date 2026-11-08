import { expect, test } from 'bun:test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cancelFeedbackCommand } from './support/feedback-loop-cancellation.ts';
import {
  config,
  files,
  fixture,
  header,
  installed,
  recordFile,
  run,
  seed,
} from './support/feedback-loop-batch.ts';

for (const cancellation of ['timeout', 'SIGTERM'] as const) {
  test(`ホストの${cancellation}取消は生成入口のBun leader・workerとpipeを解放する`, async () => {
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
        const original = await seed(f);
        await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
        const cancelled = await cancelFeedbackCommand(f, 'host', {
          ...(cancellation === 'timeout' ? { timeoutMs: 500 } : {}),
          bunExecutable: process.execPath,
        });
        expect(cancelled.executable).toBe('bun');
        expect(await readFile(recordFile(f.repo), 'utf8')).toBe(original);
        await unlink(join(f.repo, 'new-input.txt'));
        const repaired = run(f, ['run', 'test:affected']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output).toContain('quality選択: 1');
        expect(repaired.output).not.toContain('quality全件の理由:');
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
        const affected = run(f, ['run', 'test:affected']);
        expect(affected.code, affected.output).toBe(0);
        expect(affected.output).toContain('quality選択: 1');
        expect(affected.output).not.toContain('quality全件の理由:');
        expect(await readFile(recordFile(f.repo), 'utf8')).not.toBe(original);
      },
    );
  }, 20000);
}
