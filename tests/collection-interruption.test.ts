import {
  vitestConfig as createVitestConfig,
  vitestModules,
  vitestHeader,
} from './support/vitest.ts';
import { applyFeedback } from './support/feedback-loop-batch.ts';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  baseEnv,
  config,
  files,
  fixture,
  header,
  installed,
  run,
} from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';
import { cancelFeedbackCommand } from './support/feedback-loop-cancellation.ts';

const vitestConfig = createVitestConfig(config);
const vitestFiles = {
  '.gitignore': 'node_modules\n',
  'test/b.test.ts': `${vitestHeader}test('b', () => expect(1).toBe(1));\n`,
};

function generated(f: Fixture, executable: string, mode: 'affected' | 'classification') {
  const result = spawnSync(executable, ['scripts/feedback-loop/runtime.mjs', mode], {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 15000,
    env: baseEnv(f),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}

for (const {
  target,
  executable,
  runnerConfig,
  testHeader,
  testB,
  modules,
  cancelTarget,
  reapply,
} of [
  {
    target: 'Bun',
    executable: process.execPath,
    runnerConfig: config,
    testHeader: header,
    testB: files['test/b.test.ts'],
    modules: [],
    cancelTarget: 'runtime',
    reapply: [],
  },
  {
    target: 'Node',
    executable: 'node',
    runnerConfig: vitestConfig,
    testHeader: vitestHeader,
    testB: vitestFiles['test/b.test.ts'],
    modules: [vitestModules],
    cancelTarget: 'runtime',
    reapply: [],
  },
  {
    target: 'apply',
    executable: process.execPath,
    runnerConfig: config,
    testHeader: header,
    testB: files['test/b.test.ts'],
    modules: [],
    cancelTarget: 'apply',
    reapply: ['bun run test:affected'],
  },
] as const) {
  test(`${target}公開入口の収集中取消はcollectorとpipeを回収し、次回実行へ復帰する`, async () => {
    await fixture(
      {
        ...files,
        '.gitignore': 'node_modules\n',
        'test/b.test.ts': testB,
        '.feedback-loop.json': JSON.stringify({
          ...runnerConfig,
          collect: ['node', 'scripts/collect.mjs'],
          prepare: [process.execPath, '-e', "console.log('PREPARE_COMPLETED')"],
        }),
        'scripts/collect.mjs': `import { readdirSync, writeFileSync } from 'node:fs';
if (process.env.CANCEL_TRACE) {
  writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
  setInterval(() => {}, 1000);
} else {
  console.error('COLLECT_DIAGNOSTIC');
  const paths = readdirSync('test').filter(path => path.endsWith('.test.ts')).map(path => 'test/' + path);
  console.log(JSON.stringify(paths).replace(',', ',' + ' '.repeat(256 * 1024)));
}
`,
        'test/a.test.ts': `${testHeader}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
if (process.env.CANCEL_STARTED) writeFileSync(process.env.CANCEL_STARTED, 'started');
test('a', () => expect(value).toBeGreaterThan(0));
`,
      },
      async (f) => {
        for (const path of modules) {
          await symlink(path, join(f.repo, 'node_modules'));
        }
        installed(f);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const classified = generated(f, executable, 'classification');
        expect(JSON.parse(classified.stdout)).toMatchObject({
          quality: ['test/a.test.ts', 'test/b.test.ts'],
          assurance: [],
        });
        expect(classified.stdout).not.toContain('COLLECT_DIAGNOSTIC');
        expect(classified.stdout + classified.stderr).not.toContain('PREPARE_COMPLETED');
        generated(f, executable, 'affected');
        const cancelled = await cancelFeedbackCommand(f, cancelTarget);
        expect(cancelled.aliveBefore).toEqual([true, true]);
        expect(cancelled.code, cancelled.output).not.toBe(0);
        expect(cancelled.remaining, '取消後も起動した処理が残っています').toEqual([]);
        expect(existsSync(join(f.signals, 'test-started'))).toBe(false);
        for (const feedbackCommand of reapply) {
          const reapplied = applyFeedback(f, feedbackCommand, run);
          expect(reapplied.code, reapplied.output).toBe(0);
        }
        const repaired = generated(f, executable, 'affected');
        expect(repaired.stdout).toContain('quality選択: 1件');
        expect(repaired.stdout).not.toContain('quality全件の理由:');
      },
    );
  }, 20000);
}

for (const stderr of ['0', '1']) {
  test(`Node準備処理のstderr継続=${stderr}でホストtimeout後も子とpipeを回収する`, async () => {
    await fixture(
      {
        ...files,
        ...vitestFiles,
        '.feedback-loop.json': JSON.stringify({
          ...vitestConfig,
          prepare: ['node', 'scripts/prepare.mjs'],
        }),
        'scripts/prepare.mjs': `import { writeFileSync } from 'node:fs';
if (process.env.CANCEL_TRACE) {
  process.on('SIGTERM', () => writeFileSync(process.env.CANCEL_TRACE + '.term', 'received'));
  process.stderr.on('error', () => {});
  writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
  setInterval(() => {
    if (process.env.CANCEL_STDERR === '1') process.stderr.write('PREPARE_RUNNING\\n');
  }, 10);
} else console.log('PREPARE_COMPLETED');
`,
        'test/a.test.ts': `${vitestHeader}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
if (process.env.CANCEL_STARTED) writeFileSync(process.env.CANCEL_STARTED, 'started');
test('a', () => expect(value).toBeGreaterThan(0));
`,
      },
      async (f) => {
        await symlink(vitestModules, join(f.repo, 'node_modules'));
        installed(f);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const control = generated(f, 'node', 'affected');
        expect(control.stdout.match(/PREPARE_COMPLETED/g)).toHaveLength(1);
        const cancelled = await cancelFeedbackCommand(f, 'host', {
          timeoutMs: 700,
          env: { CANCEL_STDERR: stderr },
        });
        expect(cancelled.aliveBefore).toEqual([true, true]);
        expect(cancelled.outcome).toMatchObject({ result: { timedOut: true } });
        expect(cancelled.outcome).not.toMatchObject({ result: { code: 0 } });
        expect(cancelled.remaining, '取消後も起動した処理が残っています').toEqual([]);
        expect(await readFile(join(f.signals, 'cancel-trace.json.term'), 'utf8')).toBe('received');
        expect(existsSync(join(f.signals, 'test-started'))).toBe(false);
        const repaired = generated(f, 'node', 'affected');
        expect(repaired.stdout.match(/PREPARE_COMPLETED/g)).toHaveLength(1);
        expect(repaired.stdout).toContain('quality選択:');
      },
    );
  }, 20000);
}
