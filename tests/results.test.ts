import { expect, test } from 'bun:test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  affectedArgs,
  config,
  files,
  fixture,
  header,
  installed,
  run,
  seed,
} from './support/feedback-loop-batch.ts';
import { failedLine, passedLine } from './support/runner-affected.ts';

// 実Bunが終了した直後のレポート境界に不正を注入し、欠損の種類を個別に確認する。
const reportFault = `const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  const child = original(command, args, options);
  const observe = (args) => {
  const index = args.indexOf('--reporter-outfile');
  if (args.includes('test') && index >= 0 && process.env.REPORT_FAULT) {
    child.prependListener('close', () => {
      const path = args[index + 1];
      if (!fs.existsSync(path)) return;
      let text = fs.readFileSync(path, 'utf8');
      const suite = text.match(/<testsuite\\s[\\s\\S]*?<\\/testsuite>/)?.[0];
      if (!suite) throw new Error('No suite reached the fault boundary');
      const mode = process.env.REPORT_FAULT;
      const root = text.match(/<testsuites\\s[^>]*>/)[0];
      const count = Number(suite.match(/tests="(\\d+)"/)[1]);
      if (mode === 'missing' || mode === 'zero') {
        text = text.replace(root, root.replace(/tests="(\\d+)"/, (_, total) => 'tests="' + (Number(total) - count) + '"'));
        text = text.replace(suite, mode === 'missing' ? '' : suite.replace(/tests="\\d+"/, 'tests="0"').replace(/<testcase[\\s\\S]*?(?:\\/>|<\\/testcase>)/g, ''));
      }
      if (mode === 'count') {
        text = text.replace(root, root.replace(/tests="(\\d+)"/, (_, total) => 'tests="' + (Number(total) + 1) + '"'));
        text = text.replace(suite, suite.replace(/tests="(\\d+)"/, (_, total) => 'tests="' + (Number(total) + 1) + '"'));
      }
      if (mode === 'foreign') text = text.replace(suite, suite.replace(/file="[^"]+"/g, 'file="test/outside.test.ts"'));
      if (mode === 'failure') text = text.replace(suite, suite.replace('failures="0"', 'failures="1"'));
      fs.writeFileSync(path, text);
      fs.appendFileSync(process.env.REPORT_FAULT_MARKER, mode + '\\n');
    });
  }
  };
  observe(args);
  // 監視プロセス経由でも、実行argvを受け取って結果を読む前の境界へ接続する。
  const send = child.send;
  if (typeof send === 'function') child.send = function(message, ...rest) {
    if (message && Array.isArray(message.argv)) observe(message.argv);
    return send.call(this, message, ...rest);
  };
  return child;
};
require('node:module').syncBuiltinESMExports();
`;

for (const { mode, report, diagnostic } of [
  {
    mode: 'missing',
    report: 'ファイルの結果が欠けたJUnit',
    diagnostic: '読み込んだテストとJUnitのファイル集合が一致しません',
  },
  {
    mode: 'zero',
    report: 'テストが0件のファイルを含むJUnit',
    diagnostic: 'JUnitの完了件数が不正または0件です',
  },
  {
    mode: 'count',
    report: '件数が実際のテストと合わないJUnit',
    diagnostic: 'JUnitのファイル別件数が一致しません',
  },
  {
    mode: 'foreign',
    report: '候補にないファイルを含むJUnit',
    diagnostic: 'JUnitに候補外のファイルがあります',
  },
  { mode: 'failure', report: '失敗を記録したJUnit', diagnostic: 'JUnitに失敗が記録されています' },
]) {
  test(`Bunが終了0でも、${report}を成功として記録しない`, async () => {
    await fixture({ ...files, 'scripts/report-fault.cjs': reportFault }, async (f) => {
      installed(f);
      await seed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
      // check:affectedと同じ入口を、レポートを書き換えるpreloadを付けて起動する。
      const pkg: unknown = JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'));
      expect(pkg).toMatchObject({
        scripts: {
          'check:affected': 'bun --no-env-file scripts/feedback-loop/runtime.mjs affected',
        },
      });
      const marker = join(f.signals, 'fault.log');
      const result = run(f, ['--preload', './scripts/report-fault.cjs', ...affectedArgs], {
        REPORT_FAULT: mode,
        REPORT_FAULT_MARKER: marker,
      });
      expect(await readFile(marker, 'utf8'), result.output).toContain(mode);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(`feedback-loop未完了: ${diagnostic}`);
      await unlink(join(f.repo, 'new-input.txt'));
      await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
      await writeFile(
        join(f.repo, 'test/c.test.ts'),
        `${header}test('c', () => expect(1).toBe(1));\n`,
      );
      const repaired = run(f, ['run', 'check:affected']);
      expect(repaired.code, repaired.output).toBe(0);
      expect(repaired.output).toContain('quality選択: 3');
      expect(repaired.output).toContain('依存記録がありません');
    });
  });
}

