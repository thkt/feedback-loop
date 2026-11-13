import {
  vitestConfig as createVitestConfig,
  vitestModules,
  vitestHeader,
} from './support/vitest.ts';
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  config,
  files,
  fixture,
  header,
  installed,
  run,
  seed,
} from './support/feedback-loop-batch.ts';
import {
  bunRuntime,
  cancelWithoutLeftovers,
  forceKill,
  nodeRuntime,
  waitFor,
} from './support/feedback-loop-cancellation.ts';
import { isRecord } from './support/json.ts';
import { baseEnv } from './support/runner-affected.ts';

// prepareは、CANCEL_TRACEがあれば、自分と親のPIDを書いて待ち続ける。親は監視プロセスである。
const prepareFiles = {
  ...files,
  '.feedback-loop.json': JSON.stringify({
    ...config,
    prepare: [process.execPath, '--no-env-file', 'scripts/prepare.ts'],
  }),
  'scripts/prepare.ts': `import { writeFileSync } from 'node:fs';
if (process.env.CANCEL_TRACE) {
  writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
  setInterval(() => {}, 1000);
} else console.log('PREPARE_COMPLETED');\n`,
  'test/a.test.ts': `${header}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
if (process.env.CANCEL_STARTED) writeFileSync(process.env.CANCEL_STARTED, 'started');
test('a', () => { expect(value).toBeGreaterThan(0); console.log('QUALITY_A_COMPLETED'); });\n`,
};

// SIGTERMでは実行部が終了コード1で終わる。プロセスグループの強制終了では、終了コードは残らない。
for (const { how, cancellation, code } of [
  { how: 'group SIGKILL', cancellation: 'ホストがプロセスグループを強制終了', code: null },
  { how: 'SIGTERM', cancellation: '実行部へSIGTERMを送信', code: 1 },
] as const) {
  test(`prepareの実行中に${cancellation}すると、処理が残らず、テスト本体を開始しない`, async () => {
    await fixture(prepareFiles, async (f) => {
      installed(f);
      await seed(f);
      const cancelled = await cancelWithoutLeftovers(f, bunRuntime, how);
      expect(cancelled.aliveBefore).toEqual([true, true]);
      expect(cancelled.code, cancelled.output).toBe(code);
      if (how === 'SIGTERM') {
        // 取消の理由を示す行は、コマンドを止めたシグナルを示す1行だけである。
        expect(
          cancelled.output.split('\n').filter((line) => line.includes('未完了')),
          cancelled.output,
        ).toEqual(['feedback-loop未完了: 検査失敗または取消: SIGTERM']);
      }
      expect(
        existsSync(join(f.signals, 'test-started')),
        '準備中の取消後にテスト本体が開始しました',
      ).toBe(false);
      const repaired = run(f, ['run', 'check:affected']);
      expect(repaired.code, repaired.output).toBe(0);
      expect(repaired.output.match(/PREPARE_COMPLETED/g)).toHaveLength(1);
      expect(repaired.output).toContain('QUALITY_A_COMPLETED');
      expect(repaired.output).toContain('quality選択: 1');
      expect(repaired.output).not.toContain('quality全件の理由:');
    });
  }, 20000);

  test(`Vitestの実行中に${cancellation}すると、CLIとworkerが残らず、成功として扱わない`, async () => {
    const vitestConfig = createVitestConfig(config);
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify(vitestConfig),
        '.gitignore': 'node_modules\n',
        'test/a.test.ts': `${vitestHeader}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
test('a', async () => {
  if (process.env.CANCEL_TRACE) {
    writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
    await new Promise(() => {});
  }
  expect(value).toBeGreaterThan(0);
}, 30000);\n`,
        'test/b.test.ts': `${vitestHeader}test('b', () => expect(1).toBe(1));\n`,
      },
      async (f) => {
        await symlink(vitestModules, join(f.repo, 'node_modules'));
        installed(f);
        await writeFile(join(f.repo, 'scripts/changed.ts'), 'export {};\n');
        const control = run(f, ['run', 'check:affected']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain('quality選択: 2');
        const cancelled = await cancelWithoutLeftovers(f, nodeRuntime, how);
        expect(cancelled.aliveBefore).toEqual([true, true]);
        expect(cancelled.code, cancelled.output).toBe(code);
        if (how === 'SIGTERM') {
          // Node.jsで起動した実行部も、取消の理由を示す行を1回だけ表示する。
          expect(
            cancelled.output.split('\n').filter((line) => line.includes('未完了')),
            cancelled.output,
          ).toHaveLength(1);
        }
        const repaired = run(f, ['run', 'check:affected']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output).toContain('quality選択: 2');
      },
    );
  }, 20000);
}

test('監視プロセスだけが強制終了されたら、実行部が理由を示す行を1回だけ表示する', async () => {
  await fixture(prepareFiles, async (f) => {
    installed(f);
    await seed(f);
    const trace = join(f.signals, 'cancel-trace.json');
    const [executable, ...args] = bunRuntime;
    assert(executable);
    const child = spawn(executable, args, {
      cwd: f.repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...baseEnv(f), CANCEL_TRACE: trace },
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });
    // 残ったprepareが標準出力を持ち続けるため、closeではなく、終了と標準エラーの終わりを待つ。
    const exited = new Promise<number | null>((done) => {
      child.once('exit', done);
    });
    const drained = new Promise<void>((done) => {
      child.stderr.once('end', done);
    });
    let command: number | undefined;
    try {
      await waitFor(
        () => existsSync(trace) && statSync(trace).size > 0,
        () => `prepareへ到達しません: ${output}`,
      );
      const observed: unknown = JSON.parse(readFileSync(trace, 'utf8'));
      assert(
        isRecord(observed) &&
          typeof observed.child === 'number' &&
          typeof observed.parent === 'number',
      );
      command = observed.child;
      // 強制終了された監視プロセスは、診断を表示できない。
      process.kill(observed.parent, 'SIGKILL');
      expect(await exited, output).toBe(1);
      await drained;
      expect(
        output.split('\n').filter((line) => line.includes('未完了')),
        output,
      ).toEqual(['feedback-loop未完了: 検査失敗または取消: SIGKILL']);
    } finally {
      // 監視プロセスを失ったprepareは残る。
      if (command !== undefined) {
        forceKill(command);
      }
      child.kill('SIGKILL');
    }
  });
}, 20000);
