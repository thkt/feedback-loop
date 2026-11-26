import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitOutput } from './git.ts';
import { detectPackageManager } from './inspect.ts';
import { errorMessage, isRecord } from './values.ts';

const configName = '.feedback-loop.json';
const outputLimit = 64 * 1024 * 1024;

function withoutHeredocBodies(command: string) {
  const kept: string[] = [];
  const pending: string[] = [];
  for (const line of command.split('\n')) {
    const delimiter = pending[0];
    if (delimiter !== undefined) {
      if (line.replace(/^\t+/, '') === delimiter) {
        pending.shift();
      }
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(/(?<!<)<<-?\s*(['"]?)([^\s'"<>;&|()]+)\1/g)) {
      pending.push(String(match[2]));
    }
  }
  return kept.join('\n');
}

function startsWithGitCommit(segment: string) {
  const command = segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '');
  return /^git\s+commit(?:\s|$)/.test(command);
}

function invokesGitCommit(command: string) {
  return withoutHeredocBodies(command)
    .split(/&&|\|\||[;|\n]/)
    .some(startsWithGitCommit);
}

function readJson(path: string | number): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function targetDirectories(top: string) {
  const listed = gitOutput(top, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    configName,
    `*/${configName}`,
  ]);
  const configs = [...new Set((listed ?? '').split('\0'))].filter(
    (path) => path.endsWith(configName) && existsSync(join(top, path)),
  );
  return configs
    .map((path) => dirname(path))
    .filter((directory) => {
      const pkg = readJson(join(top, directory, 'package.json'));
      return (
        isRecord(pkg) && isRecord(pkg.scripts) && typeof pkg.scripts['check:feedback'] === 'string'
      );
    })
    .toSorted();
}

function hasChanges(top: string, directory: string) {
  return gitOutput(top, ['status', '--porcelain', '--', directory]) !== '';
}

function hookDisabled(top: string, directory: string) {
  const config = readJson(join(top, directory, configName));
  return isRecord(config) && config.commitHook === false;
}

function packageManagerOf(top: string, directory: string) {
  const root = join(top, directory);
  const pkg = readJson(join(root, 'package.json'));
  try {
    const detected = detectPackageManager(
      root,
      top,
      isRecord(pkg) ? pkg.packageManager : undefined,
    );
    return 'reason' in detected ? { reason: detected.reason } : detected.packageManager;
  } catch (error) {
    return { reason: errorMessage(error) };
  }
}

function failedCheck(top: string, directory: string) {
  const manager = packageManagerOf(top, directory);
  if (typeof manager !== 'string') {
    process.stderr.write(
      `feedback-loop commit hook: ${directory}のcheck:feedbackを実行しません: ${manager.reason}\n`,
    );
    return undefined;
  }
  const result = spawnSync(manager, ['run', 'check:feedback'], {
    cwd: join(top, directory),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: outputLimit,
  });
  if (result.status === 0) {
    return undefined;
  }
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n');
  return `${directory}: check:feedbackが失敗しました\n${output}`;
}

function main() {
  const input = readJson(0);
  if (!isRecord(input) || !isRecord(input.tool_input)) {
    return;
  }
  const command = input.tool_input.command;
  if (typeof command !== 'string' || !invokesGitCommit(command)) {
    return;
  }
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const found = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  if (!found) {
    return;
  }
  const top = realpathSync(found);
  const failures = targetDirectories(top)
    .filter((directory) => hasChanges(top, directory) && !hookDisabled(top, directory))
    .map((directory) => failedCheck(top, directory))
    .filter((failure) => failure !== undefined);
  if (failures.length === 0) {
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: failures.join('\n\n'),
      },
    })}\n`,
  );
}

main();
