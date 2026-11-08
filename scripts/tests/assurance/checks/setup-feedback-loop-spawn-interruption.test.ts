import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { alive, waitFor } from '../../support/feedback-loop-cancellation.ts';

// 実シグナルは既定の終了動作を、同期イベントは起動前の取消の保留を検証します。
for (const cancellation of ['signal', 'SIGTERM', 'SIGINT', 'disconnect']) {
  test(`spawnが返る前の${cancellation}でも監視側が子を強制終了してcloseを待つ`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedback-spawn-cancel-'));
    const trace = join(dir, 'pid');
    const ready = join(dir, 'ready');
    const helper = join(dir, 'helper.mjs');
    const bundle = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../../feedback-loop/command.ts')],
      target: 'node',
    });
    assert(bundle.success && bundle.outputs[0]);
    await writeFile(join(dir, 'command.mjs'), await bundle.outputs[0].text());
    await writeFile(
      helper,
      `import cp from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawn;
cp.spawn = (...args) => {
  const child = original(...args);
  writeFileSync(${JSON.stringify(trace)}, String(child.pid));
  child.once('close', (code, signal) => console.error('TARGET_CLOSE:' + signal));
  const ready = ${JSON.stringify(ready)};
  const deadline = Date.now() + 8000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error('子の起動を確認できません');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  ${cancellation === 'signal' ? "process.kill(process.pid, 'SIGTERM');" : `process.emit(${JSON.stringify(cancellation)});`}
  return child;
};
syncBuiltinESMExports();
const { runMonitor } = await import('./command.mjs');
try {
  await runMonitor();
} catch (error) {
  console.error('feedback-loop未完了: ' + error.message);
  process.exitCode = 1;
}
`,
    );
    const child = spawn('node', [helper], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.send({
      argv: [
        'node',
        '-e',
        `
    const { writeFileSync } = require('node:fs');
    process.on('SIGTERM', () => writeFileSync(${JSON.stringify(ready + '.cancel')}, 'SIGTERM'));
    process.on('SIGINT', () => writeFileSync(${JSON.stringify(ready + '.cancel')}, 'SIGINT'));
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `,
      ],
      env: process.env,
    });
    assert(child.stdout && child.stderr);
    let output = '';
    let exited = false;
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, fail) => {
        child.once('error', fail);
        child.once('exit', (code, signal) => {
          exited = true;
          done({ code, signal });
        });
      },
    );
    let pid: number | undefined;
    try {
      await waitFor(
        () => exited,
        () => `取消後も監視側が終了しません: ${output}`,
      );
      const result = await ended;
      pid = Number(await readFile(trace, 'utf8'));
      expect({ ...result, targetAlive: alive(pid) }, output).toEqual({
        code: 1,
        signal: null,
        targetAlive: false,
      });
      expect(await readFile(ready + '.cancel', 'utf8')).toBe(
        cancellation === 'SIGINT' ? 'SIGINT' : 'SIGTERM',
      );
      expect(output).toContain('TARGET_CLOSE:SIGKILL');
      expect(output).toContain('feedback-loop未完了: 検査失敗または取消: SIGKILL');
    } finally {
      pid ??= Number(await readFile(trace, 'utf8'));
      if (alive(pid)) {
        process.kill(-pid, 'SIGKILL');
      }
      if (child.pid !== undefined && alive(child.pid)) {
        child.kill('SIGKILL');
      }
      await ended;
      await waitFor(
        () => pid !== undefined && !alive(pid),
        () => 'テストの後始末で子プロセスが残りました',
      );
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
}
