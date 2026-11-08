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
    `${manager} run test:affected`,
    ...extra,
  ]);
}

function section(manager: string, check: string) {
  return `## 変更後の確認\n\nコードやテストを変更したら、作業を終える前に\`${manager} run check:feedback\`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assuranceのテストや、影響を判断できない変更では\`${check}\`も実行する。\`check:feedback\`の成功を全体checkの成功として報告しない。\n`;
}

for (const [manager, explicit] of [
  ['bun', false],
  ['npm', true],
] as const) {
  test(`applyは${manager}のAGENTS.mdを${explicit ? '指定した全体check' : 'check script'}で作り、CLAUDE.mdの先頭で読み込み、再実行では変えない`, async () => {
    const check = explicit ? `${manager} run verify` : `${manager} run check`;
    await fixture(
      {
        ...files,
        'package.json': JSON.stringify({
          packageManager: `${manager}@1.4.4`,
          scripts: explicit ? { verify: 'echo verify' } : { check: 'echo check' },
        }),
        'CLAUDE.md': '# Claude\n',
      },
      async (f) => {
        const extra = explicit ? ['--check-command', check] : [];
        const result = apply(f, manager, extra);
        expect(result.code, result.output).toBe(0);
        expect(await readFile(join(f.repo, 'AGENTS.md'), 'utf8')).toBe(section(manager, check));
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

for (const { name, given, expected, notice } of [
  {
    name: '見出しのないAGENTS.mdには末尾へ節を足す',
    given: { 'AGENTS.md': '# Project' },
    expected: { 'AGENTS.md': `# Project\n\n${section('bun', 'bun run check')}` },
  },
  {
    name: '同じ見出しのAGENTS.mdは内容によらず残す',
    given: { 'AGENTS.md': '## 変更後の確認\n\n独自の検証指示\n' },
    expected: { 'AGENTS.md': '## 変更後の確認\n\n独自の検証指示\n' },
    notice: 'AGENTS.mdの「## 変更後の確認」は既存の内容を保持します',
  },
  {
    name: '途中に@AGENTS.mdの行があるCLAUDE.mdは残す',
    given: { 'CLAUDE.md': '# Claude\n@AGENTS.md\n独自の指示\n' },
    expected: { 'CLAUDE.md': '# Claude\n@AGENTS.md\n独自の指示\n' },
  },
  {
    name: 'CLAUDE.local.mdだけなら変えずに追加を案内し、CLAUDE.mdを作らない',
    given: { 'CLAUDE.local.md': '# Local\n' },
    expected: { 'CLAUDE.local.md': '# Local\n', 'CLAUDE.md': undefined },
    notice: 'CLAUDE.local.mdは変更しません。利用者が@AGENTS.mdの行を追加してください',
  },
]) {
  test(`applyは${name}`, async () => {
    await fixture({ ...files, ...given }, async (f) => {
      const result = apply(f);
      expect(result.code, result.output).toBe(0);
      const after = await snapshot(f.repo);
      for (const [path, body] of Object.entries(expected)) {
        expect(after[path]).toBe(body);
      }
      if (notice) {
        expect(result.stdout).toContain(notice);
      }
    });
  });
}

test('applyは全体checkを決められないか指定が不正なら、どのファイルも変えずに止める', async () => {
  await fixture(
    {
      ...files,
      'package.json': JSON.stringify({ packageManager: 'bun@1.4.4', scripts: {} }),
      'CLAUDE.md': '# Claude\n',
    },
    async (f) => {
      const before = await snapshot(f.repo);
      for (const [extra, diagnostic] of [
        [[], '--check-commandに全体checkのコマンドを指定してください'],
        [['--check-command', '   '], '--check-commandに空のコマンドは指定できません'],
        [['--check-command', 'a', '--check-command', 'b'], '--check-commandが重複しています'],
        [['--check-command'], '--check-commandの値がありません'],
      ] as const) {
        const result = apply(f, 'bun', [...extra]);
        expect(result.code, result.output).toBe(1);
        expect(result.stderr).toContain(diagnostic);
      }
      const updating = run(f, [
        setup,
        'apply',
        '--update',
        '--repo',
        f.repo,
        '--check-command',
        'a',
      ]);
      expect(updating.code, updating.output).toBe(1);
      expect(updating.stderr).toContain('--updateと--check-commandは併用できません');
      expect(await snapshot(f.repo)).toEqual(before);
    },
  );
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