test('読み込まれた0件ファイルは他ファイルの成功で埋め合わせない', async () => {
  await fixture(files, async (f) => {
    installed(f);
    await seed(f);
    await writeFile(join(f.repo, 'test/b.test.ts'), "console.log('EMPTY_FILE_LOADED');\n");
    const result = run(f, ['run', 'check:affected']);
    expect(result.output).toContain('EMPTY_FILE_LOADED');
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(
      'feedback-loop未完了: 読み込んだテストとJUnitのファイル集合が一致しません',
    );
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts']);
    await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
    await writeFile(
      join(f.repo, 'test/c.test.ts'),
      `${header}test('c', () => expect(1).toBe(1));\n`,
    );
    const repaired = run(f, ['run', 'check:affected']);
    expect(repaired.code, repaired.output).toBe(0);
    expect(repaired.output).toContain(passedLine('b'));
    expect(repaired.output).toContain(passedLine('a'));
    expect(repaired.output).toContain('quality選択: 3');
    expect(repaired.output).toContain('依存記録がありません');
  });
});

test('一部が完了してから失敗しても全候補の記録を部分成功へ更新しない', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({ ...config, bunWorkers: 1 }),
      'test/b.test.ts': header + "test('b', () => expect(process.env.BATCH_FAIL).not.toBe('1'));\n",
      'test/c.test.ts': header + "test('c', () => expect(1).toBe(1));\n",
    },
    async (f) => {
      installed(f);
      await seed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
      const failed = run(f, ['run', 'check:affected'], { BATCH_FAIL: '1' });
      expect(failed.code, failed.output).not.toBe(0);
      expect(failed.output).toContain(passedLine('a'));
      expect(failed.output).toContain(failedLine('b'));
      await unlink(join(f.repo, 'new-input.txt'));
      await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
      await writeFile(
        join(f.repo, 'test/d.test.ts'),
        `${header}test('d', () => expect(1).toBe(1));\n`,
      );
      const repaired = run(f, ['run', 'check:affected']);
      expect(repaired.code, repaired.output).toBe(0);
      expect(repaired.output).toContain('quality選択: 4');
      expect(repaired.output).toContain('依存記録がありません');
    },
  );
});

const grouped = `${header}import { describe } from 'bun:test';
test('top', () => expect(1).toBe(1));
describe('outer', () => {
  test('a', () => expect(process.env.GROUPED_FAIL).not.toBe('1'));
  test.skip('skipped', () => expect(1).toBe(2));
  describe('inner', () => {
    test('b', () => expect(1).toBe(1));
    test.todo('later');
  });
});
`;

test('describeの入れ子とトップレベルのテストが混在しても、成功を終了0にして記録する', async () => {
  await fixture({ ...files, 'test/b.test.ts': grouped }, async (f) => {
    installed(f);
    await seed(f);
    await writeFile(join(f.repo, 'test/b.test.ts'), `${grouped}// changed\n`);
    const related = run(f, ['run', 'check:affected']);
    expect(related.code, related.output).toBe(0);
    expect(related.output).toContain(passedLine('outer > inner > b'));
    // seedの変更が残るためaも選ばれる。全件の理由が出なければ、seedで記録を採用できている。
    expect(related.output).toContain('quality選択: 2');
    expect(related.output).not.toContain('quality全件の理由:');
    const failed = run(f, ['run', 'check:affected'], { GROUPED_FAIL: '1' });
    expect(failed.code, failed.output).not.toBe(0);
    expect(failed.output).toContain(failedLine('outer > a'));
  });
});

test('describeの中のskipとtodoも、allowSkippedがfalseなら拒否する', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({ ...config, allowSkipped: false }),
      'test/b.test.ts': grouped,
    },
    async (f) => {
      installed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      const result = run(f, ['run', 'check:affected']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('許可されていないskipがあります');
    },
  );
});
