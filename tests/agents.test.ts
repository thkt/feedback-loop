import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { files, fixture, runSetup as run, setup, snapshot } from './support/feedback-loop-batch.ts';
import type { Fixture } from './support/feedback-loop-batch.ts';

function apply(f: Fixture, manager = 'bun', extra: string[] = []) {
  return run(f, [
    setup,
    'apply',
    '--repo',
    f.repo,
    '--feedback-command',
    `${manager} run check:affected`,
    ...extra,
  ]);
}

for (const { manager, origin, scripts, extra, expected } of [
  {
    manager: 'bun',
    origin: 'check script',
    scripts: {
      check: 'echo check',
    },
    extra: [],
    expected:
      '## 変更後の確認\n\nコードやテストを変更したら、作業を終える前に`bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では`bun run check`も実行する。`check:feedback`の成功を全体checkの成功として報告しない。\n',
  },
  {
    manager: 'pnpm',
    origin: 'check script',
    scripts: {
      check: 'echo check',
    },
    extra: [],
    expected:
      '## 変更後の確認\n\nコードやテストを変更したら、作業を終える前に`pnpm run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では`pnpm run check`も実行する。`check:feedback`の成功を全体checkの成功として報告しない。\n',
  },
  {
    manager: 'npm',
    origin: '指定した全体check',
    scripts: {
      verify: 'echo verify',
    },
    extra: ['--check-command', 'npm run verify'],
    expected:
      '## 変更後の確認\n\nコードやテストを変更したら、作業を終える前に`npm run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では`npm run verify`も実行する。`check:feedback`の成功を全体checkの成功として報告しない。\n',
  },
]) {
  test(`applyは${manager}のAGENTS.mdを${origin}で作り、CLAUDE.mdの先頭で読み込み、再実行では変えない`, async () => {
    await fixture(
      {
        ...files,
        'package.json': JSON.stringify({
          packageManager: `${manager}@1.4.4`,
          scripts,
        }),
        'CLAUDE.md': '# Claude\n',
      },
      async (f) => {
        const result = apply(f, manager, extra);
        expect(result.code, result.output).toBe(0);
        expect(await readFile(join(f.repo, 'AGENTS.md'), 'utf8')).toBe(expected);
        expect(await readFile(join(f.repo, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n# Claude\n');
        const before = await snapshot(f.repo);
        const repeated = apply(f, manager, extra);
        expect(repeated.code, repeated.output).toBe(0);
        expect(repeated.stdout).toContain('既存の内容を保持します');
        expect(await snapshot(f.repo)).toEqual(before);
      },
    );
  });
}

for (const { name, given, expected, printed } of [
  {
    name: '見出しのないAGENTS.mdには末尾へ節を足す',
    printed: '配置: AGENTS.md',
    given: { 'AGENTS.md': '# Project' },
    expected: {
      'AGENTS.md':
        '# Project\n\n## 変更後の確認\n\nコードやテストを変更したら、作業を終える前に`bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では`bun run check`も実行する。`check:feedback`の成功を全体checkの成功として報告しない。\n',
    },
  },
  {
    name: '同じ見出しのAGENTS.mdは内容によらず残す',
    given: { 'AGENTS.md': '## 変更後の確認\n\n独自の検証指示\n' },
    expected: { 'AGENTS.md': '## 変更後の確認\n\n独自の検証指示\n' },
    printed: 'AGENTS.mdの「## 変更後の確認」は既存の内容を保持します',
  },
  {
    name: '途中に@AGENTS.mdの行があるCLAUDE.mdは残す',
    printed: '配置: AGENTS.md',
    given: { 'CLAUDE.md': '# Claude\n@AGENTS.md\n独自の指示\n' },
    expected: { 'CLAUDE.md': '# Claude\n@AGENTS.md\n独自の指示\n' },
  },
]) {
  test(`applyは${name}`, async () => {
    await fixture({ ...files, ...given }, async (f) => {
      const result = apply(f);
      expect(result.code, result.output).toBe(0);
      expect(await snapshot(f.repo)).toMatchObject(expected);
      expect(result.stdout.split('\n')).toContain(printed);
    });
  });
}

test('applyはCLAUDE.local.mdだけなら変えずに追加を案内し、CLAUDE.mdを作らない', async () => {
  await fixture({ ...files, 'CLAUDE.local.md': '# Local\n' }, async (f) => {
    const result = apply(f);
    expect(result.code, result.output).toBe(0);
    const after = await snapshot(f.repo);
    expect(after['CLAUDE.local.md']).toBe('# Local\n');
    expect(after['CLAUDE.md']).toBeUndefined();
    expect(result.stdout.split('\n')).toContain(
      'CLAUDE.local.mdは変更しません。利用者が@AGENTS.mdの行を追加してください',
    );
  });
});

// 全体checkのscriptがない導入先。
const withoutCheck = {
  ...files,
  'package.json': JSON.stringify({ packageManager: 'bun@1.4.4', scripts: {} }),
  'CLAUDE.md': '# Claude\n',
};

for (const { name, extra, diagnostic } of [
  {
    name: '全体checkのscriptも指定もない',
    extra: [],
    diagnostic: '全体checkが未指定です。--check-commandに全体checkのコマンドを指定してください',
  },
  {
    name: '--check-commandが空白だけである',
    extra: ['--check-command', '   '],
    diagnostic: '--check-commandの値がありません',
  },
  {
    name: '--check-commandが重複している',
    extra: ['--check-command', 'a', '--check-command', 'b'],
    diagnostic: '--check-commandが重複しています',
  },
  {
    name: '--check-commandに値がない',
    extra: ['--check-command'],
    diagnostic: '--check-commandの値がありません',
  },
]) {
  test(`applyは${name}なら、どのファイルも変えずに止める`, async () => {
    await fixture(withoutCheck, async (f) => {
      const before = await snapshot(f.repo);
      const result = apply(f, 'bun', extra);
      expect(result.code, result.output).toBe(1);
      expect(result.stderr).toContain(`setup-feedback-loop未完了: ${diagnostic}`);
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

test('apply --updateは--check-commandを受け付けず、どのファイルも変えずに止める', async () => {
  await fixture(withoutCheck, async (f) => {
    const before = await snapshot(f.repo);
    const updating = run(f, [setup, 'apply', '--update', '--repo', f.repo, '--check-command', 'a']);
    expect(updating.code, updating.output).toBe(1);
    expect(updating.stderr).toContain('apply --updateでは--check-commandを指定できません');
    expect(await snapshot(f.repo)).toEqual(before);
  });
});

test('apply --updateはAGENTS.mdを作らず、CLAUDE.mdも変えない', async () => {
  await fixture(
    {
      ...files,
      'package.json': JSON.stringify({ packageManager: 'bun@1.4.4' }),
      'CLAUDE.md': '# Custom Claude\n',
    },
    async (f) => {
      const result = run(f, [setup, 'apply', '--update', '--repo', f.repo]);
      expect(result.code, result.output).toBe(0);
      const after = await snapshot(f.repo);
      expect(after['AGENTS.md']).toBeUndefined();
      expect(after['CLAUDE.md']).toBe('# Custom Claude\n');
    },
  );
});
