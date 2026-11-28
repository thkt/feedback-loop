import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function runHook(
  f: Fixture,
  command: string,
  options: { exit?: number; cwd?: string; path?: string; length?: number } = {},
) {
  rmSync(markFile(f), { force: true });
  const result = spawnSync('node', [hookScript], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      cwd: options.cwd ?? f.repo,
    }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...baseEnv(f),
      FEEDBACK_HOOK_MARK: markFile(f),
      FEEDBACK_HOOK_EXIT: String(options.exit ?? 0),
      FEEDBACK_HOOK_LENGTH: String(options.length ?? 0),
      ...(options.path === undefined ? {} : { PATH: options.path }),
    },
  });
  const ran = existsSync(markFile(f)) ? readFileSync(markFile(f), 'utf8').trim().split('\n') : [];
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, ran };
}

function onlyLine(stdout: string): unknown {
  const lines = stdout.split('\n').filter((line) => line !== '');
  expect(lines).toHaveLength(1);
  return JSON.parse(String(lines[0]));
}

function denyOutput(stdout: string) {
  const output = onlyLine(stdout);
  expect(isRecord(output) && Object.keys(output)).toEqual(['hookSpecificOutput']);
  const specific = isRecord(output) ? output.hookSpecificOutput : undefined;
  expect(isRecord(specific) && specific.hookEventName).toBe('PreToolUse');
  expect(isRecord(specific) && specific.permissionDecision).toBe('deny');
  return isRecord(specific) ? String(specific.permissionDecisionReason) : '';
}

function skipNotice(stdout: string) {
  const output = onlyLine(stdout);
  expect(isRecord(output) && Object.keys(output).toSorted()).toEqual([
    'hookSpecificOutput',
    'systemMessage',
  ]);
  const specific = isRecord(output) ? output.hookSpecificOutput : undefined;
  expect(specific).toEqual({
    hookEventName: 'PreToolUse',
    additionalContext: isRecord(output) ? output.systemMessage : undefined,
  });
  return isRecord(output) ? String(output.systemMessage) : '';
}

function denyWithNotice(stdout: string) {
  const output = onlyLine(stdout);
  expect(isRecord(output) && Object.keys(output).toSorted()).toEqual([
    'hookSpecificOutput',
    'systemMessage',
  ]);
  const specific = isRecord(output) ? output.hookSpecificOutput : undefined;
  expect(isRecord(specific) && Object.keys(specific).toSorted()).toEqual([
    'hookEventName',
    'permissionDecision',
    'permissionDecisionReason',
  ]);
  expect(isRecord(specific) && specific.hookEventName).toBe('PreToolUse');
  expect(isRecord(specific) && specific.permissionDecision).toBe('deny');
  return {
    reason: isRecord(specific) ? String(specific.permissionDecisionReason) : '',
    message: isRecord(output) ? String(output.systemMessage) : '',
  };
}

const undecidedManager = { scripts: { 'check:feedback': 'node check.mjs' } };

function commandPath(name: string) {
  const found = spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim();
  expect(found).not.toBe('');
  return found;
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

test('package managerを決められないディレクトリでは、check:feedbackを実行せず、理由をsystemMessageとadditionalContextに出して通す', async () => {
  await fixture(
    { ...feedbackPackage(''), 'package.json': JSON.stringify(undecidedManager) },
    async (f) => {
      await change(f);
      const result = runHook(f, 'git commit -m x', { exit: 1 });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.ran).toEqual([]);
      const message = skipNotice(result.stdout);
      expect(message.split('\n')).toHaveLength(1);
      expect(message).toContain('.のcheck:feedbackを実行しません');
      expect(message).toContain('package managerを判定できません');
    },
  );
});

test('package managerの実行ファイルがPATHに無いと、check:feedbackを実行せず、理由を出してcommitを止めない', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'commit-hook-bin-'));
  try {
    for (const name of ['node', 'git']) {
      symlinkSync(commandPath(name), join(bin, name));
    }
    await fixture(
      {
        ...feedbackPackage(''),
        'package.json': JSON.stringify({ ...undecidedManager, packageManager: 'pnpm@9.0.0' }),
      },
      async (f) => {
        await change(f);
        const result = runHook(f, 'git commit -m x', { exit: 1, path: bin });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.ran).toEqual([]);
        const message = skipNotice(result.stdout);
        expect(message).toContain('.のcheck:feedbackを実行しません');
        expect(message).toContain('pnpmを起動できません');
      },
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('失敗したpackageと実行しなかったpackageが両方あると、denyの理由と、systemMessageに、実行しなかった理由を出す', async () => {
  await fixture(
    {
      ...feedbackPackage('a'),
      ...feedbackPackage('b'),
      'b/package.json': JSON.stringify(undecidedManager),
    },
    async (f) => {
      await change(f, 'a/change.txt');
      await change(f, 'b/change.txt');
      const result = runHook(f, 'git commit -m x', { exit: 1 });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.ran).toEqual([join(f.repo, 'a')]);
      const { reason, message } = denyWithNotice(result.stdout);
      expect(message).toContain('bのcheck:feedbackを実行しません');
      expect(message).not.toContain('a: check:feedback');
      expect(reason).toContain('a: check:feedbackが失敗しました');
      expect(reason).toContain(checkOutput);
      expect(reason.endsWith(`\n\n${message}`)).toBe(true);
    },
  );
});

function packageRunning(script: string) {
  return {
    ...feedbackPackage(''),
    'package.json': JSON.stringify({
      packageManager: 'bun@1.4.4',
      scripts: { 'check:feedback': script },
    }),
  };
}

