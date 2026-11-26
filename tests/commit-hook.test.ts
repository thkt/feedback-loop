import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCommitHook } from '../scripts/build.ts';
import { baseEnv, fixture } from './support/runner-affected.ts';
import type { Fixture } from './support/runner-affected.ts';
import { isRecord } from './support/json.ts';

const hookRoot = mkdtempSync(join(tmpdir(), 'commit-hook-'));
const hookScript = join(hookRoot, 'commit-hook.mjs');
writeFileSync(hookScript, await generateCommitHook());

afterAll(() => {
  rmSync(hookRoot, { recursive: true, force: true });
});

const checkOutput = 'CHECK_FEEDBACK_OUTPUT';
const checkScript = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FEEDBACK_HOOK_MARK, process.cwd() + '\\n');
console.log('${checkOutput}');
console.error('CHECK_FEEDBACK_STDERR');
process.exit(Number(process.env.FEEDBACK_HOOK_EXIT ?? 0));
`;

function feedbackPackage(directory: string, config: Record<string, unknown> = {}) {
  const prefix = directory === '' ? '' : `${directory}/`;
  return {
    [`${prefix}.feedback-loop.json`]: JSON.stringify({
      runner: 'bun',
      testGlobs: ['tests/*.test.ts'],
      ...config,
    }),
    [`${prefix}package.json`]: JSON.stringify({
      packageManager: 'bun@1.4.4',
      scripts: { 'check:feedback': 'node check.mjs' },
    }),
    [`${prefix}check.mjs`]: checkScript,
  };
}

function markFile(f: Fixture) {
  return join(f.signals, 'check-feedback-ran');
}

function runHook(f: Fixture, command: string, options: { exit?: number; cwd?: string } = {}) {
  rmSync(markFile(f), { force: true });
  const result = spawnSync('node', [hookScript], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      cwd: options.cwd ?? f.repo,
    }),
    encoding: 'utf8',
    env: {
      ...baseEnv(f),
      FEEDBACK_HOOK_MARK: markFile(f),
      FEEDBACK_HOOK_EXIT: String(options.exit ?? 0),
    },
  });
  const ran = existsSync(markFile(f)) ? readFileSync(markFile(f), 'utf8').trim().split('\n') : [];
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, ran };
}

function denyOutput(stdout: string) {
  const lines = stdout.split('\n').filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  const output: unknown = JSON.parse(String(lines[0]));
  expect(isRecord(output) && Object.keys(output)).toEqual(['hookSpecificOutput']);
  const specific = isRecord(output) ? output.hookSpecificOutput : undefined;
  expect(isRecord(specific) && specific.hookEventName).toBe('PreToolUse');
  expect(isRecord(specific) && specific.permissionDecision).toBe('deny');
  return isRecord(specific) ? String(specific.permissionDecisionReason) : '';
}

async function change(f: Fixture, path = 'change.txt') {
  await writeFile(join(f.repo, path), 'changed\n');
}

test('git commitで始まるコマンドを含まないコマンドでは、check:feedbackを実行せず、何も出さずに通す', async () => {
  await fixture(feedbackPackage(''), async (f) => {
    await change(f);
    for (const command of [
      'echo git commit',
      "cat <<'EOF'\ngit commit -m x\nEOF",
      'cat <<-EOF\n\tgit commit -m x\n\tEOF',
      'git -C sub commit -m x',
      'git commit-tree HEAD^{tree}',
      'git status',
    ]) {
      const result = runHook(f, command);
      expect(result, command).toEqual({ code: 0, stdout: '', stderr: '', ran: [] });
    }
  });
});

test('区切りの後や環境変数の代入の後、heredocの終わりの後のgit commitでは、check:feedbackを実行する', async () => {
  await fixture(feedbackPackage(''), async (f) => {
    await change(f);
    for (const command of [
      'git add -A && git commit -m x',
      'A=1 git commit -m x',
      'git status; git commit -m x',
      'false || git commit -m x',
      "cat <<'EOF' > msg\nbody\nEOF\ngit commit -F msg",
    ]) {
      const result = runHook(f, command);
      expect(result.ran, command).toEqual([f.repo]);
    }
  });
});

test('check:feedbackが失敗すると、終了0で、check:feedbackの出力を理由に持つdenyのJSONを1行だけ出す', async () => {
  await fixture(feedbackPackage(''), async (f) => {
    await change(f);
    const result = runHook(f, 'git commit -m x', { exit: 1 });
    expect(result.code).toBe(0);
    expect(result.ran).toEqual([f.repo]);
    const reason = denyOutput(result.stdout);
    expect(reason).toContain('.: check:feedback');
    expect(reason).toContain(checkOutput);
    expect(reason).toContain('CHECK_FEEDBACK_STDERR');
  });
});

test('check:feedbackが成功すると、何も出さずに終了0で通す', async () => {
  await fixture(feedbackPackage(''), async (f) => {
    await change(f);
    const result = runHook(f, 'git commit -m x');
    expect(result).toEqual({ code: 0, stdout: '', stderr: '', ran: [f.repo] });
  });
});

test('commitHookがfalseなら、check:feedbackを実行せず、trueなら実行する', async () => {
  await fixture(feedbackPackage('', { commitHook: false }), async (f) => {
    await change(f);
    expect(runHook(f, 'git commit -m x', { exit: 1 })).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
      ran: [],
    });
    await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify({ commitHook: true }));
    expect(runHook(f, 'git commit -m x').ran).toEqual([f.repo]);
  });
});

test('commitHookがfalse以外の値なら、check:feedbackを実行する', async () => {
  await fixture(feedbackPackage('', { commitHook: 'false' }), async (f) => {
    await change(f);
    expect(runHook(f, 'git commit -m x').ran).toEqual([f.repo]);
  });
});

test('.feedback-loop.jsonが無いrepoでは、check:feedbackを実行しない', async () => {
  const { '.feedback-loop.json': _, ...files } = feedbackPackage('');
  await fixture(files, async (f) => {
    await change(f);
    expect(runHook(f, 'git commit -m x', { exit: 1 })).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
      ran: [],
    });
    await writeFile(join(f.repo, '.feedback-loop.json'), '{}');
    expect(runHook(f, 'git commit -m x').ran).toEqual([f.repo]);
  });
});

test('作業ツリーに変更が無ければ、check:feedbackを実行しない', async () => {
  await fixture(feedbackPackage(''), async (f) => {
    expect(runHook(f, 'git commit --allow-empty -m x', { exit: 1 })).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
      ran: [],
    });
    await change(f);
    expect(runHook(f, 'git commit -m x').ran).toEqual([f.repo]);
  });
});

test('2つのpackageのうち変更のあるpackageでだけcheck:feedbackを実行し、成功すればcommitを止めない', async () => {
  await fixture({ ...feedbackPackage('a'), ...feedbackPackage('b') }, async (f) => {
    await change(f, 'b/change.txt');
    const result = runHook(f, 'git commit -m x');
    expect(result).toEqual({ code: 0, stdout: '', stderr: '', ran: [join(f.repo, 'b')] });
  });
});

test('package.jsonにcheck:feedbackのscriptが無いディレクトリの.feedback-loop.jsonは対象にしない', async () => {
  await fixture(
    {
      ...feedbackPackage('pkg'),
      'fixtures/sample/.feedback-loop.json': JSON.stringify({ runner: 'bun' }),
      'fixtures/sample/package.json': JSON.stringify({ packageManager: 'bun@1.4.4' }),
    },
    async (f) => {
      await change(f, 'fixtures/sample/change.txt');
      await change(f, 'pkg/change.txt');
      const result = runHook(f, 'git commit -m x');
      expect(result).toEqual({ code: 0, stdout: '', stderr: '', ran: [join(f.repo, 'pkg')] });
    },
  );
});

test('名前に日本語を含むディレクトリのpackageでも、check:feedbackを実行する', async () => {
  await fixture(feedbackPackage('パッケージ'), async (f) => {
    await change(f, 'パッケージ/change.txt');
    expect(runHook(f, 'git commit -m x').ran).toEqual([join(f.repo, 'パッケージ')]);
  });
});

test('Gitのルートより下のpackageでは、作業ディレクトリによらず、そのディレクトリでcheck:feedbackを実行する', async () => {
  await fixture(feedbackPackage('packages/app'), async (f) => {
    await change(f, 'packages/app/change.txt');
    const result = runHook(f, 'git commit -m x', { exit: 1, cwd: join(f.repo, 'packages') });
    expect(result.ran).toEqual([join(f.repo, 'packages/app')]);
    expect(denyOutput(result.stdout)).toContain('packages/app: check:feedback');
  });
});

test('package managerを決められないディレクトリでは、check:feedbackを実行せず、標準エラーに理由を1行出して通す', async () => {
  const files = feedbackPackage('');
  await fixture(
    {
      ...files,
      'package.json': JSON.stringify({ scripts: { 'check:feedback': 'node check.mjs' } }),
    },
    async (f) => {
      await change(f);
      const result = runHook(f, 'git commit -m x', { exit: 1 });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.ran).toEqual([]);
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain('package managerを判定できません');
    },
  );
});

test('Gitの外の作業ディレクトリでは、何も出さずに通す', async () => {
  await fixture(feedbackPackage(''), async (f) => {
    await change(f);
    expect(runHook(f, 'git commit -m x').ran).toEqual([f.repo]);
    expect(runHook(f, 'git commit -m x', { cwd: f.signals })).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
      ran: [],
    });
  });
});
