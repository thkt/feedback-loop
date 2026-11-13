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
import {
  applyCommand,
  bunRuntime,
  cancelWithoutLeftovers,
  nodeRuntime,
} from './support/feedback-loop-cancellation.ts';

const vitestConfig = createVitestConfig(config);
const vitestFiles = {
  '.gitignore': 'node_modules\n',
  'test/b.test.ts': `${vitestHeader}test('b', () => expect(1).toBe(1));\n`,
};

function generated(
  f: Fixture,
  executable: string,
  mode: 'affected' | 'classification',
  ...args: string[]
) {
  const result = spawnSync(executable, ['scripts/feedback-loop/runtime.mjs', mode, ...args], {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 15000,
    env: baseEnv(f),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}

// 収集のコマンドは、CANCEL_TRACEがあれば自分と親のPIDを書いて待ち続け、なければ一覧を返す。
function collectingFiles(runnerConfig: Record<string, unknown>, testHeader: string, testB: string) {
  return {
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
  };
}

/** 取消のない実行で、分類検査の標準出力がJSONだけで準備を実行せず、関連実行が成功することを確かめる。 */
function expectCollectionWorks(f: Fixture, executable: string) {
  const classified = generated(f, executable, 'classification', '--json');
  expect(JSON.parse(classified.stdout)).toMatchObject({
    quality: ['test/a.test.ts', 'test/b.test.ts'],
    assurance: [],
  });
  expect(classified.stdout).not.toContain('COLLECT_DIAGNOSTIC');
  expect(classified.stdout + classified.stderr).not.toContain('PREPARE_COMPLETED');
  generated(f, executable, 'affected');
}

test('Bunの実行部が収集中にSIGTERMを受けると、収集のコマンドが残らず、次の実行は関連選択へ戻る', async () => {
  await fixture(collectingFiles(config, header, files['test/b.test.ts']), async (f) => {
    installed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    expectCollectionWorks(f, process.execPath);
    const cancelled = await cancelWithoutLeftovers(f, bunRuntime, 'SIGTERM');
    expect(cancelled.aliveBefore).toEqual([true, true]);
    expect(cancelled.code, cancelled.output).not.toBe(0);
    expect(existsSync(join(f.signals, 'test-started'))).toBe(false);
    const repaired = generated(f, process.execPath, 'affected');
    expect(repaired.stdout).toContain('quality選択: 1件');
    expect(repaired.stdout).not.toContain('quality全件の理由:');
  });
}, 20000);

test('Nodeの実行部が収集中にSIGTERMを受けると、収集のコマンドが残らず、次の実行は関連選択へ戻る', async () => {
  const nodeFiles = collectingFiles(vitestConfig, vitestHeader, vitestFiles['test/b.test.ts']);
  await fixture(nodeFiles, async (f) => {
    await symlink(vitestModules, join(f.repo, 'node_modules'));
    installed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    expectCollectionWorks(f, 'node');
    const cancelled = await cancelWithoutLeftovers(f, nodeRuntime, 'SIGTERM');
    expect(cancelled.aliveBefore).toEqual([true, true]);
    expect(cancelled.code, cancelled.output).not.toBe(0);
    expect(existsSync(join(f.signals, 'test-started'))).toBe(false);
    const repaired = generated(f, 'node', 'affected');
    expect(repaired.stdout).toContain('quality選択: 1件');
    expect(repaired.stdout).not.toContain('quality全件の理由:');
  });
}, 20000);

test('applyが収集中にSIGTERMを受けると、収集のコマンドが残らず、applyをやり直せば関連実行へ戻る', async () => {
  await fixture(collectingFiles(config, header, files['test/b.test.ts']), async (f) => {
    installed(f);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    expectCollectionWorks(f, process.execPath);
    const cancelled = await cancelWithoutLeftovers(f, applyCommand(f), 'SIGTERM');
    expect(cancelled.aliveBefore).toEqual([true, true]);
    expect(cancelled.code, cancelled.output).not.toBe(0);
    expect(existsSync(join(f.signals, 'test-started'))).toBe(false);
    const reapplied = applyFeedback(f, 'bun run check:affected', run);
    expect(reapplied.code, reapplied.output).toBe(0);
    const repaired = generated(f, process.execPath, 'affected');
    expect(repaired.stdout).toContain('quality選択: 1件');
    expect(repaired.stdout).not.toContain('quality全件の理由:');
  });
}, 20000);

// stderrを書き続ける準備と、書かない準備の両方で確かめる。
for (const stderr of ['0', '1']) {
  test(`準備の実行中（stderrの継続=${stderr}）にホストがプロセスグループを強制終了すると、準備へ取消が伝わり、1秒後に強制終了されて処理が残らない`, async () => {
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
  process.on('SIGTERM', () => writeFileSync(process.env.CANCEL_TRACE + '.term', String(Date.now())));
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
        const cancelled = await cancelWithoutLeftovers(f, nodeRuntime, 'group SIGKILL', {
          CANCEL_STDERR: stderr,
        });
        expect(cancelled.aliveBefore).toEqual([true, true]);
        // 準備処理はSIGTERMを受けた時刻を書いて動き続ける。猶予の1秒が過ぎてから強制終了される。
        const termAt = Number(await readFile(join(f.signals, 'cancel-trace.json.term'), 'utf8'));
        expect(cancelled.goneAt - termAt).toBeGreaterThanOrEqual(950);
        expect(existsSync(join(f.signals, 'test-started'))).toBe(false);
        const repaired = generated(f, 'node', 'affected');
        expect(repaired.stdout.match(/PREPARE_COMPLETED/g)).toHaveLength(1);
        expect(repaired.stdout).toContain('quality選択:');
      },
    );
  }, 20000);
}
