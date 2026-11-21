// 生成元: thkt/feedback-loop scripts/build.ts。直接編集せず、正本を変更して再生成してください
// バージョン: 0.4.6
/*
 * src/mutants.tsは、mizchi/mutatorの規則を移したものです。
 *
 * MIT License
 *
 * Copyright (c) 2026 mizchi
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// src/runtime.ts
import assert15 from "node:assert/strict";
import { readFileSync as readFileSync6 } from "node:fs";
import { basename, join as join13 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { parseArgs } from "node:util";

// src/changes.ts
import assert3 from "node:assert/strict";
import { existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/git.ts
import assert2 from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { posix, resolve } from "node:path";

// src/values.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertObject(value) {
  assert(isRecord(value), "オブジェクトが必要です");
}
function assertStringArray(value, name) {
  assert(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0), `${name}は空でない文字列の配列で指定してください`);
}
function isRepoRelativePath(path) {
  return !isAbsolute(path) && !path.split("/").includes("..") && !path.startsWith("./") && !path.includes("\\");
}
function assertRepoRelativePath(path) {
  assert(isRepoRelativePath(path), `repo相対パスが必要です: ${path}`);
}
function stringRecord(value) {
  assertObject(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    assert(typeof item === "string", `${key}は文字列で指定してください`);
    result[key] = item;
  }
  return result;
}
function shellQuote(argument) {
  return /^[\w./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

// src/git.ts
function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function resolveCommit(root, ref, subject) {
  const unreadable = `${subject}をGitのcommitとして読めません: ${ref}`;
  assert2(!ref.startsWith("-"), unreadable);
  let commit = ref;
  for (const revision of [(id) => id, (id) => `${id}^{commit}`]) {
    const result = spawnSync("git", ["rev-parse", "--verify", revision(commit)], {
      cwd: root,
      encoding: "utf8"
    });
    commit = result.status === 0 ? result.stdout.trim() : "";
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      const reason = result.error?.message ?? result.stderr.trim();
      assert2.fail(reason ? `${unreadable}（${reason}）` : unreadable);
    }
  }
  return commit;
}
function defaultBase(root) {
  const verified = (ref) => gitOutput(root, ["rev-parse", "--verify", "--quiet", ref]);
  const remoteHead = gitOutput(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD"
  ]);
  if (remoteHead) {
    const commit = verified(`refs/remotes/${remoteHead}`);
    return commit ? { base: remoteHead, commit } : { base: null, reason: `origin/HEADの指す先の${remoteHead}がありません` };
  }
  for (const [prefix, label] of [
    ["refs/remotes/origin/", "origin/"],
    ["refs/heads/", ""]
  ]) {
    const found = ["main", "master"].flatMap((name) => {
      const commit = verified(`${prefix}${name}`);
      return commit ? [{ base: `${label}${name}`, commit }] : [];
    });
    if (found.length === 1 && found[0]) {
      return found[0];
    }
    if (found.length > 1) {
      return { base: null, reason: `${label}mainと${label}masterの両方があります` };
    }
  }
  return { base: null, reason: "origin/HEADがなく、mainもmasterもありません" };
}

class NoMergeBase extends Error {
}
function git(root, args) {
  return new Promise((done, fail) => {
    execFile("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        fail(new Error(`git ${args.join(" ")} failed: ${stderr}`));
      } else {
        done(stdout);
      }
    });
  });
}
function nulSeparated(text) {
  return text.split("\x00").filter((path) => path !== "");
}
async function changesSince(root, base, existingOnly = false) {
  const [merged, untracked, shown] = await Promise.all([
    git(root, ["merge-base", base, "HEAD"]).catch((error) => {
      throw new NoMergeBase(errorMessage(error));
    }),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(root, ["rev-parse", "--show-prefix"])
  ]);
  const comparison = merged.trim();
  const tracked = nulSeparated(await git(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--no-relative",
    ...existingOnly ? ["--diff-filter=d"] : [],
    "-z",
    comparison
  ]));
  const prefix = shown.trim();
  const up = "../".repeat(prefix.split("/").filter(Boolean).length);
  const inside = tracked.filter((path) => path.startsWith(prefix));
  return {
    comparison,
    changed: [
      ...new Set([...inside.map((path) => path.slice(prefix.length)), ...nulSeparated(untracked)])
    ],
    outside: tracked.filter((path) => !path.startsWith(prefix)).map((path) => posix.relative(prefix, path)),
    top: resolve(root, up)
  };
}
async function untrackedAmong(root, paths) {
  return paths.length === 0 ? [] : nulSeparated(await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]));
}
async function changesWithStatus(root, base) {
  const [merged, shown, untracked] = await Promise.all([
    git(root, ["merge-base", base, "HEAD"]).catch((error) => {
      throw new NoMergeBase(errorMessage(error));
    }),
    git(root, ["rev-parse", "--show-prefix"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"])
  ]);
  const prefix = shown.trim();
  const fromRoot = (path) => posix.relative(prefix, path);
  const fields = nulSeparated(await git(root, [
    "diff",
    "--name-status",
    "--no-renames",
    "--no-relative",
    "-z",
    merged.trim()
  ]));
  return [
    ...fields.flatMap((status, index) => index % 2 === 0 ? [{ status, path: fromRoot(fields[index + 1] ?? "") }] : []),
    ...nulSeparated(untracked).map((path) => ({ status: "A", path: fromRoot(path) }))
  ];
}

// src/lockfiles.ts
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve as resolve2, sep } from "node:path";

// src/installed.ts
var packageManagers = ["bun", "npm", "pnpm"];
var installedDirectory = "scripts/feedback-loop";
var runtimePath = `${installedDirectory}/runtime.mjs`;
var recorderPath = `${installedDirectory}/record-modules.ts`;
var improveTestsPath = `${installedDirectory}/improve-tests.md`;

// src/lockfiles.ts
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
function fromRoot(root, path) {
  return relative(root, resolve2(root, path)).split(sep).join("/");
}
function ancestorLockfileCandidates(root, top, manager) {
  if (lockfilesIn(root).length > 0) {
    return [];
  }
  const name = lockfileManagers.find(([, owner]) => owner === manager)?.[0];
  return name === undefined ? [] : ancestors(root, top).map((directory) => fromRoot(root, join(directory, name)));
}

// src/changes.ts
var baseVariable = "FEEDBACK_LOOP_BASE";
function undecidable(root, reason) {
  const hasOrigin = gitOutput(root, ["remote", "get-url", "origin"]) !== undefined;
  return assert3.fail(`比較元を決められません（${reason}）。差分を取る比較元を、.feedback-loop.jsonのbase` + (hasOrigin ? '（例: "origin/main"）か、git remote set-head origin --autoで決めてください' : '（例: "main"）で決めてください'));
}
function runtimeBase(option) {
  const variable = process.env[baseVariable];
  delete process.env[baseVariable];
  if (option !== undefined) {
    return { ref: option, from: "option" };
  }
  if (variable === undefined) {
    return;
  }
  const ref = variable.trim();
  assert3(ref !== "", `${baseVariable}には参照を指定してください`);
  return { ref, from: "environment" };
}
var runtimeSources = {
  option: { subject: "--baseに指定した参照", runtime: "実行時の指定" },
  environment: { subject: `${baseVariable}に指定した参照`, runtime: `${baseVariable}の指定` }
};
function specifiedBase(config, specified) {
  if (specified !== undefined) {
    return { ...runtimeSources[specified.from], ref: specified.ref };
  }
  return config.base === undefined ? undefined : { subject: ".feedback-loop.jsonのbase", ref: config.base };
}
function comparisonBase(root, config, runtime) {
  const specified = specifiedBase(config, runtime);
  if (specified !== undefined) {
    return { ...specified, commit: resolveCommit(root, specified.ref, specified.subject) };
  }
  const found = defaultBase(root);
  if (found.base === null) {
    return undecidable(root, found.reason);
  }
  return { subject: "既定の比較元", ref: found.base, commit: found.commit };
}
function failWithoutMergeBase(base) {
  return (error) => {
    if (error instanceof NoMergeBase) {
      assert3.fail(`${base.subject}とHEADの分岐点を求められません: ${base.ref}（${error.message}）`);
    }
    throw error;
  };
}
function changesFrom(root, base, existingOnly = false) {
  return changesSince(root, base.commit, existingOnly).catch(failWithoutMergeBase(base));
}
function statusChangesFrom(root, base) {
  return changesWithStatus(root, base.commit).catch(failWithoutMergeBase(base));
}
async function ancestorLockfile(root, top, outside, manager) {
  const path = ancestorLockfileCandidates(root, top, manager).find((candidate) => outside.includes(candidate) || existsSync2(join2(root, candidate)));
  if (path === undefined) {
    return;
  }
  const changed = outside.includes(path) || (await untrackedAmong(root, [path])).length > 0;
  return { path, changed, exists: existsSync2(join2(root, path)) };
}
async function affectedChanges(root, base, manager) {
  const { comparison, changed, outside, top } = await changesFrom(root, base);
  const lockfile = await ancestorLockfile(root, top, outside, manager);
  const lockfileChanges = lockfile?.changed ? [lockfile.path] : [];
  return {
    comparison,
    changed: [...changed, ...lockfileChanges],
    outside: outside.filter((path) => !lockfileChanges.includes(path)),
    lockfileChanges,
    ancestorLockfiles: lockfile?.exists ? [lockfile.path] : []
  };
}
async function existingChanges(root, base) {
  return (await changesFrom(root, base, true)).changed;
}

// src/classification.ts
import assert5 from "node:assert/strict";
import { lstatSync, readdirSync, statSync as statSync2 } from "node:fs";
import { join as join4 } from "node:path";

// src/config.ts
import assert4 from "node:assert/strict";
import { existsSync as existsSync3, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute as isAbsolute2, join as join3, relative as relative2, resolve as resolve3, sep as sep2 } from "node:path";
var configKeys = {
  runner: true,
  base: true,
  collect: true,
  testGlobs: true,
  assurance: true,
  prepare: true,
  bunArgs: true,
  bunWorkers: true,
  testArgs: true,
  allowSkipped: true,
  mutation: true,
  globalChanges: true,
  ignoredChanges: true,
  dependencies: true
};
function readConfig(root) {
  const value = JSON.parse(readFileSync(join3(root, ".feedback-loop.json"), "utf8"));
  assertObject(value);
  const unknownKeys = Object.keys(value).filter((key) => !Object.hasOwn(configKeys, key));
  assert4(unknownKeys.length === 0, `.feedback-loop.jsonの未知のキーです: ${unknownKeys.join(", ")}`);
  assert4(value.runner === "bun" || value.runner === "vitest", "runnerはbunまたはvitestです");
  if (value.base !== undefined) {
    assert4(typeof value.base === "string" && value.base.trim().length > 0, "比較元baseが必要です");
  }
  const {
    collect,
    testGlobs,
    prepare = [],
    testArgs = [],
    globalChanges = [],
    ignoredChanges = [],
    bunArgs = [],
    bunWorkers = 4,
    allowSkipped = true,
    mutation = true,
    assurance: assuranceValue = [],
    dependencies: dependenciesValue = []
  } = value;
  if (collect !== undefined || value.runner === "vitest") {
    assertStringArray(collect, "collect");
    assert4(collect.length > 0, "収集コマンドは空にできません");
  }
  assertStringArray(testGlobs, "testGlobs");
  assertStringArray(prepare, "prepare");
  assertStringArray(testArgs, "testArgs");
  assertStringArray(globalChanges, "globalChanges");
  assertStringArray(ignoredChanges, "ignoredChanges");
  assert4(testGlobs.length > 0, "テストglobは必須です");
  assert4(typeof allowSkipped === "boolean", "allowSkippedはbooleanです");
  assert4(typeof mutation === "boolean", "mutationはbooleanです");
  assertStringArray(bunArgs, "bunArgs");
  assert4(value.runner === "bun" || bunArgs.length === 0, "VitestにはbunArgsを指定できません");
  assert4(typeof bunWorkers === "number" && Number.isSafeInteger(bunWorkers) && bunWorkers > 0, "bunWorkersは正の安全な整数で指定してください");
  assert4(value.runner === "bun" || value.bunWorkers === undefined, "VitestにはbunWorkersを指定できません");
  if (value.runner === "bun") {
    assert4(![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)), "テストファイルごとの分離は固定です。並列数はbunWorkersで指定してください");
  }
  assert4(Array.isArray(assuranceValue), "assurance配列が必要です");
  const assurance = assuranceValue.map((item) => {
    assertObject(item);
    assert4(typeof item.path === "string" && typeof item.reason === "string" && item.reason.trim().length > 0, "assuranceにはpathと指定理由が必要です");
    assertRepoRelativePath(item.path);
    return { path: item.path, reason: item.reason };
  });
  assert4(Array.isArray(dependenciesValue), "dependencies配列が必要です");
  const dependencies = dependenciesValue.map((item) => {
    assertObject(item);
    assertStringArray(item.inputs, "dependenciesのinputs");
    assertStringArray(item.tests, "dependenciesのtests");
    assert4(item.inputs.length > 0 && item.tests.length > 0, "依存対応は空にできません");
    item.inputs.forEach(assertRepoRelativePath);
    item.tests.forEach(assertRepoRelativePath);
    return { inputs: item.inputs, tests: item.tests };
  });
  testGlobs.forEach(assertRepoRelativePath);
  globalChanges.forEach(assertRepoRelativePath);
  ignoredChanges.forEach(assertRepoRelativePath);
  return {
    runner: value.runner,
    base: value.base,
    collect,
    testGlobs,
    assurance,
    prepare,
    bunArgs,
    bunWorkers,
    testArgs,
    allowSkipped,
    mutation,
    globalChanges,
    ignoredChanges,
    dependencies
  };
}
function matches(path, glob) {
  let pattern = "^";
  for (let i = 0;i < glob.length; i++) {
    const char = glob[i] ?? "";
    if (glob.slice(i, i + 3) === "**/") {
      pattern += "(?:.*/)?";
      i += 2;
    } else if (glob.slice(i, i + 2) === "**") {
      pattern += ".*";
      i++;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`).test(path);
}
var mutantsRecordFile = ".feedback-loop-mutants.json";
var fullRunGlobs = [
  "package.json",
  ...lockfileNames,
  "tsconfig.json",
  ".feedback-loop.json",
  `${installedDirectory}/**`
];
function isTestFile(path, config) {
  return config.testGlobs.some((glob) => matches(path, glob));
}
function requiresFullRun(path, config) {
  return [...fullRunGlobs, ...config.globalChanges].some((glob) => matches(path, glob));
}
function ignoresChange(path, config) {
  return config.ignoredChanges.some((glob) => matches(path, glob));
}
function isAssurance(path, config) {
  return config.assurance.some((entry) => entry.path === path);
}
function mappedTests(path, config) {
  return config.dependencies.filter((entry) => entry.inputs.some((glob) => matches(path, glob))).flatMap((entry) => entry.tests);
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].some((code) => hasErrorCode(error, code))) {
      return false;
    }
    throw error;
  }
}
function repoPath(root, path) {
  const absolute = resolve3(root, path);
  const canonical = existsSync3(absolute) ? realpathSync(absolute) : absolute;
  const local = relative2(root, canonical);
  return local !== ".." && !local.startsWith(`..${sep2}`) && !isAbsolute2(local) ? local.split(sep2).join("/") : absolute;
}

// src/classification.ts
function filesUnder(root, prefix, excludeHidden) {
  return readdirSync(join4(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.name === ".git" || entry.name === "node_modules" || excludeHidden && entry.isDirectory() && entry.name.startsWith(".")) {
      return [];
    }
    return entry.isDirectory() ? filesUnder(root, `${path}/`, excludeHidden) : entry.isFile() ? [path] : [];
  });
}
function entryExists(path) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}
function mismatchDiagnostic(root, config, collected, globbed) {
  const inCollected = new Set(collected);
  const inGlobbed = new Set(globbed);
  const missing = [];
  const unmatched = [];
  const unlisted = [];
  for (const path of collected.filter((candidate) => !inGlobbed.has(candidate))) {
    if (!entryExists(join4(root, path))) {
      missing.push(path);
    } else if (isTestFile(path, config)) {
      unlisted.push(path);
    } else {
      unmatched.push(path);
    }
  }
  const sides = [
    { label: "収集にあって実在しない", paths: missing },
    {
      label: "収集にあってtestGlobsに当たらない",
      paths: unmatched,
      guidance: "直し方: 上のパスがテストなら、.feedback-loop.jsonのtestGlobsへ、そのパスに当たるglobを足してください。globに当たるテストは、同じファイルのassuranceへ登録しなければqualityになります。" + (config.collect === undefined ? "テストでなければ、拡張子の前が.test・_test・.spec・_specにならない名前へ変えてください" : "テストでなければ、収集用コマンドの出力から外してください")
    },
    {
      label: "収集にあってtestGlobsに当たるが、探索で見つからない（シンボリックリンク、ディレクトリ、node_modules・.gitの下、表記の違いなど）",
      paths: unlisted
    },
    {
      label: "testGlobsに当たって収集にない",
      paths: globbed.filter((path) => !inCollected.has(path))
    }
  ];
  return [
    "通常収集とtestGlobsの集合が一致しません",
    ...sides.filter(({ paths }) => paths.length > 0).flatMap(({ label, paths, guidance }) => {
      const line = `${label}: ${JSON.stringify(paths.sort())}`;
      return guidance === undefined ? [line] : [line, guidance];
    })
  ].join(`
`);
}
var shownOutput = 200;
function outputEnds(stdout) {
  const head = `標準出力の先頭: ${JSON.stringify(stdout.slice(0, shownOutput))}`;
  return stdout.length > shownOutput ? `${head}。標準出力の末尾: ${JSON.stringify(stdout.slice(-shownOutput))}` : head;
}
function parseCollected(stdout) {
  let collected;
  try {
    collected = JSON.parse(stdout);
  } catch (error) {
    const reason = errorMessage(error).replaceAll(/\p{Cc}+/gu, " ").slice(0, shownOutput);
    assert5.fail(`収集用コマンドの標準出力をJSONとして読めません。標準出力にはJSONの文字列配列だけを出し、診断は標準エラーへ出してください。理由: ${reason}。${outputEnds(stdout)}`);
  }
  try {
    assertStringArray(collected, "収集用コマンドの標準出力");
  } catch {
    assert5.fail(`収集用コマンドの標準出力はJSONですが、空でない文字列だけの配列ではありません。${outputEnds(stdout)}`);
  }
  return collected;
}
function builtinTests(files) {
  return files.filter((path) => /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(path)).sort();
}
async function collectedTests(root, command, run) {
  const { stdout } = await run(command, { cwd: root, stdout: "capture" });
  const collected = parseCollected(stdout);
  collected.forEach(assertRepoRelativePath);
  assert5(new Set(collected).size === collected.length, "収集結果が重複しています");
  return collected;
}
async function classification(root, config, run) {
  const collection = config.collect === undefined ? { kind: "builtin" } : { kind: "command", command: config.collect };
  const prefixes = config.testGlobs.map((glob) => {
    const fixed = glob.split(/[*?]/, 1)[0] ?? "";
    return fixed.slice(0, fixed.lastIndexOf("/") + 1);
  });
  const roots = [...new Set(prefixes)].filter((prefix, _, all) => !all.some((parent) => parent !== prefix && prefix.startsWith(parent)));
  const files = roots.filter((prefix) => !prefix.split("/").some((part) => part === ".git" || part === "node_modules" || collection.kind === "builtin" && part.startsWith("."))).filter((prefix) => {
    const found = statSync2(join4(root, prefix), { throwIfNoEntry: false })?.isDirectory() ?? false;
    assert5(found || collection.kind === "command", `testGlobsの探索場所がありません: ${prefix}`);
    return found;
  }).flatMap((prefix) => filesUnder(root, prefix, collection.kind === "builtin"));
  const expected = files.filter((path) => isTestFile(path, config)).sort();
  const actual = collection.kind === "builtin" ? builtinTests(files) : await collectedTests(root, collection.command, run);
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected)) {
    assert5.fail(mismatchDiagnostic(root, config, actual, expected));
  }
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert5(assurance.size === config.assurance.length, "assurance指定が重複しています");
  assert5([...assurance].every((path) => expected.includes(path)), "assuranceに存在しないテストか集合外の指定があります");
  assert5(config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))), "依存対応に集合外のテストがあります");
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance]
  };
}

// src/bun.ts
import assert7 from "node:assert/strict";
import { existsSync as existsSync6 } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join as join7 } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

// src/selection.ts
import { existsSync as existsSync4 } from "node:fs";
import { join as join5 } from "node:path";
function exemption(path, config, declared, reachesAssurance) {
  const mapped = mappedTests(path, config).length > 0;
  if (!mapped && isAssurance(path, config)) {
    return "assurance";
  }
  if (declared.has(path)) {
    return path === mutantsRecordFile ? "mutantsRecord" : "ignored";
  }
  return !mapped && reachesAssurance.has(path) ? "assuranceReach" : undefined;
}
async function selectQuality({ root, config, quality, changes: { changed, lockfileChanges } }, source) {
  const forcesFullRun = (path) => lockfileChanges.includes(path) || requiresFullRun(path, config);
  const declared = new Set;
  const changes = changed.map((path) => {
    const targets = [...quality.includes(path) ? [path] : [], ...mappedTests(path, config)];
    if (targets.length === 0 && !forcesFullRun(path) && (ignoresChange(path, config) || path === mutantsRecordFile)) {
      declared.add(path);
    }
    return { path, targets: targets.filter((test) => quality.includes(test)) };
  });
  const fullRun = changes.filter(({ path }) => forcesFullRun(path) || config.runner === "vitest" && !declared.has(path) && !existsSync4(join5(root, path))).map(({ path }) => path);
  const reachability = await source.reach(changes, fullRun.length > 0);
  const selected = new Set(reachability?.always);
  const unreached = [];
  const exempt = { ignored: [], mutantsRecord: [], assurance: [], assuranceReach: [] };
  const reachesAssurance = reachability?.reachesAssurance ?? new Set;
  for (const { path, targets } of changes) {
    const reached = [...targets, ...reachability?.reached.get(path) ?? []];
    if (reached.length === 0 && reachability !== undefined && !fullRun.includes(path)) {
      const reason = exemption(path, config, declared, reachesAssurance);
      if (reason === undefined) {
        unreached.push(path);
      } else {
        exempt[reason].push(path);
      }
    }
    reached.forEach((file) => selected.add(file));
  }
  const reasons = [
    ...fullRun,
    ...unreached,
    ...source.fullRunReason === undefined ? [] : [source.fullRunReason]
  ];
  if (reasons.length > 0) {
    return { kind: "all", reasons, files: quality, assuranceReach: exempt.assuranceReach };
  }
  const files = quality.filter((file) => selected.has(file));
  if (files.length > 0) {
    return { kind: "some", files, assuranceReach: exempt.assuranceReach };
  }
  return Object.values(exempt).some((paths) => paths.length > 0) ? { kind: "exempt", ...exempt } : { kind: "none" };
}

// src/records.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync5, mkdirSync, readFileSync as readFileSync2, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join6, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";
var recordsDirectoryName = ".feedback-loop-records";
function recordsPath(root) {
  return join6(root, recordsDirectoryName, "records.json");
}
function recordsDirectory(root) {
  const directory = join6(root, recordsDirectoryName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join6(directory, ".gitignore"), `*
`);
  return directory;
}
function readDependencyRecords(path) {
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? { kind: "missing" } : { kind: "unreadable", error };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.tests)) {
    return { kind: "invalid" };
  }
  const entries = new Map;
  for (const [file, value] of Object.entries(parsed.tests)) {
    if (!isRecord(value) || typeof value.basis !== "string" || !isRecord(value.files)) {
      return { kind: "invalid" };
    }
    const files = {};
    for (const [module, hash] of Object.entries(value.files)) {
      if (typeof hash !== "string") {
        return { kind: "invalid" };
      }
      files[module] = hash;
    }
    entries.set(file, { basis: value.basis, files });
  }
  return { kind: "valid", entries };
}
function openRecords(root, changed, testFiles, ancestorLockfiles) {
  const path = recordsPath(root);
  const loaded = readDependencyRecords(path);
  const digests = new Map;
  const hash = (file) => digest(root, file, digests);
  const basis = sourceBasis(root, hash, ancestorLockfiles);
  const records = loaded.kind === "valid" ? validatedRecords(loaded.entries, changed, testFiles, hash, basis) : { kind: "unusable", reason: unusableReason(path, loaded) };
  return {
    records,
    save: ({ ran, failed }) => {
      if (loaded.kind === "unreadable") {
        throw loaded.error;
      }
      const entries = loaded.kind === "valid" ? loaded.entries : new Map;
      for (const [file, modules] of ran) {
        entries.set(file, {
          basis,
          files: Object.fromEntries([...modules].sort().map((module) => [module, hash(module)]))
        });
      }
      for (const file of failed) {
        entries.delete(file);
      }
      writeRecords(root, entries);
    }
  };
}
var noRecords = "依存記録がありません";
function unusableReason(path, loaded) {
  switch (loaded.kind) {
    case "missing":
      return noRecords;
    case "unreadable":
      return `${path} を読めないため、記録なしとして扱います: ${errorMessage(loaded.error)}`;
    case "invalid":
      return `${path} の形が不正なため、記録なしとして扱います`;
    default:
      return loaded;
  }
}
function digest(root, path, digests) {
  const cached = digests.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const absolute = resolve4(root, path);
  const hash = existsSync5(absolute) ? sha256(readFileSync2(absolute)) : "missing";
  digests.set(path, hash);
  return hash;
}
function sourceBasis(root, hash, ancestorLockfiles) {
  const head = spawnSync2("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) {
    throw new Error(`記録の基点を取得できません: ${head.stderr}`);
  }
  return JSON.stringify([
    head.stdout.trim(),
    process.version,
    process.versions.bun,
    ...[
      fileURLToPath(import.meta.url),
      join6(dirname2(fileURLToPath(import.meta.url)), "record-modules.ts")
    ].map(hash),
    ...[".feedback-loop.json", "bunfig.toml", "package.json", ...lockfileNames].map(hash),
    ...ancestorLockfiles.map(hash)
  ]);
}
function validatedRecords(entries, changed, testFiles, hash, basis) {
  try {
    const accounted = new Set(changed);
    const current = new Set(testFiles);
    const relevant = [...entries].filter(([file]) => current.has(file));
    const valid = new Map(relevant.filter(([, entry]) => entry.basis === basis && Object.entries(entry.files).every(([module, recorded]) => accounted.has(module) || recorded === hash(module))).map(([file, entry]) => [file, new Set(Object.keys(entry.files))]));
    if (valid.size !== relevant.length) {
      return { kind: "unusable", reason: "依存記録が古いため採用しません" };
    }
    return valid.size > 0 ? { kind: "usable", records: valid } : { kind: "unusable", reason: noRecords };
  } catch (error) {
    return { kind: "unusable", reason: `依存記録の入力を確認できません: ${String(error)}` };
  }
}
function writeAtomically(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
function writeRecords(root, entries) {
  writeAtomically(join6(recordsDirectory(root), "records.json"), `${JSON.stringify({ version: 2, tests: Object.fromEntries(entries) }, null, 2)}
`);
}

// src/bun-report.ts
import assert6 from "node:assert/strict";
function elements(node, name) {
  return node.children.filter((child) => typeof child !== "string" && ("name" in child) && child.name === name);
}
function testcases(node) {
  return [...elements(node, "testcase"), ...elements(node, "testsuite").flatMap(testcases)];
}
function junitCount(node, name, fallback) {
  const value = node.attributes[name] ?? fallback;
  assert6(value !== undefined && /^\d+$/.test(value), `JUnitの${name}が不正です`);
  const result = Number(value);
  assert6(Number.isSafeInteger(result), `JUnitの${name}が不正です`);
  return result;
}
function counts(node, allowSkipped) {
  const tests = junitCount(node, "tests");
  const skipped = junitCount(node, "skipped");
  assert6(tests > 0 && skipped <= tests, "JUnitの完了件数が不正または0件です");
  assert6(allowSkipped || skipped === 0, "許可されていないskipがあります");
  assert6(junitCount(node, "failures") === 0 && junitCount(node, "errors", "0") === 0, "JUnitに失敗が記録されています");
  return { tests, skipped };
}
function readBunSuites(text, root) {
  const report = Bun.XML.parse(text, { compact: false });
  assert6(report.name === "testsuites", "Bun JUnitのrootがありません");
  const suites = new Map;
  for (const suite of elements(report, "testsuite")) {
    const file = suite.attributes.file;
    assert6(file && file.trim(), "JUnitのテストファイルがありません");
    const owner = repoPath(root, file);
    assert6(!suites.has(owner), `JUnitのファイルが重複しています: ${file}`);
    suites.set(owner, suite);
  }
  return { report, suites };
}
function readBunReport(text, root, candidates, allowSkipped) {
  const { report, suites } = readBunSuites(text, root);
  const total = counts(report, allowSkipped);
  const completed = new Map;
  let tests = 0;
  let skipped = 0;
  for (const [owner, suite] of suites) {
    const file = suite.attributes.file;
    assert6(candidates.has(owner), `JUnitに候補外のファイルがあります: ${file}`);
    const summary = counts(suite, allowSkipped);
    const cases = testcases(suite);
    assert6(cases.length === summary.tests, `JUnitのファイル別件数が一致しません: ${file}`);
    let skippedCases = 0;
    for (const item of cases) {
      assert6(item.attributes.file && repoPath(root, item.attributes.file) === owner, `JUnitのtestcaseのファイルが一致しません: ${file}`);
      assert6(elements(item, "failure").length === 0 && elements(item, "error").length === 0, `JUnitのtestcaseが失敗しています: ${file}`);
      if (elements(item, "skipped").length > 0) {
        skippedCases++;
      }
    }
    assert6(skippedCases === summary.skipped, `JUnitのskip件数が一致しません: ${file}`);
    tests += summary.tests;
    skipped += summary.skipped;
    completed.set(owner, summary.tests - summary.skipped);
  }
  assert6(tests === total.tests && skipped === total.skipped, "JUnitのファイル別件数と全体件数が一致しません");
  return completed;
}

// src/bun.ts
function recordsAfterSuccess(states) {
  const ran = new Map;
  const failed = [];
  for (const [file, state] of states) {
    if (state.status === "passed") {
      ran.set(file, state.modules);
    } else if (state.status !== "excluded") {
      failed.push(file);
    }
  }
  return { ran, failed };
}
function recordsAfterFailure(states) {
  const failed = [...states].filter(([, state]) => state.status !== "excluded").map(([file]) => file);
  return { ran: new Map, failed };
}
function recorderModule(value) {
  assertObject(value);
  assert7(typeof value.recorderEnv === "function" && typeof value.readRecords === "function", "記録器を読み込めません");
}
function hasNoChangedTests(comparison, report, recorded, stderr) {
  return comparison !== undefined && !existsSync6(report) && recorded.size === 0 && /^--changed: (?:\d+ changed files?, but no test files are affected|no changed files, nothing to run)\r?$/m.test(stripVTControlCharacters(stderr));
}
function bunTestArgv(config, files, report) {
  return [
    process.versions.bun ? process.execPath : "bun",
    ...config.bunArgs,
    "test",
    ...files.map((file) => `./${file}`),
    ...config.testArgs,
    "--no-orphans",
    `--parallel=${config.bunWorkers}`,
    "--reporter=junit",
    "--reporter-outfile",
    report
  ];
}
async function runBunBatch({ root, config, run }, batch) {
  const candidates = new Set(batch.files);
  const report = join7(batch.dir, "results.xml");
  const recordDir = join7(batch.dir, "records");
  await mkdir(recordDir, { recursive: true });
  const argv = [
    ...bunTestArgv(config, batch.files, report),
    ...batch.comparison === undefined ? [] : [`--changed=${batch.comparison}`]
  ];
  const { stderr } = await run(argv, {
    env: batch.recorder.recorderEnv(process.env, recordDir, batch.recorderFile)
  });
  const recorded = new Map([...await batch.recorder.readRecords(recordDir)].map(([owner, modules]) => [
    repoPath(root, owner),
    new Set([...modules].map((path) => repoPath(root, path)))
  ]));
  const results = hasNoChangedTests(batch.comparison, report, recorded, stderr) ? new Map : readBunReport(await readFile(report, "utf8"), root, candidates, config.allowSkipped);
  assert7(recorded.size === results.size && [...recorded.keys()].every((file) => results.has(file)), "読み込んだテストとJUnitのファイル集合が一致しません");
  assert7(batch.comparison !== undefined || results.size === candidates.size, "指定したテストの結果が欠落しています");
  return new Map([...results].map(([owner, count]) => {
    const modules = recorded.get(owner);
    assert7(modules, `完了したテストの依存記録がありません: ${owner}`);
    return [owner, { count, modules }];
  }));
}
async function runBunTests(ctx) {
  const { root, quality } = ctx;
  const { comparison, changed, ancestorLockfiles } = ctx.changes;
  const { records, save: saveRecords } = openRecords(root, changed, quality, ancestorLockfiles);
  const selected = await selectQuality(ctx, {
    fullRunReason: records.kind === "unusable" ? records.reason : undefined,
    async reach(changes) {
      const inputsByTest = new Map(records.kind === "usable" ? records.records : []);
      for (const { path, targets } of changes) {
        for (const test of targets) {
          inputsByTest.set(test, new Set([...inputsByTest.get(test) ?? [], path]));
        }
      }
      return {
        reached: new Map(changed.map((path) => [
          path,
          quality.filter((file) => inputsByTest.get(file)?.has(path))
        ])),
        always: quality.filter((file) => !inputsByTest.has(file))
      };
    }
  });
  if (selected.kind === "exempt" || selected.kind === "none") {
    return selected;
  }
  if (selected.kind === "all") {
    console.log(`quality全件の理由: ${selected.reasons.join(", ")}`);
  }
  const recorderFile = join7(root, recorderPath);
  const recorder = await import(pathToFileURL(recorderFile).href);
  recorderModule(recorder);
  const dir = await mkdtemp(join7(tmpdir(), "feedback-loop-"));
  const states = new Map;
  let outcome = "failed";
  try {
    const runBatch = async (files, compared, index) => {
      for (const file of files) {
        states.set(file, { status: "running" });
      }
      const results = await runBunBatch(ctx, {
        files,
        comparison: compared ? comparison : undefined,
        dir: join7(dir, String(index)),
        recorderFile,
        recorder
      });
      for (const file of files) {
        const result = results.get(file);
        states.set(file, result === undefined ? { status: "excluded" } : result.count > 0 ? { status: "passed", modules: result.modules } : { status: "skipped" });
      }
    };
    await runBatch(quality, selected.kind === "some", 0);
    if (selected.kind === "some") {
      const remaining = selected.files.filter((file) => states.get(file)?.status === "excluded");
      if (remaining.length > 0) {
        await runBatch(remaining, false, 1);
      }
    }
    const results = [...states.values()].filter((state) => state.status === "passed" || state.status === "skipped");
    console.log(`quality選択: ${results.length}件（Bunの実行結果と補完依存の和集合）`);
    assert7(results.length > 0, "候補0件: 関連テストがありません");
    assert7(results.some((state) => state.status === "passed"), "未実行: 選択したテストがすべてskipされています");
    outcome = "succeeded";
  } finally {
    try {
      saveRecords(outcome === "succeeded" ? recordsAfterSuccess(states) : recordsAfterFailure(states));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { kind: "ran" };
}

// src/vitest.ts
import assert8 from "node:assert/strict";
import { dirname as dirname3, join as join8 } from "node:path";
import { readFileSync as readFileSync3 } from "node:fs";
import { mkdtemp as mkdtemp2, readFile as readFile2, rm as rm2 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL as pathToFileURL2 } from "node:url";
function vitestAPI(value) {
  assertObject(value);
  assert8(typeof value.parseCLI === "function" && typeof value.createVitest === "function", "導入版Vitestの公開収集APIを利用できません");
}
async function reachByVitest(context, { root, config, quality, changes: { outside } }, inside) {
  const reached = new Map;
  const always = [];
  const reachesAssurance = new Set;
  const experimental = context.config.experimental;
  const records = Boolean(experimental?.recordDependencies);
  const query = async (paths, recorded) => {
    if (experimental !== undefined && records) {
      experimental.recordDependencies = recorded;
    }
    context.config.related = paths.map((path) => join8(root, path));
    const specs = await context.getRelevantTestSpecifications();
    const files = specs.map((spec) => repoPath(root, spec.moduleId));
    const unknown = files.filter((file) => !quality.includes(file) && !isAssurance(file, config));
    assert8(unknown.length === 0, `Vitestの到達先がquality集合と一致しません: ${unknown.join(", ")}`);
    return files;
  };
  const unrecorded = new Set(records ? await query([runtimePath], true) : []);
  always.push(...quality.filter((file) => unrecorded.has(file)));
  const reachOf = async (...paths) => {
    const graph = await query(paths, false);
    const recorded = records ? (await query(paths, true)).filter((file) => !unrecorded.has(file)) : [];
    return {
      targets: quality.filter((file) => graph.includes(file) || recorded.includes(file)),
      assurance: {
        graph: graph.filter((file) => isAssurance(file, config)),
        recorded: recorded.filter((file) => isAssurance(file, config))
      }
    };
  };
  const assuranceOnly = new Map;
  for (const path of inside) {
    const reach = await reachOf(path);
    reached.set(path, reach.targets);
    if (reach.targets.length === 0 && reach.assurance.graph.length + reach.assurance.recorded.length > 0 && !isAssurance(path, config)) {
      assuranceOnly.set(path, reach.assurance);
    }
  }
  if (assuranceOnly.size > 0) {
    const unloadable = new Set(await query([runtimePath], false));
    for (const [path, tests] of assuranceOnly) {
      if (tests.recorded.length > 0 || tests.graph.some((test) => !unloadable.has(test))) {
        reachesAssurance.add(path);
      }
    }
  }
  if (outside.length > 0) {
    always.push(...(await reachOf(...outside)).targets);
  }
  return { reached, always, reachesAssurance };
}
async function selectVitest(ctx, apiPath) {
  const { config, quality } = ctx;
  return selectQuality(ctx, {
    async reach(changes, fullRunKnown) {
      if (fullRunKnown) {
        return;
      }
      const inside = changes.map(({ path }) => path).filter((path) => !quality.includes(path));
      const pending = [...inside, ...ctx.changes.outside];
      if (pending.length === 0) {
        return { reached: new Map, always: [], reachesAssurance: new Set };
      }
      const api = await import(pathToFileURL2(apiPath).href);
      vitestAPI(api);
      const parsed = api.parseCLI(["vitest", "related", ...pending, ...config.testArgs, "--run"]);
      const { exclude: parsedExclude, ...options } = parsed.options;
      const context = await api.createVitest("test", {
        ...options,
        ...parsedExclude === undefined ? {} : { cliExclude: [parsedExclude].flat() },
        watch: false
      });
      try {
        return await reachByVitest(context, ctx, inside);
      } finally {
        await context.close();
      }
    }
  });
}
function excludePattern(root, path) {
  const escapedRoot = root.replace(/(?<!\\)([()[\]{}*?|]|^!|[!+@](?=\())/g, "\\$&");
  return `${escapedRoot}/${path.replace(/[\\()[\]{}!*+?@|]/g, "\\$&")}`;
}
function vitestCli(root) {
  const packagePath = createRequire(join8(root, "package.json")).resolve("vitest/package.json");
  const installed = JSON.parse(readFileSync3(packagePath, "utf8"));
  assertObject(installed);
  assertObject(installed.bin);
  assert8(typeof installed.bin.vitest === "string", "Vitestの公開CLIがありません");
  return join8(dirname3(packagePath), installed.bin.vitest);
}
async function runVitestTests(ctx) {
  const { root, config, quality, run } = ctx;
  const require2 = createRequire(join8(root, "package.json"));
  const cli = vitestCli(root);
  const exclude = config.assurance.flatMap((entry) => [
    "--exclude",
    excludePattern(root, entry.path)
  ]);
  const env = { ...process.env };
  const selected = await selectVitest(ctx, require2.resolve("vitest/node"));
  if (selected.kind !== "none" && selected.assuranceReach.length > 0) {
    console.log(`assuranceのテストにしか届かない変更は、このコマンドでは確かめません。全体checkとCIで実行します: ${selected.assuranceReach.join(", ")}`);
  }
  if (selected.kind === "exempt" || selected.kind === "none") {
    return selected;
  }
  const selection = selected.kind === "all" ? ["run", ...quality] : ["related", ...selected.files, "--run"];
  if (selected.kind === "all") {
    console.log(`quality全件の理由: 設定変更、削除、または依存先不明: ${selected.reasons.join(", ")}`);
  }
  const dir = await mkdtemp2(join8(tmpdir2(), "feedback-vitest-"));
  try {
    const report = join8(dir, "results.json");
    await run([
      process.execPath,
      cli,
      ...selection,
      ...config.testArgs,
      ...exclude,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ], { env });
    const result = JSON.parse(await readFile2(report, "utf8"));
    assertObject(result);
    assert8(result.success === true && typeof result.numTotalTests === "number" && result.numTotalTests > 0, "Vitestが完了していません。候補0件または結果欠落");
    assert8(Array.isArray(result.testResults), "Vitestのファイル結果がありません");
    assert8(typeof result.numPassedTests === "number" && result.numPassedTests > 0, "未実行: Vitestで成功したテストがありません");
    if (!config.allowSkipped) {
      assert8(result.numPassedTests === result.numTotalTests, "未実行: Vitestにskipまたはtodoがあります");
    }
    const executed = result.testResults.map((item) => {
      assertObject(item);
      assert8(typeof item.name === "string", "Vitest結果のファイル名が不正です");
      return repoPath(root, item.name);
    });
    assert8(executed.length > 0 && executed.every((file) => quality.includes(file)), "Vitestの実行結果がquality集合と一致しません");
    const completed = new Set(executed);
    assert8(selected.files.every((file) => completed.has(file)), "Vitestの選択したテストの結果が欠落しています");
    console.log(`quality選択: ${completed.size}件（Vitestの実行結果）`);
  } finally {
    await rm2(dir, { recursive: true, force: true });
  }
  return { kind: "ran" };
}

// src/command.ts
import assert9 from "node:assert/strict";
import { spawn, spawnSync as spawnSync3 } from "node:child_process";
class ReportedFailure extends Error {
}
var reportedExitCode = 79;

class CommandTimedOut extends Error {
}
var timedOutExitCode = 78;
var killAfterMs = 1000;
var graceMs = 1000;
var maxTimerMs = 2 ** 31 - 1;
function assertTimeoutMs(timeoutMs) {
  assert9(timeoutMs === undefined || typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= maxTimerMs, `時間の上限は、0より大きく${maxTimerMs}ミリ秒以下の有限の数です: ${String(timeoutMs)}`);
}
function commandRunner(runtime, retryCommand) {
  return async (argv, options = {}) => {
    assert9(argv[0], "実行コマンドがありません");
    const {
      cwd = process.cwd(),
      env = process.env,
      stdout = "inherit",
      allowFailure = false,
      display = argv,
      timeoutMs
    } = options;
    assertTimeoutMs(timeoutMs);
    const log = stdout === "inherit" ? console.log : console.error;
    const operation = stdout === "capture" ? "収集" : "実行";
    log(`${operation}: ${display.join(" ")}; 再実行: ${retryCommand}`);
    const startupEnv = { ...env };
    delete startupEnv.BUN_OPTIONS;
    delete startupEnv.NODE_OPTIONS;
    return superviseCommand({
      command: process.execPath,
      args: [...process.versions.bun ? ["--no-env-file"] : [], runtime, "execute-child"],
      options: {
        stdio: ["inherit", stdout === "capture" ? "pipe" : stdout, "pipe", "ipc"],
        cwd,
        env: startupEnv,
        detached: true,
        serialization: "json"
      },
      message: {
        argv,
        env,
        allowFailure,
        timeoutMs,
        relayStdout: stdout === "inherit" && !process.stdout.isTTY
      },
      monitorParent: false,
      childReports: true,
      timeoutMs
    });
  };
}
async function runMonitor() {
  assert9(process.connected && typeof process.send === "function", "内部の検査監視には親とのIPC接続が必要です");
  const input = await new Promise((done, fail) => {
    const disconnected = () => {
      process.off("message", received);
      fail(new Error("検査の開始前に親との接続が切れました"));
    };
    const received = (value) => {
      process.off("disconnect", disconnected);
      done(value);
    };
    process.once("disconnect", disconnected);
    process.once("message", received);
  });
  assertObject(input);
  const { argv, env, allowFailure = false, timeoutMs, relayStdout } = input;
  assert9(typeof allowFailure === "boolean");
  assert9(typeof relayStdout === "boolean");
  assertTimeoutMs(timeoutMs);
  assert9(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string"));
  const environment = stringRecord(env);
  process.stderr.on("error", () => {
    process.exitCode = 1;
    if (process.connected) {
      process.disconnect?.();
    }
  });
  const [command, ...args] = argv;
  assert9(command, "実行コマンドがありません");
  try {
    await superviseCommand({
      command,
      args,
      options: {
        stdio: ["inherit", relayStdout ? "pipe" : "inherit", "pipe"],
        cwd: process.cwd(),
        env: environment,
        detached: true,
        serialization: "json"
      },
      killAfterMs,
      monitorParent: true,
      childReports: false,
      relayStdout,
      allowFailure,
      timeoutMs,
      watch: timeoutMs === undefined ? undefined : {
        afterMs: timeoutMs,
        notice: `時間切れ: ${timeoutMs}ミリ秒の上限を過ぎたため、コマンドを止めます`
      }
    });
  } catch (error) {
    if (!(error instanceof CommandTimedOut)) {
      throw error;
    }
    process.exitCode = timedOutExitCode;
  }
}
function clearCancellationTimer(state) {
  if (state.phase === "cancelling") {
    clearTimeout(state.timer);
  }
}
function commandResult(result, failure, state, output, allowFailure, childReports, timeoutMs) {
  if ("error" in result) {
    throw result.error;
  }
  if (failure !== undefined) {
    assert9.fail(`子プロセスの終了を確認できません: ${String(failure.error)}`);
  }
  const finished = state.phase === "finished";
  const userCancelled = finished && state.cancelled && !state.timedOut;
  const timedOut = finished && state.timedOut || childReports && result.code === timedOutExitCode && result.signal === null;
  if (timedOut && !userCancelled) {
    throw new CommandTimedOut(`${timeoutMs}ミリ秒の上限を過ぎたため止めました`);
  }
  if (userCancelled || result.signal !== null || !allowFailure && result.code !== 0) {
    failRun(result, childReports);
  }
  return output;
}
function failRun(result, childReports) {
  if (childReports && result.code === reportedExitCode) {
    throw new ReportedFailure("監視プロセスが診断を表示しました");
  }
  if (childReports && result.code === timedOutExitCode) {
    assert9.fail("取り消しました。時間の上限も過ぎていました");
  }
  assert9.fail(`検査失敗または取消: ${result.signal ?? result.code}`);
}
function signalProcessGroup(pgid, signal, kill = (pid, sent) => process.kill(pid, sent), readProcessList = listProcesses) {
  try {
    kill(-pgid, signal);
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return;
    }
    if (!hasErrorCode(error, "EPERM")) {
      return { error };
    }
    return deniedGroupFailure(pgid, error, readProcessList);
  }
  return;
}
function deniedGroupFailure(pgid, error, readProcessList) {
  try {
    return countLiveMembers(readProcessList(), pgid) === 0 ? undefined : { error };
  } catch (listError) {
    return {
      error: new Error(`${errorMessage(error)}。プロセスの一覧を読めません: ${errorMessage(listError)}`, { cause: error })
    };
  }
}
function listProcesses() {
  const result = spawnSync3("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  assert9(result.status === 0, `psが${result.signal ?? result.status}で終わりました: ${result.stderr.trim()}`);
  return result.stdout;
}
function countLiveMembers(processList, pgid) {
  return processList.split(`
`).filter((line) => {
    const [, group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && stat !== undefined && !stat.startsWith("Z");
  }).length;
}
function relay(output) {
  process.stdout.on("error", () => output.destroy());
  output.pipe(process.stdout, { end: false });
}
var relayDrainLimitBytes = 1024 * 1024;
function drainRelay(output) {
  output.unpipe(process.stdout);
  let drainedBytes = 0;
  output.on("data", (chunk) => {
    drainedBytes += chunk.length;
    if (drainedBytes > relayDrainLimitBytes) {
      console.error(`出力のpipe: 終了したプロセスの標準出力のpipeへ、別のプロセスが${relayDrainLimitBytes}バイトを超えて書き続けるため、閉じるのを待たずに終えます`);
      output.destroy();
      return;
    }
    if (!process.stdout.destroyed) {
      process.stdout.write(chunk);
    }
  });
  output.resume();
}
async function superviseCommand(command) {
  assert9(!command.monitorParent || process.connected, "検査の開始前に親との接続が切れました");
  let state = { phase: "starting" };
  let failure;
  const stop = (child, signal) => {
    if (child.pid === undefined) {
      return;
    }
    const signalFailure = signalProcessGroup(child.pid, signal);
    failure ??= signalFailure;
  };
  const transition = (event) => {
    if (event.type === "started") {
      state = { phase: "running", child: event.child };
      return;
    }
    if (event.type === "close") {
      clearCancellationTimer(state);
      state = state.phase === "cancelling" ? { phase: "finished", cancelled: true, timedOut: state.timedOut } : { phase: "finished", cancelled: false, timedOut: false };
      return;
    }
    switch (state.phase) {
      case "starting":
      case "finished":
        return;
      case "running": {
        const { child } = state;
        const timedOut = event.notice !== undefined;
        if (timedOut) {
          console.error(event.notice);
        }
        state = { phase: "cancelling", child, timer: undefined, timedOut };
        stop(child, event.signal);
        if (command.killAfterMs !== undefined) {
          state.timer = setTimeout(() => stop(child, "SIGKILL"), command.killAfterMs);
          state.timer.unref();
        }
        return;
      }
      case "cancelling":
        stop(state.child, event.signal);
    }
  };
  let deadline;
  let pipeWait;
  let stdout = "";
  let stdoutBytes = 0;
  let stderr = "";
  const interrupt = () => transition({ type: "cancel", signal: "SIGINT" });
  const terminate = () => transition({ type: "cancel", signal: "SIGTERM" });
  const collect = (chunk) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 64 * 1024 * 1024) {
      failure ??= { error: new Error("テスト収集の出力が64MiBを超えました") };
      transition({ type: "cancel", signal: "SIGTERM" });
    } else {
      stdout += chunk;
    }
  };
  const sent = (error) => {
    if (error) {
      failure ??= { error };
      transition({ type: "cancel", signal: "SIGKILL" });
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  if (command.monitorParent) {
    process.on("disconnect", terminate);
  }
  try {
    const result = await new Promise((done) => {
      const child = spawn(command.command, command.args, command.options);
      const relayed = command.relayStdout === true ? child.stdout : null;
      child.once("error", (error) => done({ error }));
      child.once("close", (code, signal) => {
        transition({ type: "close" });
        done({ code, signal });
      });
      child.once("exit", () => {
        clearTimeout(deadline);
        stop(child, "SIGKILL");
        if (relayed !== null) {
          drainRelay(relayed);
        }
        pipeWait = setTimeout(() => {
          for (const [name, pipe] of [
            ["標準出力", child.stdout],
            ["標準エラー", child.stderr]
          ]) {
            if (pipe !== null && !pipe.readableEnded && !pipe.destroyed) {
              console.error(`出力のpipe: 終了したプロセスの${name}のpipeを、別のプロセスが${graceMs}ミリ秒たっても開いたままのため、閉じるのを待たずに終えます`);
            }
            pipe?.destroy();
          }
        }, graceMs);
      });
      assert9(child.stderr);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (!process.stderr.destroyed) {
          process.stderr.write(chunk);
        }
        stderr += chunk.slice(0, Math.max(0, 4096 - stderr.length));
      });
      if (relayed !== null) {
        relay(relayed);
      } else {
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", collect);
      }
      transition({ type: "started", child });
      const { watch } = command;
      if (watch !== undefined) {
        deadline = setTimeout(() => transition({ type: "cancel", signal: "SIGTERM", notice: watch.notice }), watch.afterMs);
      }
      if (command.message !== undefined) {
        child.send(command.message, sent);
      }
    });
    return commandResult(result, failure, state, { stdout, stderr }, command.allowFailure ?? false, command.childReports, command.timeoutMs);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("disconnect", terminate);
    clearTimeout(deadline);
    clearTimeout(pipeWait);
    clearCancellationTimer(state);
    if (command.monitorParent && process.connected) {
      process.disconnect?.();
    }
  }
}

// src/equivalents.ts
import assert11 from "node:assert/strict";
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join9, posix as posix2 } from "node:path";

// src/mutants.ts
import assert10 from "node:assert/strict";
function isNode(value) {
  return isRecord(value) && typeof value.type === "string" && typeof value.start === "number" && typeof value.end === "number";
}
function child(node, key) {
  const value = node[key];
  return isNode(value) ? value : undefined;
}
function operator(node) {
  return typeof node.operator === "string" ? node.operator : "";
}
var typeKeys = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "implements",
  "decorators"
]);
var tsRuntime = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSExportAssignment",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember"
]);
function isDirective(node) {
  return node.type === "ExpressionStatement" && typeof node.directive === "string";
}
var transparent = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion"
]);
function unwrap(node) {
  let current = node;
  while (transparent.has(current.type) || current.type === "ChainExpression") {
    const inner = child(current, "expression");
    if (inner === undefined) {
      break;
    }
    current = inner;
  }
  return current;
}
function isSkipped(node) {
  if (node.type.startsWith("TS")) {
    return !tsRuntime.has(node.type) || node.declare === true;
  }
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportAllDeclaration":
    case "Decorator":
      return true;
    case "ExportNamedDeclaration":
      return node.source !== null || node.exportKind === "type";
    case "VariableDeclaration":
    case "ClassDeclaration":
    case "PropertyDefinition":
      return node.declare === true;
    case "FunctionDeclaration":
      return node.declare === true || node.body === null;
    case "ExpressionStatement":
      return isDirective(node);
    default:
      return false;
  }
}
function childFrames(frame, visitorKeys) {
  const frames = [];
  for (const key of visitorKeys[frame.node.type] ?? []) {
    if (typeKeys.has(key)) {
      continue;
    }
    const value = frame.node[key];
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (isNode(item)) {
          frames.push({ node: item, parent: frame, key, index });
        }
      });
    } else if (isNode(value)) {
      frames.push({ node: value, parent: frame, key, index: undefined });
    }
  }
  return frames;
}
function walk(program, visitorKeys, visit) {
  const go = (frame) => {
    if (isSkipped(frame.node)) {
      return;
    }
    visit(frame);
    for (const next of childFrames(frame, visitorKeys)) {
      go(next);
    }
  };
  go({ node: program, parent: undefined, key: "", index: undefined });
}
function outermost(frame) {
  let current = frame;
  while (current.parent && transparent.has(current.parent.node.type)) {
    current = current.parent;
  }
  return current;
}
function whole(frame, rule, replacement) {
  return { rule, start: frame.node.start, end: frame.node.end, replacement, frame };
}
function swapOperator(source, node, from, to, logical) {
  const left = child(node, "left");
  const right = child(node, "right");
  assert10(left !== undefined && right !== undefined, `${node.type}にleftとrightがありません`);
  const at = nextToken(source, left.end, from);
  assert10(at >= 0 && at + from.length <= right.start, `${node.type}の演算子${from}が見つかりません`);
  const operand = (item) => {
    const text = source.slice(item.start, item.end);
    return logical && item.type === "LogicalExpression" ? `(${text})` : text;
  };
  const text = source.slice(node.start, left.start) + operand(left) + source.slice(left.end, at) + to + source.slice(at + from.length, right.start) + operand(right) + source.slice(right.end, node.end);
  return logical ? `(${text})` : text;
}
function startsListedStatement(frame, start) {
  let current = frame;
  while (current.parent !== undefined && current.parent.node.start === start) {
    if (current.parent.node.type === "ExpressionStatement") {
      return current.parent.index !== undefined;
    }
    current = current.parent;
  }
  return false;
}
var equality = {
  "<": ["<=", ">="],
  "<=": ["<", ">"],
  ">": [">=", "<="],
  ">=": [">", "<"],
  "==": ["!="],
  "!=": ["=="],
  "===": ["!=="],
  "!==": ["==="]
};
function isComparison(node) {
  return node.type === "BinaryExpression" && Object.hasOwn(equality, operator(node));
}
function equalityOperator(frame, source) {
  const { node } = frame;
  if (node.type !== "BinaryExpression") {
    return [];
  }
  const from = operator(node);
  return (Object.hasOwn(equality, from) ? equality[from] ?? [] : []).map((to) => whole(frame, "EqualityOperator", swapOperator(source, node, from, to, false)));
}
var logical = { "&&": "||", "||": "&&", "??": "&&" };
function logicalOperator(frame, source) {
  const { node } = frame;
  const from = operator(node);
  const to = Object.hasOwn(logical, from) ? logical[from] : undefined;
  if (node.type !== "LogicalExpression" || to === undefined) {
    return [];
  }
  return [whole(frame, "LogicalOperator", swapOperator(source, node, from, to, true))];
}
var loops = new Set(["WhileStatement", "DoWhileStatement", "ForStatement"]);
var conditions = new Set(["IfStatement", "ConditionalExpression"]);
function nextToken(source, from, token) {
  let index = from;
  while (index < source.length) {
    if (source.startsWith(token, index)) {
      return index;
    }
    if (/\s/.test(source[index] ?? "")) {
      index++;
    } else if (source.startsWith("//", index)) {
      const newline = source.slice(index).search(/[\n\r\u2028\u2029]/);
      if (newline < 0) {
        return -1;
      }
      index += newline;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        return -1;
      }
      index = end + 2;
    } else {
      return -1;
    }
  }
  return -1;
}
function emptyForTest(frame, source) {
  const { node } = frame;
  const init = child(node, "init");
  let from;
  if (init === undefined) {
    const paren = nextToken(source, node.start + "for".length, "(");
    if (paren < 0) {
      return [];
    }
    from = paren + 1;
  } else {
    from = init.end;
  }
  const semicolon = nextToken(source, from, ";");
  return semicolon < 0 ? [] : [
    {
      rule: "ConditionalExpression",
      start: semicolon + 1,
      end: semicolon + 1,
      replacement: "false",
      frame
    }
  ];
}
function isConditionTest(frame) {
  const type = frame.parent?.node.type;
  return frame.key === "test" && type !== undefined && (loops.has(type) || conditions.has(type));
}
function isNegation(frame) {
  return frame?.node.type === "UnaryExpression" && operator(frame.node) === "!";
}
function isNegatedConditionTest(position) {
  const negation = position.parent;
  return isNegation(negation) && isConditionTest(outermost(negation));
}
function operandConditions(frame) {
  const { node } = frame;
  const isLogical = node.type === "LogicalExpression" && operator(node) !== "??";
  const position = outermost(frame);
  if (!isComparison(node) && !isLogical || isConditionTest(position)) {
    return [];
  }
  const redundant = isNegatedConditionTest(position);
  const outer = position.parent?.node;
  const parentOperator = outer?.type === "LogicalExpression" ? operator(outer) : undefined;
  return [
    ...parentOperator === "||" ? [] : [{ ...whole(frame, "ConditionalExpression", "true"), redundant }],
    ...parentOperator === "&&" ? [] : [{ ...whole(frame, "ConditionalExpression", "false"), redundant }]
  ];
}
function conditionalExpression(frame, source) {
  const { node, parent } = frame;
  if (parent === undefined) {
    return [];
  }
  if (node.type === "ForStatement" && child(node, "test") === undefined) {
    return emptyForTest(frame, source);
  }
  if (!isConditionTest(frame)) {
    return operandConditions(frame);
  }
  return loops.has(parent.node.type) ? [whole(frame, "ConditionalExpression", "false")] : [
    whole(frame, "ConditionalExpression", "true"),
    whole(frame, "ConditionalExpression", "false")
  ];
}
var bare = new Set(["Identifier", "ParenthesizedExpression"]);
function booleanLiteral(frame, source) {
  const { node } = frame;
  if (node.type === "Literal" && typeof node.value === "boolean") {
    return [whole(frame, "BooleanLiteral", node.value ? "false" : "true")];
  }
  const argument = child(node, "argument");
  if (isNegation(frame) && argument !== undefined) {
    const text = source.slice(argument.start, argument.end);
    return [
      {
        ...whole(frame, "BooleanLiteral", bare.has(argument.type) ? text : `(${text})`),
        redundant: isNegation(outermost(frame).parent)
      }
    ];
  }
  return [];
}
function isSuperCall(node) {
  return node?.type === "CallExpression" && child(node, "callee")?.type === "Super";
}
function callExpression(frame) {
  const { node } = frame;
  const expression = node.type === "ExpressionStatement" ? child(node, "expression") : undefined;
  const call = expression === undefined ? undefined : unwrap(expression);
  if (call?.type !== "CallExpression" || isSuperCall(call)) {
    return [];
  }
  return [whole(frame, "CallExpression", ";")];
}
var methodRemovals = new Set([
  "charAt",
  "filter",
  "reverse",
  "slice",
  "sort",
  "substr",
  "substring",
  "trim"
]);
var methodSwaps = {
  endsWith: "startsWith",
  startsWith: "endsWith",
  every: "some",
  some: "every",
  toLocaleLowerCase: "toLocaleUpperCase",
  toLocaleUpperCase: "toLocaleLowerCase",
  toLowerCase: "toUpperCase",
  toUpperCase: "toLowerCase",
  trimEnd: "trimStart",
  trimStart: "trimEnd",
  min: "max",
  max: "min"
};
function methodExpression(frame, source) {
  const { node } = frame;
  const callee = node.type === "CallExpression" ? child(node, "callee") : undefined;
  if (callee?.type !== "MemberExpression" || callee.computed === true) {
    return [];
  }
  const object = child(callee, "object");
  const property = child(callee, "property");
  const name = property?.type === "Identifier" ? property.name : undefined;
  if (object === undefined || property === undefined || typeof name !== "string") {
    return [];
  }
  if (methodRemovals.has(name)) {
    return object.type === "Super" ? [] : [whole(frame, "MethodExpression", source.slice(object.start, object.end))];
  }
  const swap = Object.hasOwn(methodSwaps, name) ? methodSwaps[name] : undefined;
  return swap === undefined ? [] : [
    {
      rule: "MethodExpression",
      start: property.start,
      end: property.end,
      replacement: swap,
      frame
    }
  ];
}
var rules = [
  booleanLiteral,
  callExpression,
  conditionalExpression,
  equalityOperator,
  logicalOperator,
  methodExpression
];
var functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression"
]);
function identifierName(node) {
  if (node?.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}
function ownerName(frame) {
  if (frame === undefined) {
    return;
  }
  const own = identifierName(child(frame.node, "id"));
  const holder = outermost(frame).parent?.node;
  return own ?? (holder?.type === "VariableDeclarator" ? identifierName(child(holder, "id")) : undefined);
}
var members = new Set(["MethodDefinition", "Property", "PropertyDefinition"]);
function memberName(holder) {
  const key = holder.node.computed === true ? undefined : identifierName(child(holder.node, "key"));
  if (key === undefined) {
    return;
  }
  const owner = ownerName(holder.node.type === "Property" ? holder.parent : holder.parent?.parent);
  const kind = holder.node.kind === "get" || holder.node.kind === "set" ? `${holder.node.kind} ` : "";
  const placement = holder.node.static === true ? "static " : "";
  return `${placement}${kind}${owner === undefined ? "" : `${owner}.`}${key}`;
}
function functionName(frame) {
  const holder = outermost(frame).parent;
  return holder !== undefined && members.has(holder.node.type) ? memberName(holder) : ownerName(frame);
}
function declaredName(node) {
  const declaration = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration" ? child(node, "declaration") : node;
  const declarators = declaration?.declarations;
  if (declaration?.type === "VariableDeclaration" && Array.isArray(declarators)) {
    const [only, ...rest] = declarators.filter(isNode);
    return only !== undefined && rest.length === 0 ? identifierName(child(only, "id")) : undefined;
  }
  const id = declaration === undefined ? undefined : child(declaration, "id");
  return id?.type === "Identifier" ? identifierName(id) : undefined;
}
function segment(frame) {
  const name = frame.parent?.parent === undefined ? declaredName(frame.node) : undefined;
  if (name !== undefined) {
    return `${frame.key}{${name}}`;
  }
  return frame.index === undefined ? frame.key : `${frame.key}[${frame.index}]`;
}
function location(frame) {
  const steps = [];
  const names = [];
  let current = frame;
  while (current?.parent !== undefined) {
    const name = functionTypes.has(current.node.type) ? functionName(current) : undefined;
    if (name !== undefined) {
      names.unshift(name);
    } else if (names.length === 0) {
      steps.unshift(segment(current));
    }
    current = current.parent;
  }
  return { scope: names.length > 0 ? names.join(">") : "<top>", steps: steps.join(".") };
}
function lineStarts(source) {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}
function lineAt(starts, offset) {
  return starts.findLastIndex((start) => start <= offset) + 1;
}
var identifierPart = /[\p{ID_Continue}$\u200c\u200d]/u;
function separated(source, { replacement, start, frame }) {
  if (/^[([`]/.test(replacement) && startsListedStatement(frame, start)) {
    return `;${replacement}`;
  }
  return identifierPart.test(source[start - 1] ?? "") && identifierPart.test(replacement[0] ?? "") ? ` ${replacement}` : replacement;
}
function keyPart(text) {
  return text.replaceAll(/[%:]/g, (char) => char === "%" ? "%25" : "%3A");
}
function keyPath(key) {
  const end = key.indexOf(":");
  return end < 0 ? undefined : key.slice(0, end).replaceAll(/%3A|%25/g, (code) => code === "%25" ? "%" : ":");
}
function mutants(parser, path, source) {
  const parsed = parser.parseSync(path, source);
  const [error] = parsed.errors;
  assert10(error === undefined, `${path}を構文解析できません: ${error?.message ?? ""}`);
  const program = parsed.program;
  assert10(isNode(program), `${path}の構文木を読めません`);
  const candidates = [];
  walk(program, parser.visitorKeys, (frame) => {
    for (const rule of rules) {
      candidates.push(...rule(frame, source));
    }
  });
  const starts = lineStarts(source);
  const edits = new Set;
  const keys = new Set;
  const result = [];
  for (const candidate of candidates) {
    const original = source.slice(candidate.start, candidate.end);
    const edit = JSON.stringify([candidate.start, candidate.end, candidate.replacement]);
    if (candidate.replacement === original || edits.has(edit)) {
      continue;
    }
    edits.add(edit);
    const replacement = separated(source, candidate);
    const { scope, steps } = location(candidate.frame);
    const base = `${keyPart(path)}:${keyPart(scope)}:${steps}:${candidate.rule}:${sha256(replacement).slice(0, 12)}`;
    let key = base;
    for (let count = 2;keys.has(key); count++) {
      key = `${base}#${count}`;
    }
    keys.add(key);
    if (candidate.redundant === true) {
      continue;
    }
    result.push({
      key,
      path,
      line: lineAt(starts, candidate.start),
      rule: candidate.rule,
      original,
      replacement,
      start: candidate.start,
      end: candidate.end
    });
  }
  return result;
}

// src/equivalents.ts
var keyShape = "鍵は、repoからのそろえたパスと、関数、経路、規則、hashの5つを':'でつなぎます。パスは./で始めず、空の部分、.、..、前後の空白を持ちません。パスと関数の中の'%'と':'は、'%25'と'%3A'と書きます";
function keyModule(key) {
  const path = keyPath(key);
  return path !== undefined && key.split(":").length === 5 && key.startsWith(`${keyPart(path)}:`) && path !== "" && path.trim() === path && posix2.normalize(path) === path && isRepoRelativePath(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..") ? path : undefined;
}
function fileExists(root, path) {
  return isFile(join9(root, path)) && repoPath(root, path) === path;
}
function invalid(detail) {
  return `${mutantsRecordFile}の形が崩れています（${detail}）。{"equivalent":[{"key":"<鍵>","original":"<置き換える前の字>","reason":"<理由>"}]}の形で書いてください`;
}
function filled(value) {
  return typeof value === "string" && value.trim() !== "";
}
function readText(root) {
  try {
    return readFileSync4(join9(root, mutantsRecordFile), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    return assert11.fail(`${mutantsRecordFile}を読めません: ${errorMessage(error)}`);
  }
}
function entryAt(entry, index) {
  assert11(isRecord(entry) && Object.keys(entry).length === 3 && typeof entry.key === "string" && typeof entry.original === "string" && filled(entry.reason), invalid(`${index + 1}件目は、文字列のkeyとoriginalと、空でないreasonだけを持ちます`));
  assert11(keyModule(entry.key) !== undefined, invalid(`${index + 1}件目の鍵: ${entry.key}。${keyShape}`));
  return { key: entry.key, original: entry.original, reason: entry.reason };
}
function readEquivalents(root) {
  const text = readText(root);
  if (text === undefined) {
    return [];
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    assert11.fail(invalid(`JSONとして読めません: ${errorMessage(error)}`));
  }
  assert11(isRecord(value) && Object.keys(value).length === 1 && Array.isArray(value.equivalent), invalid("最上位はequivalentの配列だけを持ちます"));
  const keys = new Set;
  return value.equivalent.map((entry, index) => {
    const equivalent = entryAt(entry, index);
    assert11(!keys.has(equivalent.key), invalid(`鍵が重なっています: ${equivalent.key}`));
    keys.add(equivalent.key);
    return equivalent;
  });
}

// src/mutation.ts
import assert14 from "node:assert/strict";
import { statSync as statSync3 } from "node:fs";
import { join as join12 } from "node:path";

// src/mutation-guard.ts
import assert12 from "node:assert/strict";
import { existsSync as existsSync7, lstatSync as lstatSync2, readFileSync as readFileSync5, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join10 } from "node:path";
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}
function create(path) {
  try {
    writeFileSync2(path, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}
function takeOver(path, holder) {
  const takeover = `${path}.takeover`;
  assert12(create(takeover), `別のmutationの実行が、強制終了された実行のロックを引き継いでいる途中です。ほかの実行が残っていなければ、${takeover}を消してから実行してください`);
  try {
    assert12(readLock(path) === holder, "別のmutationの実行が先にロックを取りました");
    writeFileSync2(path, String(process.pid));
  } finally {
    rmSync2(takeover, { force: true });
  }
}
function readLock(path) {
  try {
    return readFileSync5(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}
function lock(directory, read = readLock) {
  const path = join10(directory, "mutation.lock");
  while (!create(path)) {
    const holder = read(path);
    if (holder === undefined) {
      assert12(!lstatSync2(path, { throwIfNoEntry: false })?.isSymbolicLink(), `${path}は、指す先の無いシンボリックリンクです。消してから実行してください`);
      continue;
    }
    const pid = Number(holder);
    assert12(Number.isSafeInteger(pid) && pid > 0 && !isAlive(pid), `別のmutationの実行が進んでいます（PID ${holder || "未記入"}）。その実行が残っていなければ、${path}を消してから実行してください`);
    takeOver(path, holder);
    break;
  }
  return () => rmSync2(path, { force: true });
}
function journalPath(directory) {
  return join10(directory, "mutation-original.json");
}
function replacementPath(directory) {
  return join10(directory, "mutation-replacement.json");
}
function mutated(original, { start, end, replacement }) {
  const source = original.toString("utf8");
  return Buffer.from(source.slice(0, start) + replacement + source.slice(end));
}
function isPrefix(current, content) {
  return current.length <= content.length && current.equals(content.subarray(0, current.length));
}
function readReplacement(directory, original) {
  let text;
  try {
    text = readFileSync5(replacementPath(directory), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const replacement = JSON.parse(text);
  const length = original.toString("utf8").length;
  assert12(isRecord(replacement) && typeof replacement.replacement === "string" && Number.isSafeInteger(replacement.start) && Number.isSafeInteger(replacement.end) && 0 <= Number(replacement.start) && Number(replacement.start) <= Number(replacement.end) && Number(replacement.end) <= length, `前の実行の記録を読めません。対象のファイルを確かめてから、${journalPath(directory)}を消してください`);
  return {
    start: Number(replacement.start),
    end: Number(replacement.end),
    replacement: replacement.replacement
  };
}
function removeJournal(directory) {
  rmSync2(replacementPath(directory), { force: true });
  rmSync2(journalPath(directory));
}
function restoreInterrupted(root, directory) {
  let text;
  try {
    text = readFileSync5(journalPath(directory), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const journal = JSON.parse(text);
  assert12(isRecord(journal) && typeof journal.path === "string" && typeof journal.original === "string", `前の実行の記録を読めません。対象のファイルを確かめてから、${journalPath(directory)}を消してください`);
  assertRepoRelativePath(journal.path);
  const file = join10(root, journal.path);
  const original = Buffer.from(journal.original, "base64");
  assert12(existsSync7(file), `前の実行の記録${journalPath(directory)}が残っていますが、${journal.path}がありません。移した先のファイルに壊し方が残っていないか確かめてから、記録を消してください`);
  const current = readFileSync5(file);
  if (current.equals(original)) {
    removeJournal(directory);
    return;
  }
  const replacement = readReplacement(directory, original);
  assert12(isPrefix(current, original) || replacement !== undefined && isPrefix(current, mutated(original, replacement)), `前の実行の記録${journalPath(directory)}が残っていますが、${journal.path}は当てた壊し方とも元の内容とも違うため、上書きしません。${journal.path}を確かめてから、記録を消してください`);
  writeFileSync2(file, original);
  removeJournal(directory);
  return journal.path;
}
function assertMatchesHead(root, path) {
  const head = gitOutput(root, ["rev-parse", "--verify", "--quiet", `HEAD:./${path}`]);
  assert12(head, `${path}がHEADにありません。commitしてから実行してください`);
  assert12(gitOutput(root, ["hash-object", "--", path]) === head, `${path}がHEADの内容と違います。commitするか元に戻してから実行してください`);
}
async function pendingSignalsDelivered() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
}
async function guardMutation(root, path, work) {
  const directory = recordsDirectory(root);
  const unlock = lock(directory);
  let received;
  const receive = (signal) => {
    received ??= signal;
  };
  const assertNotCancelled = async () => {
    await pendingSignalsDelivered();
    assert12(received === undefined, `${received}で取り消されました`);
  };
  process.on("SIGINT", receive);
  process.on("SIGTERM", receive);
  try {
    const restored = restoreInterrupted(root, directory);
    if (restored !== undefined) {
      console.error(`前の実行が壊し方を当てたまま終わった${restored}を、元の内容に戻しました`);
    }
    assertMatchesHead(root, path);
    const file = join10(root, path);
    const original = readFileSync5(file);
    rmSync2(replacementPath(directory), { force: true });
    writeAtomically(journalPath(directory), JSON.stringify({ path, original: original.toString("base64") }));
    let result;
    try {
      result = await work({
        source: original.toString("utf8"),
        apply: (replacement) => {
          const { start, end } = replacement;
          writeAtomically(replacementPath(directory), JSON.stringify({ start, end, replacement: replacement.replacement }));
          writeFileSync2(file, mutated(original, replacement));
        },
        restore: () => writeFileSync2(file, original),
        assertNotCancelled
      });
    } finally {
      writeFileSync2(file, original);
      removeJournal(directory);
    }
    await assertNotCancelled();
    return result;
  } finally {
    process.off("SIGINT", receive);
    process.off("SIGTERM", receive);
    unlock();
  }
}

// src/mutation-run.ts
import assert13 from "node:assert/strict";
import { mkdtemp as mkdtemp3, readFile as readFile3, rm as rm3 } from "node:fs/promises";
import { tmpdir as tmpdir3 } from "node:os";
import { join as join11 } from "node:path";
function error(reason) {
  return { kind: "error", reason };
}
function bunSummary(root, text) {
  const { report, suites } = readBunSuites(text, root);
  return {
    files: new Set(suites.keys()),
    unloaded: [],
    executed: junitCount(report, "tests") - junitCount(report, "skipped"),
    failed: junitCount(report, "failures") + junitCount(report, "errors", "0")
  };
}
function vitestCount(result, name) {
  const value = result[name];
  assert13(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `Vitestの${name}が不正です`);
  return value;
}
function vitestSummary(root, text) {
  const result = JSON.parse(text);
  assertObject(result);
  assert13(Array.isArray(result.testResults), "Vitestのファイル結果がありません");
  const files = new Set;
  const unloaded = [];
  let hookFailed = 0;
  for (const item of result.testResults) {
    assertObject(item);
    assert13(typeof item.name === "string", "Vitest結果のファイル名が不正です");
    assert13(Array.isArray(item.assertionResults), "Vitest結果のテストの一覧がありません");
    const path = repoPath(root, item.name);
    files.add(path);
    if (item.assertionResults.length === 0) {
      unloaded.push(path);
    } else if (item.status === "failed" && !item.assertionResults.some((test) => isRecord(test) && test.status === "failed")) {
      hookFailed++;
    }
  }
  const failed = vitestCount(result, "numFailedTests") + hookFailed;
  return { files, unloaded, executed: vitestCount(result, "numPassedTests") + failed, failed };
}
function excludeUngivenTests(root, all, files) {
  return all.flatMap((file) => files.includes(file) ? [] : ["--exclude", excludePattern(root, file)]);
}
var runners = {
  bun: {
    report: "results.xml",
    argv: ({ config }, files, report) => bunTestArgv(config, files, report),
    summarize: bunSummary
  },
  vitest: {
    report: "results.json",
    argv: ({ root, config, all }, files, report) => [
      process.execPath,
      vitestCli(root),
      "run",
      ...files,
      ...config.testArgs,
      ...excludeUngivenTests(root, all, files),
      "--no-cache",
      "--reporter=json",
      `--outputFile=${report}`
    ],
    summarize: vitestSummary
  }
};
function verdict(root, files, text, summarize, allowNoTests) {
  if (text === undefined) {
    return error("テストの結果の報告がありません");
  }
  let summary;
  try {
    summary = summarize(root, text);
  } catch (reason) {
    return error(`テストの結果の報告を読めません: ${errorMessage(reason)}`);
  }
  const extra = [...summary.files].filter((file) => !files.includes(file));
  if (extra.length > 0) {
    return error(`渡していないテストファイルが結果にあります: ${extra.join(", ")}`);
  }
  if (summary.unloaded.length > 0) {
    return error(`読み込みに失敗したテストファイルがあります: ${summary.unloaded.join(", ")}`);
  }
  const missing = files.filter((file) => !summary.files.has(file));
  if (missing.length > 0) {
    return error(`報告にないテストファイルがあります（読み込みの失敗など）: ${missing.join(", ")}`);
  }
  if (!(summary.executed > 0) && !allowNoTests) {
    return error("実行したテストが0件です");
  }
  return summary.failed > 0 ? { kind: "killed" } : { kind: "survived" };
}
async function readReport(path) {
  try {
    return await readFile3(path, "utf8");
  } catch (reason) {
    if (hasErrorCode(reason, "ENOENT")) {
      return;
    }
    throw reason;
  }
}
async function runMutationTests(ctx, files, {
  timeoutMs,
  assertNotCancelled,
  allowNoTests = false
}) {
  const { root, config, run } = ctx;
  const dir = await mkdtemp3(join11(tmpdir3(), "feedback-loop-mutation-"));
  try {
    const runner = runners[config.runner];
    const report = join11(dir, runner.report);
    const argv = runner.argv(ctx, files, report);
    await assertNotCancelled();
    const started = performance.now();
    try {
      await run(argv, { cwd: root, stdout: "ignore", allowFailure: true, timeoutMs });
    } catch (reason) {
      if (reason instanceof CommandTimedOut) {
        return { verdict: { kind: "timedOut" }, durationMs: performance.now() - started };
      }
      throw reason;
    }
    const durationMs = performance.now() - started;
    return {
      verdict: verdict(root, files, await readReport(report), runner.summarize, allowNoTests),
      durationMs
    };
  } finally {
    await rm3(dir, { recursive: true, force: true });
  }
}

// src/mutation.ts
function loadParser() {
  return import("oxc-parser").catch((error) => assert14.fail(`oxc-parserを読み込めません。導入先のdevDependenciesに固定版で入れてください: ${errorMessage(error)}`));
}
function repoFile(root, path, subject) {
  const local = repoPath(root, path);
  assertRepoRelativePath(local);
  assert14(statSync3(join12(root, local), { throwIfNoEntry: false })?.isFile() ?? false, `${subject}がファイルではありません: ${path}`);
  return local;
}
function limitFor(durationMs) {
  return Math.ceil(durationMs * 1.5) + 5000;
}
async function baseline(ctx, files, subject, options) {
  console.error(`基準の実行: ${subject} ${files.length}件`);
  const { verdict, durationMs } = await runMutationTests(ctx, files, options);
  assert14(verdict.kind === "survived", `壊していない状態で${subject}が通りません（${verdict.kind === "error" ? verdict.reason : "失敗したテストがあります"}）。壊し方を当てずに止めます`);
  return limitFor(durationMs);
}
async function runEach(ctx, target, found, files, subject, { allowNoTests = false } = {}) {
  await target.assertNotCancelled();
  const options = { assertNotCancelled: target.assertNotCancelled, allowNoTests };
  const limit = await baseline(ctx, files, subject, options);
  const results = [];
  for (const [index, mutant] of found.entries()) {
    await target.assertNotCancelled();
    target.apply(mutant);
    let verdict;
    try {
      verdict = (await runMutationTests(ctx, files, { ...options, timeoutMs: limit })).verdict;
    } finally {
      target.restore();
    }
    console.error(`壊し方 ${index + 1}/${found.length}（${subject}）: ${verdict.kind} ${mutant.key}`);
    results.push({ mutant, verdict });
  }
  return results;
}
function item({ key, path, line, rule, original, replacement }) {
  return { key, path, line, rule, original, replacement };
}
async function prepare({ root, config, run }) {
  const parser = await loadParser();
  const classes = await classification(root, config, run);
  return { parser, all: classes.all, quality: classes.quality };
}
function givenTests(root, all, files) {
  const given = files.map((file) => {
    const local = repoFile(root, file, "テスト");
    assert14(all.includes(local), `testGlobsに当たるテストではありません: ${file}`);
    return local;
  });
  return [...new Set(given)];
}
async function runPrepare({ config, run }, target) {
  await target.assertNotCancelled();
  if (config.prepare.length > 0) {
    await run(config.prepare, { stdout: "ignore" });
  }
}
function matcher(root, path, equivalents) {
  const own = new Map(equivalents.filter(({ key }) => keyPath(key) === path).map(({ key, original }) => [key, original]));
  return {
    recordOf(mutant) {
      const original = own.get(mutant.key);
      if (original === undefined) {
        return;
      }
      return original === mutant.original ? "equivalent" : "changed";
    },
    notGenerated(found) {
      const generated = new Set(found.map(({ key }) => key));
      return equivalents.filter(({ key }) => own.has(key) ? !generated.has(key) : !fileExists(root, keyPath(key) ?? "")).map(({ key }) => key);
    }
  };
}
function place(report, match, { mutant, verdict }) {
  const record = match.recordOf(mutant);
  if (record === "changed") {
    report.stale.push({ key: mutant.key, reason: "changed" });
  }
  if (verdict.kind === "error") {
    report.errors.push({ ...item(mutant), reason: verdict.reason });
  } else if (record === "equivalent") {
    if (verdict.kind === "killed") {
      report.stale.push({ key: mutant.key, reason: "killed" });
    } else if (verdict.kind === "timedOut") {
      report.timedOut.push(item(mutant));
    }
  } else if (verdict.kind === "survived") {
    report.survived.push(item(mutant));
  } else if (verdict.kind === "timedOut") {
    report.timedOut.push(item(mutant));
  }
}
function summarize(results, match, notGenerated) {
  const report = { survived: [], timedOut: [], errors: [], stale: [] };
  for (const result of results) {
    place(report, match, result);
  }
  report.stale.push(...notGenerated.map((key) => ({ key, reason: "not-generated" })));
  return report;
}
async function mutation(root, config, run, request) {
  const equivalents = readEquivalents(root);
  const path = repoFile(root, request.module, "対象のモジュール");
  const { parser, all, quality } = await prepare({ root, config, run });
  const ctx = { root, config, run, all };
  const tests = request.tests === undefined ? undefined : givenTests(root, all, request.tests);
  const match = matcher(root, path, equivalents);
  assert14(quality.length > 0, "候補0件: qualityがありません");
  return guardMutation(root, path, async (target) => {
    const found = mutants(parser, path, target.source);
    console.error(`壊し方: ${found.length}件（${path}）`);
    const notGenerated = match.notGenerated(found);
    if (found.length === 0) {
      return summarize([], match, notGenerated);
    }
    await runPrepare(ctx, target);
    let results = await runEach(ctx, target, found, tests ?? quality, tests === undefined ? "全quality" : "渡したテスト");
    const survivors = results.filter(({ mutant, verdict }) => verdict.kind === "survived" && match.recordOf(mutant) !== "equivalent");
    const recheckTests = tests === undefined ? [] : quality.filter((file) => !tests.includes(file));
    if (recheckTests.length > 0 && survivors.length > 0) {
      const rechecked = await runEach(ctx, target, survivors.map(({ mutant }) => mutant), recheckTests, "渡したテストを除いたquality", { allowNoTests: true });
      const byKey = new Map(rechecked.map((result) => [result.mutant.key, result]));
      results = results.map((result) => byKey.get(result.mutant.key) ?? result);
    }
    return summarize(results, match, notGenerated);
  });
}
async function mutationByKey(root, config, run, request) {
  const equivalents = readEquivalents(root);
  const module = keyModule(request.key);
  assert14(module !== undefined, `${keyShape}: ${request.key}`);
  const path = repoFile(root, module, "鍵のパス");
  assert14(path === module, `${keyShape}。鍵のパスは${path}を指します: ${request.key}`);
  const { parser, all } = await prepare({ root, config, run });
  const ctx = { root, config, run, all };
  const tests = givenTests(root, all, request.tests);
  const match = matcher(root, path, equivalents);
  const removal = equivalents.some(({ key }) => key === request.key) ? `。この鍵は${mutantsRecordFile}に記録されています。記録から外してください` : "";
  return guardMutation(root, path, async (target) => {
    const mutant = mutants(parser, path, target.source).find(({ key }) => key === request.key);
    assert14(mutant !== undefined, `鍵に当たる壊し方が今の${path}から作られません: ${request.key}。壊し方を当てずに止めます${removal}`);
    await runPrepare(ctx, target);
    const [result] = await runEach(ctx, target, [mutant], tests, "渡したテスト");
    assert14(result !== undefined);
    const { verdict } = result;
    const report = verdict.kind === "error" ? { ...item(mutant), verdict: "error", reason: verdict.reason } : { ...item(mutant), verdict: verdict.kind };
    return { report, record: match.recordOf(mutant) };
  });
}
function disallowedChange(config, { status, path }) {
  if (path.startsWith("../")) {
    return `${path}（package.jsonのディレクトリの外の変更）`;
  }
  if (path.startsWith(".github/")) {
    return `${path}（.github/の下の変更）`;
  }
  if (status === "A") {
    return;
  }
  if (status === "D") {
    return `${path}（比較元にあるファイルの削除）`;
  }
  const editable = status === "M" && (path === mutantsRecordFile || isTestFile(path, config));
  return editable ? undefined : `${path}（テストのファイルと${mutantsRecordFile}の外の変更）`;
}
async function changesOutsideImprovement(root, config) {
  const changes = await statusChangesFrom(root, comparisonBase(root, config));
  return changes.flatMap((change) => {
    const reason = disallowedChange(config, change);
    return reason === undefined ? [] : [reason];
  });
}

// src/runtime.ts
function packageScripts(root) {
  try {
    const pkg = JSON.parse(readFileSync6(join13(root, "package.json"), "utf8"));
    return isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : {};
  } catch {
    return {};
  }
}
function isConnected(operation) {
  return operation === "affected" || operation === "classification";
}
function callsOperation(script, operation) {
  return typeof script === "string" && script.split(runtimePath).slice(1).some((rest) => new RegExp(`^["']?\\s+${operation}(\\s|$)`).test(rest));
}
function retryScript(root, operation) {
  const connected = `check:${operation}`;
  const scripts = packageScripts(root);
  if (typeof scripts[connected] === "string") {
    return connected;
  }
  const candidates = [
    process.env.npm_lifecycle_event ?? "",
    `test:${operation}`,
    ...Object.keys(scripts)
  ];
  return candidates.find((name) => callsOperation(scripts[name], operation)) ?? connected;
}
var argumentSeparator = { bun: "", npm: " --", pnpm: "" };
function retryCommand(root, operation, options) {
  if (isConnected(operation)) {
    const suffix = options.length === 0 ? "" : `${argumentSeparator["bun"]} ${options.map(shellQuote).join(" ")}`;
    return `${"bun"} run ${retryScript(root, operation)}${suffix}`;
  }
  if (operation === "mutation") {
    return [basename(process.execPath), ...process.argv.slice(1)].map(shellQuote).join(" ");
  }
  const name = process.env.npm_lifecycle_event ?? "";
  return callsOperation(packageScripts(root)[name], operation) ? `${"bun"} run ${name}` : [basename(process.execPath), ...process.argv.slice(1)].map(shellQuote).join(" ");
}
function showBase(base, always = false) {
  if (base.runtime !== undefined || always) {
    console.log(`比較元: ${base.ref}（${base.runtime ?? base.subject}）`);
  }
}
function baseOverride(args) {
  const index = args.findLastIndex((arg) => arg === "--base" || arg.startsWith("--base="));
  if (index === -1) {
    assert15(!(argumentSeparator["bun"] !== "" && process.env.npm_config_base === "true" && args.length > 0), `npmが--baseを自分の設定として読み、参照だけを渡しました（${args.join(" ")}）。check:affectedを呼ぶscriptを「npm run <script> -- --base <参照>」の形で直接呼んでください`);
    return;
  }
  const option = args[index] ?? "";
  const base = option === "--base" ? args[index + 1] : option.slice("--base=".length);
  assert15(base, `--baseには参照を指定してください: ${args.join(" ")}`);
  return base;
}
function jsonRequested(args) {
  const options = args.filter((arg) => arg !== "--");
  assert15(options.every((option) => option === "--json"), `classificationの指定は--jsonだけです: ${args.join(" ")}`);
  return options.length > 0;
}
function changedOptions(options) {
  let values;
  try {
    values = parseArgs({
      args: options,
      options: { ext: { type: "string", multiple: true }, base: { type: "string" } }
    }).values;
  } catch {
    const valueless = options.some((option, index) => option === "--base" && (options[index + 1] ?? "-").startsWith("-"));
    assert15(!valueless, `--baseには参照を指定してください: ${options.join(" ")}`);
    assert15.fail(`changedの指定は--ext <拡張子>と--base <参照>だけです: ${options.join(" ")}`);
  }
  assert15(values.base !== "", `--baseには参照を指定してください: ${options.join(" ")}`);
  return { extensions: extensionsFrom(values.ext), base: values.base };
}
function extensionsFrom(values) {
  if (values === undefined) {
    return;
  }
  const extensions = values.flatMap((value) => value.split(",")).map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  assert15(extensions.every((extension) => /^\.[\w.-]+$/.test(extension)), `--extには拡張子をカンマ区切りで指定してください: ${values.join(" ")}`);
  return extensions;
}
var shownFiles = 20;
var batchBytes = 1e5;
function batches(files) {
  const result = [];
  let size = 0;
  for (const file of files) {
    const length = Buffer.byteLength(file) + 1;
    const current = result.at(-1);
    if (current === undefined || size + length > batchBytes) {
      result.push([file]);
      size = length;
    } else {
      current.push(file);
      size += length;
    }
  }
  return result;
}
function changedRequest(args) {
  const separator = args.indexOf("--");
  assert15(separator !== -1 && separator < args.length - 1, "changedは「changed [--ext <拡張子>] [--base <参照>] -- <コマンド>」の形で呼びます");
  return { ...changedOptions(args.slice(0, separator)), command: args.slice(separator + 1) };
}
async function runOnChanged(root, config, run, { extensions, command }, specified) {
  const comparison = comparisonBase(root, config, specified);
  const files = (await existingChanges(root, comparison)).filter((path) => (extensions === undefined || extensions.some((extension) => path.endsWith(extension))) && isFile(join13(root, path))).sort().map((path) => path.startsWith("-") ? `./${path}` : path);
  showBase(comparison, files.length === 0);
  if (files.length === 0) {
    console.log(`変更したファイルがありません。コマンドを実行しません: ${command.join(" ")}`);
    return;
  }
  for (const batch of batches(files)) {
    const shown = batch.slice(0, shownFiles);
    const rest = batch.length - shown.length;
    await run([...command, ...batch], {
      display: [...command, ...shown, ...rest > 0 ? [`…ほか${rest}件`] : []]
    });
  }
}
async function affected(root, config, run, specified) {
  const base = comparisonBase(root, config, specified);
  const [collected, compared] = await Promise.allSettled([
    classification(root, config, run),
    affectedChanges(root, base, "bun")
  ]);
  if (collected.status === "rejected") {
    throw collected.reason;
  }
  if (compared.status === "rejected") {
    throw compared.reason;
  }
  const classes = collected.value;
  const { changed, outside } = compared.value;
  showBase(base);
  console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
  assert15(changed.length > 0 || config.runner === "vitest" && outside.length > 0, "変更なし: テストを実行しません");
  if (changed.includes(mutantsRecordFile)) {
    readEquivalents(root);
  }
  assert15(classes.quality.length > 0, "候補0件: qualityがありません");
  if (config.prepare.length > 0) {
    await run(config.prepare);
  }
  const assurance = changed.filter((path) => isAssurance(path, config));
  if (assurance.length > 0) {
    console.log(`assuranceのテストファイルは、このコマンドの実行対象に選びません。全体checkとCIで実行します: ${assurance.join(", ")}`);
  }
  const ctx = { root, config, quality: classes.quality, changes: compared.value, run };
  const outcome = await (config.runner === "bun" ? runBunTests : runVitestTests)(ctx);
  assert15(outcome.kind !== "none", "変更なし: テストを実行しません");
  if (outcome.kind === "ran") {
    console.log("選択したqualityが成功しました。全体checkの成功ではありません");
    return;
  }
  const subjects = [
    ...outcome.ignored.length > 0 ? ["ignoredChangesに当たる変更"] : [],
    ...outcome.mutantsRecord.length > 0 ? ["壊し方の記録ファイルの変更"] : [],
    ...outcome.assurance.length > 0 ? ["assuranceのテストファイルの変更"] : [],
    ...outcome.assuranceReach.length > 0 ? ["assuranceのテストにしか届かない変更"] : []
  ];
  console.log(`変更なし: ${subjects.join("と")}だけのため、テストを実行していません`);
}
function mutationRequest(args) {
  const usage = `mutationは「mutation <モジュール> [--tests <テストファイル>...]」か「mutation --key <鍵> --tests <テストファイル>...」か「mutation --check-changes」の形で呼びます: ${args.join(" ")}`;
  const given = args.filter((arg) => arg !== "--");
  if (given.includes("--check-changes")) {
    assert15(given.length === 1, usage);
    return "check-changes";
  }
  const byKey = given[0] === "--key";
  const [subject, ...options] = byKey ? given.slice(1) : given;
  assert15(subject !== undefined && (byKey ? subject !== "--tests" : !subject.startsWith("-")), usage);
  if (options.length === 0) {
    assert15(!byKey, `--keyで確かめるときは、--testsにテストファイルを渡してください: ${args.join(" ")}`);
    return { module: subject, tests: undefined };
  }
  const [flag, ...tests] = options;
  assert15(flag === "--tests" && tests.length > 0 && tests.every((test) => !test.startsWith("-")), usage);
  return byKey ? { key: subject, tests } : { module: subject, tests };
}
function reportList(report) {
  console.log(JSON.stringify(report, null, 2));
  if (report.stale.length > 0) {
    console.error(`記録した壊し方のうち${report.stale.length}件を、${mutantsRecordFile}から外してください（理由は一覧のstaleにあります）: ${report.stale.map(({ key }) => key).join(" ")}`);
  }
  assert15(report.errors.length === 0, `エラーで終わった壊し方が${report.errors.length}件あります。errorsのreasonを確かめてください`);
  if (report.survived.length === 0) {
    console.error(`改善するものがありません: 既存のテストをすり抜けた壊し方はありません（時間切れ${report.timedOut.length}件）`);
  }
}
function reportKey({ report, record }) {
  console.log(JSON.stringify(report, null, 2));
  if (record === "changed") {
    console.error(`この鍵の${mutantsRecordFile}の記録は、置き換える前の字が今の壊し方と違い、別の式を指します。記録から外してください: ${report.key}`);
  } else if (record === "equivalent" && report.verdict === "killed") {
    console.error(`この鍵は${mutantsRecordFile}に記録されていますが、渡したテストが拾いました。記録から外してください: ${report.key}`);
  }
  assert15(report.verdict !== "survived", `渡したテストは、この壊し方を拾いません（survived）: ${report.key}`);
  if (report.verdict === "error") {
    assert15.fail(`壊し方がエラーで終わりました: ${report.reason}`);
  }
}
function reportOutside(outside) {
  assert15(outside.length === 0, `改善の処理が変えてよいファイルの外の変更があります: ${outside.join(", ")}`);
  console.error("改善の処理が変えてよいファイルの外の変更はありません");
}
function runnerFor(root, operation, options, specified) {
  const assignment = specified?.from === "environment" ? `${baseVariable}=${shellQuote(specified.ref)} ` : "";
  return commandRunner(fileURLToPath2(import.meta.url), assignment + retryCommand(root, operation, options));
}
var operations = {
  async classification(root, args) {
    const json = jsonRequested(args);
    const run = runnerFor(root, "classification", json ? ["--json"] : []);
    readEquivalents(root);
    const classes = await classification(root, readConfig(root), run);
    console.log(json ? JSON.stringify(classes, null, 2) : `分類: all ${classes.all.length}件、quality ${classes.quality.length}件、assurance ${classes.assurance.length}件（パスの一覧: ${retryCommand(root, "classification", ["--json"])}）`);
  },
  async affected(root, args) {
    const specified = runtimeBase(baseOverride(args));
    const options = specified?.from === "option" ? ["--base", specified.ref] : [];
    const run = runnerFor(root, "affected", options, specified);
    await affected(root, readConfig(root), run, specified);
  },
  async changed(root, args) {
    const request = changedRequest(args);
    const specified = runtimeBase(request.base);
    const run = runnerFor(root, "changed", [], specified);
    await runOnChanged(root, readConfig(root), run, request, specified);
  },
  async mutation(root, args) {
    const request = mutationRequest(args);
    if (request === "check-changes") {
      reportOutside(await changesOutsideImprovement(root, readConfig(root)));
      return;
    }
    const run = runnerFor(root, "mutation", []);
    if ("key" in request) {
      reportKey(await mutationByKey(root, readConfig(root), run, request));
    } else {
      reportList(await mutation(root, readConfig(root), run, request));
    }
  }
};
function isOperation(name) {
  return name !== undefined && Object.hasOwn(operations, name);
}
try {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "execute-child") {
    await runMonitor();
  } else {
    assert15(isOperation(operation), "操作はclassification・affected・changed・mutationのいずれかです");
    await operations[operation](process.cwd(), args);
  }
} catch (error) {
  if (!(error instanceof ReportedFailure)) {
    console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  }
  process.exitCode = process.argv[2] === "execute-child" ? reportedExitCode : 1;
}
