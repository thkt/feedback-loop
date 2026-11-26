// 生成元: thkt/feedback-loop scripts/build.ts。直接編集せず、正本を変更して再生成してください
// src/commit-hook.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync3, readFileSync as readFileSync2, realpathSync as realpathSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";

// src/git.ts
import { execFile, spawnSync } from "node:child_process";

// src/values.ts
import assert from "node:assert/strict";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertObject(value) {
  assert(isRecord(value), "オブジェクトが必要です");
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/git.ts
function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// src/inspect.ts
import assert2 from "node:assert/strict";
import { existsSync as existsSync2, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join as join2, relative as relative2 } from "node:path";

// src/installed.ts
var packageManagers = ["bun", "npm", "pnpm"];
var installedDirectory = "scripts/feedback-loop";
var runtimePath = `${installedDirectory}/runtime.mjs`;
var recorderPath = `${installedDirectory}/record-modules.ts`;
var improveTestsPath = `${installedDirectory}/improve-tests.md`;
var mutationPreloadPath = `${installedDirectory}/mutation-preload.ts`;

// src/lockfiles.ts
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
var lockfileManagers = [
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"]
];
var supportedManagers = packageManagers;
var lockfileNames = lockfileManagers.filter(([, manager]) => supportedManagers.includes(manager)).map(([name]) => name);
function lockfilesIn(directory) {
  return lockfileManagers.filter(([name]) => existsSync(join(directory, name))).map(([name, manager]) => ({ name, manager }));
}
function ancestors(root, top) {
  const found = [];
  let directory = root;
  while (directory !== top && directory.startsWith(top + sep)) {
    directory = dirname(directory);
    found.push(directory);
  }
  return found;
}
function ancestorLockfiles(root, top) {
  for (const directory of ancestors(root, top)) {
    const lockfiles = lockfilesIn(directory);
    if (lockfiles.length > 0) {
      return { directory, lockfiles };
    }
  }
  return;
}
function fromRoot(root, path) {
  return relative(root, resolve(root, path)).split(sep).join("/");
}

// src/inspect.ts
function hintsOf(declared, lockfiles, source) {
  const names = lockfiles.map(({ manager }) => manager);
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (!name) {
      return {
        reason: `${source}のpackageManagerの値「${declared}」からpackage managerを読み取れません`
      };
    }
    names.unshift(name);
  }
  return { names: [...new Set(names)] };
}
function declaredIn(directory, source) {
  const path = join2(directory, "package.json");
  if (!existsSync2(path)) {
    return;
  }
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    assertObject(pkg);
    return pkg.packageManager;
  } catch (error) {
    return assert2.fail(`${source}を読めません: ${errorMessage(error)}`);
  }
}
function hintSource(root, top, declared) {
  const local = hintsOf(declared, lockfilesIn(root), "package.json");
  const ancestor = "names" in local && local.names.length === 0 ? ancestorLockfiles(root, top) : undefined;
  if (ancestor === undefined) {
    return { hints: local, where: "" };
  }
  const source = fromRoot(root, join2(ancestor.directory, "package.json"));
  const declaredAbove = declaredIn(ancestor.directory, source);
  return {
    hints: hintsOf(declaredAbove, ancestor.lockfiles, source),
    where: `（${fromRoot(root, ancestor.directory)}で判定）`,
    inherited: {
      lockfiles: ancestor.lockfiles.map(({ name }) => fromRoot(root, join2(ancestor.directory, name))),
      declared: declaredAbove
    }
  };
}
function detectPackageManager(root, top, declared) {
  const { hints, where, inherited } = hintSource(root, top, declared);
  if ("reason" in hints) {
    return { packageManager: null, reason: hints.reason };
  }
  const [hint, ...others] = hints.names;
  if (hint === undefined) {
    return {
      packageManager: null,
      reason: "package managerを判定できません。package.jsonのpackageManagerかlockfileが必要です"
    };
  }
  if (others.length > 0) {
    return {
      packageManager: null,
      reason: `package managerの指定が競合しています: ${hints.names.join(", ")}${where}`
    };
  }
  const packageManager = packageManagers.find((manager) => manager === hint);
  return packageManager === undefined ? {
    packageManager: null,
    reason: `${hint}には対応していません。対応するのは${packageManagers.join("・")}です${where}`
  } : { packageManager, inherited };
}