test('check:feedbackの中のコマンドが見つからず終了127で終わると、commitを止めるdenyのJSONを1行だけ出す', async () => {
  await fixture(packageRunning('feedback-loop-missing-command-for-test'), async (f) => {
    await change(f);
    const result = runHook(f, 'git commit -m x');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(denyOutput(result.stdout)).toContain('.: check:feedbackが失敗しました');
  });
});

test('check:feedbackの出力が64MBを超えると、commitを止め、denyの理由にENOBUFSを含める', async () => {
  await fixture(
    packageRunning(`node -e "process.stdout.write('x'.repeat(65 * 1024 * 1024))"`),
    async (f) => {
      await change(f);
      const result = runHook(f, 'git commit -m x');
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(denyOutput(result.stdout)).toContain('ENOBUFS');
    },
  );
});

test('名前にグロブの文字を含むディレクトリと、それに一致する名前のディレクトリでは、変更のあるpackageでだけcheck:feedbackを実行する', async () => {
  await fixture({ ...feedbackPackage('app*'), ...feedbackPackage('apps') }, async (f) => {
    await change(f, 'apps/change.txt');
    expect(runHook(f, 'git commit -m x').ran).toEqual([join(f.repo, 'apps')]);
    rmSync(join(f.repo, 'apps/change.txt'));
    await change(f, 'app*/change.txt');
    expect(runHook(f, 'git commit -m x').ran).toEqual([join(f.repo, 'app*')]);
  });
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

const middleMark = 'MIDDLE_ONLY_MARK';
const longScript = `const length = Number(process.env.FEEDBACK_HOOK_LENGTH ?? 0);
let text = Array.from({ length }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[i % 26]).join('');
if (length >= 20000) {
  const middle = Math.floor(length / 2);
  text = text.slice(0, middle) + '${middleMark}' + text.slice(middle + ${middleMark.length});
}
process.stdout.write(text);
process.exitCode = 1;
`;

function longPackage(directory: string) {
  const prefix = directory === '' ? '' : `${directory}/`;
  return { ...feedbackPackage(directory), [`${prefix}check.mjs`]: longScript };
}

function directOutput(f: Fixture, length: number, directory = '') {
  const result = spawnSync('bun', ['run', 'check:feedback'], {
    cwd: join(f.repo, directory),
    encoding: 'utf8',
    env: { ...baseEnv(f), FEEDBACK_HOOK_LENGTH: String(length) },
  });
  expect(result.status).toBe(1);
  return [result.stdout, result.stderr].filter((part) => part.length > 0).join('\n');
}

function omissionLine(root: string, omitted: number) {
  return `[check:feedbackの出力のうち、途中の${omitted}文字を省きました。全体は${root}でbun run check:feedbackを実行すると見られます]`;
}

test('check:feedbackの出力が1万文字を超えて失敗すると、denyの理由は先頭2,000文字、省いた文字数とコマンドの行、末尾8,000文字を持つ', async () => {
  await fixture(longPackage(''), async (f) => {
    await change(f);
    const whole = directOutput(f, 30000);
    expect(whole).toContain(middleMark);
    const result = runHook(f, 'git commit -m x', { length: 30000 });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const reason = denyOutput(result.stdout);
    expect(reason).toBe(
      `.: check:feedbackが失敗しました\n${whole.slice(0, 2000)}\n${omissionLine(f.repo, whole.length - 10000)}\n${whole.slice(-8000)}`,
    );
    expect(reason).not.toContain(middleMark);
    expect(reason).toContain('error: script "check:feedback" exited with code 1');
  });
});

test('check:feedbackの出力がちょうど1万文字なら全体を理由に持ち、10,001文字なら省いた文字数を1と示す', async () => {
  await fixture(longPackage(''), async (f) => {
    await change(f);
    const stderrLength = directOutput(f, 0).length;
    const fitting = 10000 - 1 - stderrLength;
    const whole = directOutput(f, fitting);
    expect(whole).toHaveLength(10000);
    const fullReason = denyOutput(runHook(f, 'git commit -m x', { length: fitting }).stdout);
    expect(fullReason).toBe(`.: check:feedbackが失敗しました\n${whole}`);
    expect(fullReason).not.toContain('省きました');
    const over = directOutput(f, fitting + 1);
    expect(over).toHaveLength(10001);
    const overReason = denyOutput(runHook(f, 'git commit -m x', { length: fitting + 1 }).stdout);
    expect(overReason).toBe(
      `.: check:feedbackが失敗しました\n${over.slice(0, 2000)}\n${omissionLine(f.repo, 1)}\n${over.slice(-8000)}`,
    );
  });
});

test('2つのディレクトリが両方とも長い出力で失敗すると、理由はディレクトリごとに、自分の絶対パスを示す省略の行を1つずつ持つ', async () => {
  await fixture({ ...longPackage('a'), ...longPackage('b') }, async (f) => {
    await change(f, 'a/change.txt');
    await change(f, 'b/change.txt');
    const reason = denyOutput(runHook(f, 'git commit -m x', { length: 30000 }).stdout);
    expect(reason.startsWith('a: check:feedbackが失敗しました\n')).toBe(true);
    const boundary = reason.indexOf('\n\nb: check:feedbackが失敗しました\n');
    expect(boundary).toBeGreaterThan(0);
    const sections = [reason.slice(0, boundary), reason.slice(boundary + 2)];
    for (const [index, directory] of ['a', 'b'].entries()) {
      const section = String(sections[index]);
      const lines = section.split('\n').filter((line) => line.includes('省きました'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`全体は${join(f.repo, directory)}で`);
    }
  });
});