// src/commit-hook.ts
var configName = ".feedback-loop.json";
var outputLimit = 64 * 1024 * 1024;
function withoutHeredocBodies(command) {
  const kept = [];
  const pending = [];
  for (const line of command.split(`
`)) {
    const delimiter = pending[0];
    if (delimiter !== undefined) {
      if (line.replace(/^\t+/, "") === delimiter) {
        pending.shift();
      }
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(/(?<!<)<<-?\s*(['"]?)([^\s'"<>;&|()]+)\1/g)) {
      pending.push(String(match[2]));
    }
  }
  return kept.join(`
`);
}
function startsWithGitCommit(segment) {
  const command = segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "");
  return /^git\s+commit(?:\s|$)/.test(command);
}
function invokesGitCommit(command) {
  return withoutHeredocBodies(command).split(/&&|\|\||[;|\n]/).some(startsWithGitCommit);
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return;
  }
}
function targetDirectories(top) {
  const listed = gitOutput(top, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    configName,
    `*/${configName}`
  ]);
  const configs = [...new Set((listed ?? "").split("\x00"))].filter((path) => path.endsWith(configName) && existsSync3(join3(top, path)));
  return configs.map((path) => dirname2(path)).filter((directory) => {
    const pkg = readJson(join3(top, directory, "package.json"));
    return isRecord(pkg) && isRecord(pkg.scripts) && typeof pkg.scripts["check:feedback"] === "string";
  }).toSorted();
}
function hasChanges(top, directory) {
  return gitOutput(top, ["status", "--porcelain", "--", directory]) !== "";
}
function hookDisabled(top, directory) {
  const config = readJson(join3(top, directory, configName));
  return isRecord(config) && config.commitHook === false;
}
function packageManagerOf(top, directory) {
  const root = join3(top, directory);
  const pkg = readJson(join3(root, "package.json"));
  try {
    const detected = detectPackageManager(root, top, isRecord(pkg) ? pkg.packageManager : undefined);
    return "reason" in detected ? { reason: detected.reason } : detected.packageManager;
  } catch (error) {
    return { reason: errorMessage(error) };
  }
}
function failedCheck(top, directory) {
  const manager = packageManagerOf(top, directory);
  if (typeof manager !== "string") {
    process.stderr.write(`feedback-loop commit hook: ${directory}のcheck:feedbackを実行しません: ${manager.reason}
`);
    return;
  }
  const result = spawnSync2(manager, ["run", "check:feedback"], {
    cwd: join3(top, directory),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: outputLimit
  });
  if (result.status === 0) {
    return;
  }
  const output = [result.stdout, result.stderr, result.error?.message].filter((part) => typeof part === "string" && part.length > 0).join(`
`);
  return `${directory}: check:feedbackが失敗しました
${output}`;
}
function main() {
  const input = readJson(0);
  if (!isRecord(input) || !isRecord(input.tool_input)) {
    return;
  }
  const command = input.tool_input.command;
  if (typeof command !== "string" || !invokesGitCommit(command)) {
    return;
  }
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const found = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!found) {
    return;
  }
  const top = realpathSync2(found);
  const failures = targetDirectories(top).filter((directory) => hasChanges(top, directory) && !hookDisabled(top, directory)).map((directory) => failedCheck(top, directory)).filter((failure) => failure !== undefined);
  if (failures.length === 0) {
    return;
  }
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: failures.join(`

`)
    }
  })}
`);
}
main();
