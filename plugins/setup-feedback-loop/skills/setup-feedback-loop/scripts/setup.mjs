// 生成元: thkt/feedback-loop scripts/build.ts。直接編集せず、正本を変更して再生成してください
// バージョン: 0.4.6
// @bun
// src/setup.ts
import assert7 from "assert/strict";
import { spawnSync as spawnSync3 } from "child_process";
import {
  existsSync as existsSync5,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync as readFileSync4,
  realpathSync as realpathSync3,
  writeFileSync
} from "fs";
import { tmpdir } from "os";
import { dirname as dirname2, isAbsolute as isAbsolute3, join as join6 } from "path";

// src/classification.ts
import assert3 from "assert/strict";
import { lstatSync, readdirSync, statSync as statSync2 } from "fs";
import { join as join3 } from "path";

// src/config.ts
import assert2 from "assert/strict";
import { existsSync as existsSync2, readFileSync, realpathSync, statSync } from "fs";
import { isAbsolute as isAbsolute2, join as join2, relative as relative2, resolve as resolve2, sep as sep2 } from "path";

// src/values.ts
import assert from "assert/strict";
import { isAbsolute } from "path";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertObject(value) {
  assert(isRecord(value), "\u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u304C\u5FC5\u8981\u3067\u3059");
}
function assertStringArray(value, name) {
  assert(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0), `${name}\u306F\u7A7A\u3067\u306A\u3044\u6587\u5B57\u5217\u306E\u914D\u5217\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044`);
}
function isRepoRelativePath(path) {
  return !isAbsolute(path) && !path.split("/").includes("..") && !path.startsWith("./") && !path.includes("\\");
}
function assertRepoRelativePath(path) {
  assert(isRepoRelativePath(path), `repo\u76F8\u5BFE\u30D1\u30B9\u304C\u5FC5\u8981\u3067\u3059: ${path}`);
}
function stringRecord(value) {
  assertObject(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    assert(typeof item === "string", `${key}\u306F\u6587\u5B57\u5217\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044`);
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
function parseVersion(text) {
  return /^(\d+)\.(\d+)\.(\d+)/.exec(text ?? "")?.slice(1).map(Number);
}
function versionAtLeast(version, minimum) {
  const [actual, required] = [parseVersion(version), parseVersion(minimum)];
  if (!actual || !required) {
    return false;
  }
  for (const [index, part] of required.entries()) {
    const found = actual[index] ?? 0;
    if (found !== part) {
      return found > part;
    }
  }
  return true;
}

// src/installed.ts
var packageManagers = ["bun", "npm", "pnpm"];
var installedDirectory = "scripts/feedback-loop";
var runtimePath = `${installedDirectory}/runtime.mjs`;
var recorderPath = `${installedDirectory}/record-modules.ts`;
var improveTestsPath = `${installedDirectory}/improve-tests.md`;
var mutationPreloadPath = `${installedDirectory}/mutation-preload.ts`;
var packageManagerToken = "__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__";
function generatedVersion(body) {
  return /^\/\/ \u30D0\u30FC\u30B8\u30E7\u30F3: (\d+\.\d+\.\d+)\s*$/.exec(body.split(`
`, 2)[1] ?? "")?.[1];
}
function installedFiles(readSkillFile, packageManager, runner, mutation) {
  const files = new Map([
    [
      runtimePath,
      readSkillFile("scripts/runtime.mjs").replaceAll(packageManagerToken, packageManager)
    ]
  ]);
  if (runner === "bun") {
    files.set(recorderPath, readSkillFile("scripts/record-modules.ts"));
  }
  if (mutation) {
    files.set(mutationPreloadPath, readSkillFile("scripts/mutation-preload.ts"));
    files.set(improveTestsPath, readSkillFile("references/improve-tests.md"));
  }
  return files;
}

// src/lockfiles.ts
import { existsSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
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

// src/config.ts
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
  const value = JSON.parse(readFileSync(join2(root, ".feedback-loop.json"), "utf8"));
  assertObject(value);
  const unknownKeys = Object.keys(value).filter((key) => !Object.hasOwn(configKeys, key));
  assert2(unknownKeys.length === 0, `.feedback-loop.json\u306E\u672A\u77E5\u306E\u30AD\u30FC\u3067\u3059: ${unknownKeys.join(", ")}`);
  assert2(value.runner === "bun" || value.runner === "vitest", "runner\u306Fbun\u307E\u305F\u306Fvitest\u3067\u3059");
  if (value.base !== undefined) {
    assert2(typeof value.base === "string" && value.base.trim().length > 0, "\u6BD4\u8F03\u5143base\u304C\u5FC5\u8981\u3067\u3059");
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
    mutation = value.runner === "bun",
    assurance: assuranceValue = [],
    dependencies: dependenciesValue = []
  } = value;
  if (collect !== undefined || value.runner === "vitest") {
    assertStringArray(collect, "collect");
    assert2(collect.length > 0, "\u53CE\u96C6\u30B3\u30DE\u30F3\u30C9\u306F\u7A7A\u306B\u3067\u304D\u307E\u305B\u3093");
  }
  assertStringArray(testGlobs, "testGlobs");
  assertStringArray(prepare, "prepare");
  assertStringArray(testArgs, "testArgs");
  assertStringArray(globalChanges, "globalChanges");
  assertStringArray(ignoredChanges, "ignoredChanges");
  assert2(testGlobs.length > 0, "\u30C6\u30B9\u30C8glob\u306F\u5FC5\u9808\u3067\u3059");
  assert2(typeof allowSkipped === "boolean", "allowSkipped\u306Fboolean\u3067\u3059");
  assert2(typeof mutation === "boolean", "mutation\u306Fboolean\u3067\u3059");
  assertStringArray(bunArgs, "bunArgs");
  assert2(value.runner === "bun" || bunArgs.length === 0, "Vitest\u306B\u306FbunArgs\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
  assert2(typeof bunWorkers === "number" && Number.isSafeInteger(bunWorkers) && bunWorkers > 0, "bunWorkers\u306F\u6B63\u306E\u5B89\u5168\u306A\u6574\u6570\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  assert2(value.runner === "bun" || value.bunWorkers === undefined, "Vitest\u306B\u306FbunWorkers\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
  if (value.runner === "bun") {
    assert2(![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)), "\u30C6\u30B9\u30C8\u30D5\u30A1\u30A4\u30EB\u3054\u3068\u306E\u5206\u96E2\u306F\u56FA\u5B9A\u3067\u3059\u3002\u4E26\u5217\u6570\u306FbunWorkers\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  }
  assert2(Array.isArray(assuranceValue), "assurance\u914D\u5217\u304C\u5FC5\u8981\u3067\u3059");
  const assurance = assuranceValue.map((item) => {
    assertObject(item);
    assert2(typeof item.path === "string" && typeof item.reason === "string" && item.reason.trim().length > 0, "assurance\u306B\u306Fpath\u3068\u6307\u5B9A\u7406\u7531\u304C\u5FC5\u8981\u3067\u3059");
    assertRepoRelativePath(item.path);
    return { path: item.path, reason: item.reason };
  });
  assert2(Array.isArray(dependenciesValue), "dependencies\u914D\u5217\u304C\u5FC5\u8981\u3067\u3059");
  const dependencies = dependenciesValue.map((item) => {
    assertObject(item);
    assertStringArray(item.inputs, "dependencies\u306Einputs");
    assertStringArray(item.tests, "dependencies\u306Etests");
    assert2(item.inputs.length > 0 && item.tests.length > 0, "\u4F9D\u5B58\u5BFE\u5FDC\u306F\u7A7A\u306B\u3067\u304D\u307E\u305B\u3093");
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
function repoPath(root, path) {
  const absolute = resolve2(root, path);
  const canonical = existsSync2(absolute) ? realpathSync(absolute) : absolute;
  const local = relative2(root, canonical);
  return local !== ".." && !local.startsWith(`..${sep2}`) && !isAbsolute2(local) ? local.split(sep2).join("/") : absolute;
}

// src/classification.ts
function filesUnder(root, prefix, excludeHidden) {
  return readdirSync(join3(root, prefix), { withFileTypes: true }).flatMap((entry) => {
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
    if (!entryExists(join3(root, path))) {
      missing.push(path);
    } else if (isTestFile(path, config)) {
      unlisted.push(path);
    } else {
      unmatched.push(path);
    }
  }
  const sides = [
    { label: "\u53CE\u96C6\u306B\u3042\u3063\u3066\u5B9F\u5728\u3057\u306A\u3044", paths: missing },
    {
      label: "\u53CE\u96C6\u306B\u3042\u3063\u3066testGlobs\u306B\u5F53\u305F\u3089\u306A\u3044",
      paths: unmatched,
      guidance: "\u76F4\u3057\u65B9: \u4E0A\u306E\u30D1\u30B9\u304C\u30C6\u30B9\u30C8\u306A\u3089\u3001.feedback-loop.json\u306EtestGlobs\u3078\u3001\u305D\u306E\u30D1\u30B9\u306B\u5F53\u305F\u308Bglob\u3092\u8DB3\u3057\u3066\u304F\u3060\u3055\u3044\u3002glob\u306B\u5F53\u305F\u308B\u30C6\u30B9\u30C8\u306F\u3001\u540C\u3058\u30D5\u30A1\u30A4\u30EB\u306Eassurance\u3078\u767B\u9332\u3057\u306A\u3051\u308C\u3070quality\u306B\u306A\u308A\u307E\u3059\u3002" + (config.collect === undefined ? "\u30C6\u30B9\u30C8\u3067\u306A\u3051\u308C\u3070\u3001\u62E1\u5F35\u5B50\u306E\u524D\u304C.test\u30FB_test\u30FB.spec\u30FB_spec\u306B\u306A\u3089\u306A\u3044\u540D\u524D\u3078\u5909\u3048\u3066\u304F\u3060\u3055\u3044" : "\u30C6\u30B9\u30C8\u3067\u306A\u3051\u308C\u3070\u3001\u53CE\u96C6\u7528\u30B3\u30DE\u30F3\u30C9\u306E\u51FA\u529B\u304B\u3089\u5916\u3057\u3066\u304F\u3060\u3055\u3044")
    },
    {
      label: "\u53CE\u96C6\u306B\u3042\u3063\u3066testGlobs\u306B\u5F53\u305F\u308B\u304C\u3001\u63A2\u7D22\u3067\u898B\u3064\u304B\u3089\u306A\u3044\uFF08\u30B7\u30F3\u30DC\u30EA\u30C3\u30AF\u30EA\u30F3\u30AF\u3001\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u3001node_modules\u30FB.git\u306E\u4E0B\u3001\u8868\u8A18\u306E\u9055\u3044\u306A\u3069\uFF09",
      paths: unlisted
    },
    {
      label: "testGlobs\u306B\u5F53\u305F\u3063\u3066\u53CE\u96C6\u306B\u306A\u3044",
      paths: globbed.filter((path) => !inCollected.has(path))
    }
  ];
  return [
    "\u901A\u5E38\u53CE\u96C6\u3068testGlobs\u306E\u96C6\u5408\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093",
    ...sides.filter(({ paths }) => paths.length > 0).flatMap(({ label, paths, guidance }) => {
      const line = `${label}: ${JSON.stringify(paths.sort())}`;
      return guidance === undefined ? [line] : [line, guidance];
    })
  ].join(`
`);
}
var shownOutput = 200;
function outputEnds(stdout) {
  const head = `\u6A19\u6E96\u51FA\u529B\u306E\u5148\u982D: ${JSON.stringify(stdout.slice(0, shownOutput))}`;
  return stdout.length > shownOutput ? `${head}\u3002\u6A19\u6E96\u51FA\u529B\u306E\u672B\u5C3E: ${JSON.stringify(stdout.slice(-shownOutput))}` : head;
}
function parseCollected(stdout) {
  let collected;
  try {
    collected = JSON.parse(stdout);
  } catch (error) {
    const reason = errorMessage(error).replaceAll(/\p{Cc}+/gu, " ").slice(0, shownOutput);
    assert3.fail(`\u53CE\u96C6\u7528\u30B3\u30DE\u30F3\u30C9\u306E\u6A19\u6E96\u51FA\u529B\u3092JSON\u3068\u3057\u3066\u8AAD\u3081\u307E\u305B\u3093\u3002\u6A19\u6E96\u51FA\u529B\u306B\u306FJSON\u306E\u6587\u5B57\u5217\u914D\u5217\u3060\u3051\u3092\u51FA\u3057\u3001\u8A3A\u65AD\u306F\u6A19\u6E96\u30A8\u30E9\u30FC\u3078\u51FA\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u7406\u7531: ${reason}\u3002${outputEnds(stdout)}`);
  }
  try {
    assertStringArray(collected, "\u53CE\u96C6\u7528\u30B3\u30DE\u30F3\u30C9\u306E\u6A19\u6E96\u51FA\u529B");
  } catch {
    assert3.fail(`\u53CE\u96C6\u7528\u30B3\u30DE\u30F3\u30C9\u306E\u6A19\u6E96\u51FA\u529B\u306FJSON\u3067\u3059\u304C\u3001\u7A7A\u3067\u306A\u3044\u6587\u5B57\u5217\u3060\u3051\u306E\u914D\u5217\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002${outputEnds(stdout)}`);
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
  assert3(new Set(collected).size === collected.length, "\u53CE\u96C6\u7D50\u679C\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059");
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
    const found = statSync2(join3(root, prefix), { throwIfNoEntry: false })?.isDirectory() ?? false;
    assert3(found || collection.kind === "command", `testGlobs\u306E\u63A2\u7D22\u5834\u6240\u304C\u3042\u308A\u307E\u305B\u3093: ${prefix}`);
    return found;
  }).flatMap((prefix) => filesUnder(root, prefix, collection.kind === "builtin"));
  const expected = files.filter((path) => isTestFile(path, config)).sort();
  const actual = collection.kind === "builtin" ? builtinTests(files) : await collectedTests(root, collection.command, run);
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected)) {
    assert3.fail(mismatchDiagnostic(root, config, actual, expected));
  }
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert3(assurance.size === config.assurance.length, "assurance\u6307\u5B9A\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059");
  assert3([...assurance].every((path) => expected.includes(path)), "assurance\u306B\u5B58\u5728\u3057\u306A\u3044\u30C6\u30B9\u30C8\u304B\u96C6\u5408\u5916\u306E\u6307\u5B9A\u304C\u3042\u308A\u307E\u3059");
  assert3(config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))), "\u4F9D\u5B58\u5BFE\u5FDC\u306B\u96C6\u5408\u5916\u306E\u30C6\u30B9\u30C8\u304C\u3042\u308A\u307E\u3059");
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance]
  };
}

// src/agents.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "fs";
import { join as join5, relative as relative4 } from "path";

// src/inspect.ts
import assert4 from "assert/strict";
import { existsSync as existsSync3, readFileSync as readFileSync2, readdirSync as readdirSync2, realpathSync as realpathSync2 } from "fs";
import { join as join4, relative as relative3 } from "path";

// src/git.ts
import { execFile, spawnSync } from "child_process";
function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
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
    return commit ? { base: remoteHead, commit } : { base: null, reason: `origin/HEAD\u306E\u6307\u3059\u5148\u306E${remoteHead}\u304C\u3042\u308A\u307E\u305B\u3093` };
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
      return { base: null, reason: `${label}main\u3068${label}master\u306E\u4E21\u65B9\u304C\u3042\u308A\u307E\u3059` };
    }
  }
  return { base: null, reason: "origin/HEAD\u304C\u306A\u304F\u3001main\u3082master\u3082\u3042\u308A\u307E\u305B\u3093" };
}

// src/inspect.ts
function gitRoot(root) {
  const top = gitOutput(root, ["rev-parse", "--show-toplevel"]);
  assert4(top !== undefined, "--repo\u306FGit checkout\u306E\u4E2D\u306E\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  return realpathSync2(top);
}
function hintsOf(declared, lockfiles, source) {
  const names = lockfiles.map(({ manager }) => manager);
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (!name) {
      return {
        reason: `${source}\u306EpackageManager\u306E\u5024\u300C${declared}\u300D\u304B\u3089package manager\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093`
      };
    }
    names.unshift(name);
  }
  return { names: [...new Set(names)] };
}
function declaredIn(directory, source) {
  const path = join4(directory, "package.json");
  if (!existsSync3(path)) {
    return;
  }
  try {
    const pkg = JSON.parse(readFileSync2(path, "utf8"));
    assertObject(pkg);
    return pkg.packageManager;
  } catch (error) {
    return assert4.fail(`${source}\u3092\u8AAD\u3081\u307E\u305B\u3093: ${errorMessage(error)}`);
  }
}
function hintSource(root, top, declared) {
  const local = hintsOf(declared, lockfilesIn(root), "package.json");
  const ancestor = "names" in local && local.names.length === 0 ? ancestorLockfiles(root, top) : undefined;
  if (ancestor === undefined) {
    return { hints: local, where: "" };
  }
  const source = fromRoot(root, join4(ancestor.directory, "package.json"));
  const declaredAbove = declaredIn(ancestor.directory, source);
  return {
    hints: hintsOf(declaredAbove, ancestor.lockfiles, source),
    where: `\uFF08${fromRoot(root, ancestor.directory)}\u3067\u5224\u5B9A\uFF09`,
    inherited: {
      lockfiles: ancestor.lockfiles.map(({ name }) => fromRoot(root, join4(ancestor.directory, name))),
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
      reason: "package manager\u3092\u5224\u5B9A\u3067\u304D\u307E\u305B\u3093\u3002package.json\u306EpackageManager\u304Blockfile\u304C\u5FC5\u8981\u3067\u3059"
    };
  }
  if (others.length > 0) {
    return {
      packageManager: null,
      reason: `package manager\u306E\u6307\u5B9A\u304C\u7AF6\u5408\u3057\u3066\u3044\u307E\u3059: ${hints.names.join(", ")}${where}`
    };
  }
  const packageManager = packageManagers.find((manager) => manager === hint);
  return packageManager === undefined ? {
    packageManager: null,
    reason: `${hint}\u306B\u306F\u5BFE\u5FDC\u3057\u3066\u3044\u307E\u305B\u3093\u3002\u5BFE\u5FDC\u3059\u308B\u306E\u306F${packageManagers.join("\u30FB")}\u3067\u3059${where}`
  } : { packageManager, inherited };
}
function inspect(root) {
  const pkg = JSON.parse(readFileSync2(join4(root, "package.json"), "utf8"));
  assertObject(pkg);
  const scripts = stringRecord(pkg.scripts ?? {});
  const devDependencies = stringRecord(pkg.devDependencies ?? {});
  const dependencies = stringRecord(pkg.dependencies ?? {});
  const top = gitRoot(root);
  const manager = detectPackageManager(root, top, pkg.packageManager);
  const inherited = manager.packageManager === null ? undefined : manager.inherited;
  const configFiles = [...new Set([root, top])].flatMap((directory) => readdirSync2(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && /(?:config|lock|mise|bunfig|feedback-loop|eslint|prettier|biome|oxlint|oxfmt|fallow)/.test(entry.name)).map((entry) => relative3(root, join4(directory, entry.name))));
  const workflow = join4(top, ".github/workflows");
  if (existsSync3(workflow)) {
    configFiles.push(...readdirSync2(workflow).map((name) => relative3(root, join4(workflow, name))));
  }
  const comparison = defaultBase(root);
  return {
    packageManager: manager.packageManager,
    packageManagerFrom: inherited?.lockfiles ?? null,
    base: comparison.base,
    scripts,
    devDependencies,
    dependencies,
    configFiles: [...new Set([...configFiles, ...inherited?.lockfiles ?? []])].sort(),
    runtime: pkg.engines ?? pkg.packageManager ?? inherited?.declared ?? null,
    tools: Object.keys({ ...dependencies, ...devDependencies }).filter((name) => /eslint|prettier|biome|oxlint|oxfmt|fallow|typescript|vitest/.test(name)),
    diagnostics: [
      ...manager.packageManager === null ? [manager.reason] : [],
      ...comparison.base === null ? [`\u6BD4\u8F03\u5143\u3092\u6C7A\u3081\u3089\u308C\u307E\u305B\u3093\u3002${comparison.reason}`] : []
    ],
    pkg,
    manager
  };
}
function inspectManaged(root) {
  const inspected = inspect(root);
  const { manager } = inspected;
  if (manager.packageManager === null) {
    assert4.fail(`package manager\u3092\u9078\u629E\u3067\u304D\u307E\u305B\u3093: ${manager.reason}`);
  }
  return { ...inspected, packageManager: manager.packageManager };
}

// src/agents.ts
function agentSection(directory, packageManager, checkCommand) {
  const enter = directory ? `cd ${shellQuote(directory)} && ` : "";
  const subject = directory ? `\`${directory}/\`\u306E\u30B3\u30FC\u30C9\u3084\u30C6\u30B9\u30C8` : "\u30B3\u30FC\u30C9\u3084\u30C6\u30B9\u30C8";
  const check = checkCommand ?? `${enter}${packageManager} run check`;
  return `## \u5909\u66F4\u5F8C\u306E\u78BA\u8A8D

${subject}\u3092\u5909\u66F4\u3057\u305F\u3089\u3001\u4F5C\u696D\u3092\u7D42\u3048\u308B\u524D\u306B\`${enter}${packageManager} run check:feedback\`\u3092\u5B9F\u884C\u3059\u308B\u3002\u5931\u6557\u3057\u305F\u3089\u8A3A\u65AD\u3092\u8AAD\u3093\u3067\u76F4\u3057\u3001\u6210\u529F\u3059\u308B\u307E\u3067\u518D\u5B9F\u884C\u3059\u308B\u3002assurance\u306E\u30C6\u30B9\u30C8\u3084\u3001\u5F71\u97FF\u3092\u5224\u65AD\u3067\u304D\u306A\u3044\u5909\u66F4\u3067\u306F\`${check}\`\u3082\u5B9F\u884C\u3059\u308B\u3002\`check:feedback\`\u306E\u6210\u529F\u3092\u5168\u4F53check\u306E\u6210\u529F\u3068\u3057\u3066\u5831\u544A\u3057\u306A\u3044\u3002
`;
}
function planAgentInstructions(root, packageManager, checkCommand) {
  const updates = new Map;
  const top = gitRoot(root);
  const placed = (name) => relative4(root, join5(top, name));
  const agentsPath = join5(top, "AGENTS.md");
  const agents = existsSync4(agentsPath) ? readFileSync3(agentsPath, "utf8") : "";
  if (/^## \u5909\u66F4\u5F8C\u306E\u78BA\u8A8D[ \t]*\r?$/m.test(agents)) {
    console.log("AGENTS.md\u306E\u300C## \u5909\u66F4\u5F8C\u306E\u78BA\u8A8D\u300D\u306F\u65E2\u5B58\u306E\u5185\u5BB9\u3092\u4FDD\u6301\u3057\u307E\u3059");
  } else {
    const prefix = agents ? `${agents}${agents.endsWith(`
`) ? `
` : `

`}` : "";
    updates.set(placed("AGENTS.md"), prefix + agentSection(relative4(top, root), packageManager, checkCommand));
  }
  const claudePath = join5(top, "CLAUDE.md");
  if (existsSync4(claudePath)) {
    const claude = readFileSync3(claudePath, "utf8");
    if (!/^@AGENTS\.md[ \t]*\r?$/m.test(claude)) {
      updates.set(placed("CLAUDE.md"), `@AGENTS.md
${claude}`);
    }
  } else if (existsSync4(join5(top, "CLAUDE.local.md"))) {
    console.log("CLAUDE.local.md\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002\u5229\u7528\u8005\u304C@AGENTS.md\u306E\u884C\u3092\u8FFD\u52A0\u3057\u3066\u304F\u3060\u3055\u3044");
  }
  return updates;
}

// src/bun-report.ts
import assert5 from "assert/strict";
function elements(node, name) {
  return node.children.filter((child) => typeof child !== "string" && ("name" in child) && child.name === name);
}
function readBunSuites(text, root) {
  const report = Bun.XML.parse(text, { compact: false });
  assert5(report.name === "testsuites", "Bun JUnit\u306Eroot\u304C\u3042\u308A\u307E\u305B\u3093");
  const suites = new Map;
  for (const suite of elements(report, "testsuite")) {
    const file = suite.attributes.file;
    assert5(file && file.trim(), "JUnit\u306E\u30C6\u30B9\u30C8\u30D5\u30A1\u30A4\u30EB\u304C\u3042\u308A\u307E\u305B\u3093");
    const owner = repoPath(root, file);
    assert5(!suites.has(owner), `JUnit\u306E\u30D5\u30A1\u30A4\u30EB\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059: ${file}`);
    suites.set(owner, suite);
  }
  return { report, suites };
}

// src/command.ts
import assert6 from "assert/strict";
import { spawn, spawnSync as spawnSync2 } from "child_process";
class ReportedFailure extends Error {
}
var reportedExitCode = 79;
var cancellationSignals = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP"
];

class CommandTimedOut extends Error {
}
var timedOutExitCode = 78;
var graceMs = 1000;
var maxTimerMs = 2 ** 31 - 1;
function assertTimeoutMs(timeoutMs) {
  assert6(timeoutMs === undefined || typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= maxTimerMs, `\u6642\u9593\u306E\u4E0A\u9650\u306F\u30010\u3088\u308A\u5927\u304D\u304F${maxTimerMs}\u30DF\u30EA\u79D2\u4EE5\u4E0B\u306E\u6709\u9650\u306E\u6570\u3067\u3059: ${String(timeoutMs)}`);
}
function commandRunner(runtime, retryCommand) {
  return async (argv, options = {}) => {
    assert6(argv[0], "\u5B9F\u884C\u30B3\u30DE\u30F3\u30C9\u304C\u3042\u308A\u307E\u305B\u3093");
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
    const operation = stdout === "capture" ? "\u53CE\u96C6" : "\u5B9F\u884C";
    log(`${operation}: ${display.join(" ")}; \u518D\u5B9F\u884C: ${retryCommand}`);
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
function exitedOnTimeout(exit, childReports) {
  return childReports && exit.code === timedOutExitCode && exit.signal === null;
}
function nextState(state, event, settings) {
  if (event.type === "started") {
    return { state: { phase: "running", exit: "none" }, effects: [] };
  }
  if (event.type === "close") {
    return closeState(state);
  }
  if (event.type === "exit") {
    return exitState(state, event, settings.childReports);
  }
  return cancelState(state, event, settings.killAfterMs);
}
function closeState(state) {
  return state.phase === "cancelling" ? {
    state: {
      phase: "finished",
      cancelled: true,
      timedOut: state.timedOut,
      signal: state.signal
    },
    effects: [{ type: "clearKill" }]
  } : {
    state: { phase: "finished", cancelled: false, timedOut: false, signal: undefined },
    effects: []
  };
}
function exitState(state, exit, childReports) {
  if (state.phase !== "running" || state.exit !== "none") {
    return { state, effects: [] };
  }
  const reason = exitedOnTimeout(exit, childReports) ? "timedOut" : "other";
  return { state: { phase: "running", exit: reason }, effects: [] };
}
function cancelState(state, event, killAfter) {
  if (state.phase === "cancelling") {
    return { state, effects: [{ type: "signal", signal: event.signal }] };
  }
  if (state.phase !== "running" || state.exit === "timedOut") {
    return { state, effects: [] };
  }
  const timedOut = event.notice !== undefined;
  const effects = [];
  if (event.notice !== undefined) {
    effects.push({ type: "notice", text: event.notice });
  }
  effects.push({ type: "signal", signal: event.signal });
  if (killAfter !== undefined) {
    effects.push({ type: "armKill", afterMs: killAfter });
  }
  return { state: { phase: "cancelling", timedOut, signal: event.signal }, effects };
}
function commandResult(result, failure, state, output, allowFailure, childReports, timeoutMs) {
  if ("error" in result) {
    throw result.error;
  }
  if (failure !== undefined) {
    assert6.fail(`\u5B50\u30D7\u30ED\u30BB\u30B9\u306E\u7D42\u4E86\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093: ${String(failure.error)}`);
  }
  const outcome = judgeResult(state, result, { allowFailure, childReports });
  if (outcome.kind === "timedOut") {
    throw new CommandTimedOut(`${timeoutMs}\u30DF\u30EA\u79D2\u306E\u4E0A\u9650\u3092\u904E\u304E\u305F\u305F\u3081\u6B62\u3081\u307E\u3057\u305F`);
  }
  if (outcome.kind === "reported") {
    throw new ReportedFailure("\u76E3\u8996\u30D7\u30ED\u30BB\u30B9\u304C\u8A3A\u65AD\u3092\u8868\u793A\u3057\u307E\u3057\u305F");
  }
  if (outcome.kind === "failed") {
    assert6.fail(outcome.message);
  }
  if (result.signal !== null) {
    console.error(`\u30B3\u30DE\u30F3\u30C9\u304C${result.signal}\u3067\u7D42\u308F\u308A\u307E\u3057\u305F`);
  }
  return output;
}
function judgeResult(state, exit, settings) {
  const finished = state.phase === "finished";
  const userCancelled = finished && state.cancelled && !state.timedOut;
  const timedOut = finished && state.timedOut || exitedOnTimeout(exit, settings.childReports);
  if (timedOut && !userCancelled) {
    return { kind: "timedOut" };
  }
  const failed = settings.allowFailure ? isCancellationSignal(exit.signal) : exit.code !== 0;
  if (userCancelled || failed) {
    return failedOutcome(exit, settings.childReports, userCancelled ? state.signal : undefined);
  }
  return { kind: "success" };
}
function isCancellationSignal(signal) {
  return cancellationSignals.some((cancellation) => cancellation === signal);
}
function failedOutcome(exit, childReports, cancelledBy) {
  if (childReports && exit.code === reportedExitCode) {
    return { kind: "reported" };
  }
  if (childReports && exit.code === timedOutExitCode) {
    return { kind: "failed", message: "\u53D6\u308A\u6D88\u3057\u307E\u3057\u305F\u3002\u6642\u9593\u306E\u4E0A\u9650\u3082\u904E\u304E\u3066\u3044\u307E\u3057\u305F" };
  }
  return {
    kind: "failed",
    message: `\u691C\u67FB\u5931\u6557\u307E\u305F\u306F\u53D6\u6D88: ${cancelledBy ?? exit.signal ?? exit.code}`
  };
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
      error: new Error(`${errorMessage(error)}\u3002\u30D7\u30ED\u30BB\u30B9\u306E\u4E00\u89A7\u3092\u8AAD\u3081\u307E\u305B\u3093: ${errorMessage(listError)}`, { cause: error })
    };
  }
}
function listProcesses() {
  const result = spawnSync2("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  assert6(result.status === 0, `ps\u304C${result.signal ?? result.status}\u3067\u7D42\u308F\u308A\u307E\u3057\u305F: ${result.stderr.trim()}`);
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
      console.error(`\u51FA\u529B\u306Epipe: \u7D42\u4E86\u3057\u305F\u30D7\u30ED\u30BB\u30B9\u306E\u6A19\u6E96\u51FA\u529B\u306Epipe\u3078\u3001\u5225\u306E\u30D7\u30ED\u30BB\u30B9\u304C${relayDrainLimitBytes}\u30D0\u30A4\u30C8\u3092\u8D85\u3048\u3066\u66F8\u304D\u7D9A\u3051\u308B\u305F\u3081\u3001\u9589\u3058\u308B\u306E\u3092\u5F85\u305F\u305A\u306B\u7D42\u3048\u307E\u3059`);
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
  assert6(!command.monitorParent || process.connected, "\u691C\u67FB\u306E\u958B\u59CB\u524D\u306B\u89AA\u3068\u306E\u63A5\u7D9A\u304C\u5207\u308C\u307E\u3057\u305F");
  let state = { phase: "starting" };
  let failure;
  const stop = (child, signal) => {
    if (child.pid === undefined) {
      return;
    }
    const sent = signal === "SIGHUP" && command.monitorParent ? "SIGTERM" : signal;
    const signalFailure = signalProcessGroup(child.pid, sent);
    failure ??= signalFailure;
  };
  let active;
  let killTimer;
  const perform = (effect) => {
    switch (effect.type) {
      case "notice":
        console.error(effect.text);
        return;
      case "clearKill":
        clearTimeout(killTimer);
        return;
      case "signal":
        if (active !== undefined) {
          stop(active, effect.signal);
        }
        return;
      case "armKill": {
        const target = active;
        if (target !== undefined) {
          killTimer = setTimeout(() => stop(target, "SIGKILL"), effect.afterMs);
          killTimer.unref();
        }
      }
    }
  };
  const transition = (event) => {
    const next = nextState(state, event, {
      killAfterMs: command.killAfterMs,
      childReports: command.childReports
    });
    state = next.state;
    for (const effect of next.effects) {
      perform(effect);
    }
  };
  let deadline;
  let pipeWait;
  let stdout = "";
  let stdoutBytes = 0;
  let stderr = "";
  const cancel = (signal) => transition({ type: "cancel", signal });
  const terminate = () => cancel("SIGTERM");
  const collect = (chunk) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 64 * 1024 * 1024) {
      failure ??= { error: new Error("\u30C6\u30B9\u30C8\u53CE\u96C6\u306E\u51FA\u529B\u304C64MiB\u3092\u8D85\u3048\u307E\u3057\u305F") };
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
  for (const signal of cancellationSignals) {
    process.on(signal, cancel);
  }
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
      child.once("exit", (code, signal) => {
        transition({ type: "exit", code, signal });
        clearTimeout(deadline);
        stop(child, "SIGKILL");
        if (relayed !== null) {
          drainRelay(relayed);
        }
        pipeWait = setTimeout(() => {
          for (const [name, pipe] of [
            ["\u6A19\u6E96\u51FA\u529B", child.stdout],
            ["\u6A19\u6E96\u30A8\u30E9\u30FC", child.stderr]
          ]) {
            if (pipe !== null && !pipe.readableEnded && !pipe.destroyed) {
              console.error(`\u51FA\u529B\u306Epipe: \u7D42\u4E86\u3057\u305F\u30D7\u30ED\u30BB\u30B9\u306E${name}\u306Epipe\u3092\u3001\u5225\u306E\u30D7\u30ED\u30BB\u30B9\u304C${graceMs}\u30DF\u30EA\u79D2\u305F\u3063\u3066\u3082\u958B\u3044\u305F\u307E\u307E\u306E\u305F\u3081\u3001\u9589\u3058\u308B\u306E\u3092\u5F85\u305F\u305A\u306B\u7D42\u3048\u307E\u3059`);
            }
            pipe?.destroy();
          }
        }, graceMs);
      });
      assert6(child.stderr);
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
      active = child;
      transition({ type: "started" });
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
    for (const signal of cancellationSignals) {
      process.off(signal, cancel);
    }
    process.off("disconnect", terminate);
    clearTimeout(deadline);
    clearTimeout(pipeWait);
    clearTimeout(killTimer);
    if (command.monitorParent && process.connected) {
      process.disconnect?.();
    }
  }
}

// src/setup.ts
function install(root, inspected, packages) {
  assert7(packages.length > 0, "--package NAME@\u56FA\u5B9A\u30D0\u30FC\u30B8\u30E7\u30F3\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const missing = [];
  const requested = new Map;
  for (const spec of packages) {
    const match = /^(oxlint|oxfmt|fallow)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
    assert7(match, `\u81EA\u52D5\u5C0E\u5165\u306Foxlint\u30FBoxfmt\u30FBfallow\u306E\u56FA\u5B9A\u30D0\u30FC\u30B8\u30E7\u30F3\u3060\u3051\u306B\u5BFE\u5FDC\u3057\u307E\u3059: ${spec}`);
    const [, name = "", version] = match;
    assert7(version);
    assert7(!requested.has(name) || requested.get(name) === version, `\u8907\u6570\u306E\u30D0\u30FC\u30B8\u30E7\u30F3\u304C\u6307\u5B9A\u3055\u308C\u3066\u3044\u307E\u3059: ${name}`);
    requested.set(name, version);
    const current = inspected.devDependencies[name] ?? inspected.dependencies[name];
    assert7(current === undefined || current === version, `\u65E2\u5B58\u306E\u30D0\u30FC\u30B8\u30E7\u30F3\u3092\u7F6E\u63DB\u3057\u307E\u305B\u3093: ${name}=${current}`);
    if (current === undefined && !missing.includes(spec)) {
      missing.push(spec);
    }
  }
  if (missing.length === 0) {
    console.log("\u6307\u5B9A\u3057\u305F\u56FA\u5B9A\u30D0\u30FC\u30B8\u30E7\u30F3\u306F\u5C0E\u5165\u6E08\u307F\u3067\u3059\u3002\u5909\u66F4\u3057\u307E\u305B\u3093");
    return;
  }
  addDevDependencies(root, inspected.packageManager, missing);
}
function addDevDependencies(root, packageManager, specs) {
  const pnpmWorkspaceRoot = packageManager === "pnpm" && existsSync5(join6(root, "pnpm-workspace.yaml")) ? ["--workspace-root"] : [];
  const args = [
    ...{
      bun: ["add", "--dev", "--exact"],
      npm: ["install", "--save-dev", "--save-exact"],
      pnpm: ["add", "--save-dev", "--save-exact"]
    }[packageManager],
    ...pnpmWorkspaceRoot,
    ...specs
  ];
  console.log(`\u5C0E\u5165: ${packageManager} ${args.join(" ")}`);
  const result = spawnSync3(packageManager, args, { cwd: root, stdio: "inherit" });
  assert7(!result.error && result.status === 0, `\u4F9D\u5B58\u5C0E\u5165\u672A\u5B8C\u4E86: ${specs.join(", ")}; ${String(result.error ?? result.signal ?? result.status)}\u3002\u90E8\u5206\u5909\u66F4\u3092\u4FDD\u6301\u3057\u3066\u3044\u307E\u3059\u3002package.json\u3068lockfile\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044`);
  const after = inspect(root);
  assert7(specs.every((spec) => {
    const at = spec.lastIndexOf("@");
    return after.devDependencies[spec.slice(0, at)] === spec.slice(at + 1);
  }), "\u5C0E\u5165\u5F8C\u306EdevDependencies\u304C\u6307\u5B9A\u3057\u305F\u56FA\u5B9A\u30D0\u30FC\u30B8\u30E7\u30F3\u3068\u4E00\u81F4\u3057\u307E\u305B\u3093");
  return after;
}
var mutator = "@mizchi/mutator";
function mutatorToAdd(config, inspected) {
  if (!config.mutation) {
    return;
  }
  const declared = [inspected.devDependencies, inspected.dependencies].flatMap((field) => {
    const version = field[mutator];
    return version === undefined ? [] : [version];
  });
  const different = declared.find((version) => version !== "0.5.3");
  assert7(different === undefined, `\u65E2\u5B58\u306E\u30D0\u30FC\u30B8\u30E7\u30F3\u3092\u7F6E\u63DB\u3057\u307E\u305B\u3093: ${mutator}=${different}\u3002${"0.5.3"}\u306B\u305D\u308D\u3048\u308B\u304B\u3001.feedback-loop.json\u306Emutation\u3092false\u306B\u3057\u3066\u304F\u3060\u3055\u3044`);
  return declared.length === 0 ? `${mutator}@${"0.5.3"}` : undefined;
}
function readMutationConfig(root) {
  const config = readConfig(root);
  assert7(!(config.runner === "vitest" && config.mutation), "Vitest\u306Erepo\u3067\u306F\u3001mutation\u3092\u4F7F\u3048\u307E\u305B\u3093\u3002\u3069\u306E\u30D5\u30A1\u30A4\u30EB\u3082\u5909\u3048\u305A\u306B\u6B62\u3081\u307E\u3059\u3002.feedback-loop.json\u306Emutation\u3092\u7701\u304F\u304B\u3001false\u306B\u3057\u3066\u304F\u3060\u3055\u3044");
  return config;
}
function generatedFiles(config, packageManager) {
  return installedFiles((path) => readFileSync4(join6(import.meta.dir, "..", path), "utf8"), packageManager, config.runner, config.mutation);
}
var legacyAffected = "test:affected";
var affectedScript = `${runtimePath} affected`;
function runtimeCommands(config) {
  let runtime = { bun: "bun", vitest: "node" }[config.runner];
  if (config.bunArgs.includes("--no-env-file")) {
    runtime += " --no-env-file";
  }
  return {
    "check:affected": `${runtime} ${affectedScript}`,
    "check:classification": `${runtime} ${runtimePath} classification`,
    ...config.mutation ? { mutation: `${runtime} ${runtimePath} mutation` } : {}
  };
}
function connectedCommands(config, scripts) {
  return Object.fromEntries(Object.entries(runtimeCommands(config)).map(([name, command]) => {
    const candidates = [
      scripts[name],
      ...name === "check:affected" ? [scripts[legacyAffected]] : []
    ];
    return [name, candidates.find((value) => value?.includes(command)) ?? command];
  }));
}
function writeFiles(root, updates) {
  for (const [path, body] of updates) {
    console.log(`\u914D\u7F6E: ${path}`);
    mkdirSync(dirname2(join6(root, path)), { recursive: true });
    writeFileSync(join6(root, path), body);
  }
}
function placement(root, path, body, mode) {
  const target = join6(root, path);
  if (!existsSync5(target)) {
    return "place";
  }
  if (readFileSync4(target, "utf8") === body) {
    return "same";
  }
  const committed = mode === "update" && gitOutput(root, ["status", "--porcelain", "--untracked-files=all", "--", path]) === "";
  return committed ? "replace" : "conflict";
}
function planGeneratedFiles(root, generated, mode) {
  const updates = new Map;
  const conflicts = [];
  for (const [path, body] of generated) {
    switch (placement(root, path, body, mode)) {
      case "same":
        break;
      case "place":
      case "replace":
        updates.set(path, body);
        break;
      case "conflict":
        conflicts.push(path);
        break;
    }
  }
  return { updates, conflicts };
}
function reportConnectionDiffs(inspected, commands) {
  for (const [name, command] of Object.entries(commands)) {
    if (inspected.scripts[name] !== command) {
      console.log(`package.json\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002\u5DEE\u5206: ${name}: ${inspected.scripts[name] ?? "(\u672A\u5B9A\u7FA9)"} \u2192 ${command}`);
    }
  }
  if (inspected.scripts["check:feedback"] === undefined) {
    console.log("package.json\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002\u5DEE\u5206: check:feedback: (\u672A\u5B9A\u7FA9)");
  }
}
var renameDiff = (name, from, to) => console.log(`\u6539\u540D\u524D\u306Escript\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002\u5DEE\u5206: ${name}: ${from} \u2192 ${to}`);
function reportLegacyScripts(scripts, legacy) {
  renameDiff(legacyAffected, legacy, "(\u524A\u9664\u3002check:affected\u3078\u6539\u540D)");
  for (const hook of ["pre", "post"]) {
    const value = scripts[`${hook}${legacyAffected}`];
    if (value !== undefined) {
      renameDiff(`${hook}${legacyAffected}`, value, `(${hook}check:affected\u3078\u6539\u540D)`);
    }
  }
}
function reportRenameDiffs(scripts) {
  const legacy = scripts[legacyAffected];
  if (legacy !== undefined) {
    if (!legacy.includes(affectedScript)) {
      return;
    }
    reportLegacyScripts(scripts, legacy);
  }
  const call = /(?<![\w:-])test:affected(?![\w:-])/g;
  for (const [name, value] of Object.entries(scripts)) {
    const renamed = value.replace(call, "check:affected");
    if (name !== legacyAffected && name !== "check:affected" && renamed !== value) {
      renameDiff(name, value, renamed);
    }
  }
}
function newerInstalled(root, generated) {
  return [...generated].flatMap(([path, body]) => {
    const target = join6(root, path);
    const placed = existsSync5(target) ? generatedVersion(readFileSync4(target, "utf8")) : undefined;
    const bundled = generatedVersion(body);
    return placed !== undefined && bundled !== undefined && !versionAtLeast(bundled, placed) ? [`${path}\uFF08${placed}\uFF09`] : [];
  });
}
function update(root, inspected) {
  const config = readMutationConfig(root);
  const generated = generatedFiles(config, inspected.packageManager);
  const version = generatedVersion(generated.get(runtimePath) ?? "");
  const newer = newerInstalled(root, generated);
  const { updates, conflicts } = planGeneratedFiles(root, generated, "update");
  assert7(newer.length === 0, `\u914D\u7F6E\u6E08\u307F\u306E\u751F\u6210\u7269\u304C\u3001\u3053\u306E\u30D7\u30E9\u30B0\u30A4\u30F3\u306E\u30D0\u30FC\u30B8\u30E7\u30F3\uFF08${version}\uFF09\u3088\u308A\u65B0\u3057\u3044\u305F\u3081\u3001\u3069\u306E\u30D5\u30A1\u30A4\u30EB\u3082\u66F4\u65B0\u3057\u307E\u305B\u3093\u3002\u30D7\u30E9\u30B0\u30A4\u30F3\u3092\u66F4\u65B0\u3057\u3066\u304B\u3089\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044: ${newer.join(", ")}`);
  assert7(conflicts.length === 0, `\u672A\u30B3\u30DF\u30C3\u30C8\u306E\u5909\u66F4\u307E\u305F\u306F\u672A\u8FFD\u8DE1\u306E\u30D5\u30A1\u30A4\u30EB\u304C\u3042\u308B\u305F\u3081\u3001\u3069\u306E\u30D5\u30A1\u30A4\u30EB\u3082\u66F4\u65B0\u3057\u307E\u305B\u3093\u3002\u30B3\u30DF\u30C3\u30C8\u3059\u308B\u304B\u5909\u66F4\u3092\u623B\u3057\u3066\u304B\u3089\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044: ${conflicts.join(", ")}`);
  reportConnectionDiffs(inspected, connectedCommands(config, inspected.scripts));
  reportRenameDiffs(inspected.scripts);
  writeFiles(root, updates);
  console.log(updates.size === 0 ? `\u751F\u6210\u7269\u306F\u6700\u65B0\u3067\u3059\uFF08${version}\uFF09\u3002\u5909\u66F4\u3057\u307E\u305B\u3093` : "\u751F\u6210\u7269\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F\u3002check:classification\u3068check:feedback\u3092\u5B9F\u884C\u3057\u3066\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
}
async function apply(root, inspected, feedback, checkCommand) {
  assert7(feedback, "--feedback-command\u306B\u8A3A\u65AD\u7528\u30B3\u30DE\u30F3\u30C9\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  assert7(checkCommand !== undefined || inspected.scripts.check !== undefined, "\u5168\u4F53check\u304C\u672A\u6307\u5B9A\u3067\u3059\u3002--check-command\u306B\u5168\u4F53check\u306E\u30B3\u30DE\u30F3\u30C9\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const config = readMutationConfig(root);
  const retryCommand = [
    process.execPath,
    ...process.execArgv,
    import.meta.path,
    "apply",
    "--repo",
    root,
    "--feedback-command",
    feedback,
    ...checkCommand === undefined ? [] : ["--check-command", checkCommand]
  ].map(shellQuote).join(" ");
  const run = commandRunner(join6(import.meta.dir, "runtime.mjs"), retryCommand);
  await classification(root, config, run);
  const commands = {
    ...connectedCommands(config, inspected.scripts),
    "check:feedback": feedback
  };
  for (const [name, command] of Object.entries(commands)) {
    const optOut = name === "mutation" ? "\u3002.feedback-loop.json\u306Emutation\u3092false\u306B\u3059\u308B\u3068\u3001mutation\u3092\u63A5\u7D9A\u3057\u307E\u305B\u3093" : "";
    assert7(inspected.scripts[name] === undefined || inspected.scripts[name] === command, `\u65E2\u5B58\u30B3\u30DE\u30F3\u30C9\u3068\u885D\u7A81\u3057\u3066\u3044\u307E\u3059: ${name}${optOut}`);
  }
  const { updates, conflicts } = planGeneratedFiles(root, generatedFiles(config, inspected.packageManager), "apply");
  assert7(conflicts.length === 0, `\u914D\u7F6E\u6E08\u307F\u30D5\u30A1\u30A4\u30EB\u3068\u885D\u7A81\u3057\u3066\u3044\u307E\u3059: ${conflicts.join(", ")}`);
  const dependency = mutatorToAdd(config, inspected);
  const instructions = planAgentInstructions(root, inspected.packageManager, checkCommand);
  const current = dependency === undefined ? inspected : addDevDependencies(root, inspected.packageManager, [dependency]);
  const nextPackage = { ...current.pkg, scripts: { ...current.scripts, ...commands } };
  if (JSON.stringify(nextPackage) !== JSON.stringify(current.pkg)) {
    updates.set("package.json", `${JSON.stringify(nextPackage, null, 2)}
`);
  }
  for (const [path, body] of instructions) {
    updates.set(path, body);
  }
  console.log(JSON.stringify({ scripts: commands }));
  reportRenameDiffs(nextPackage.scripts);
  writeFiles(root, updates);
  console.log("\u88DC\u52A9\u30D5\u30A1\u30A4\u30EB\u3092\u914D\u7F6E\u3057\u307E\u3057\u305F");
  console.log("\u9759\u7684\u691C\u67FB\u30FB\u901A\u5E38check\u30FBCI\u306E\u63A5\u7D9A\u3001AGENTS.md\u306E\u65E2\u5B58\u6307\u793A\u3068\u306E\u7D71\u5408\u3068\u52D5\u4F5C\u78BA\u8A8D\u306F\u5C0E\u5165\u62C5\u5F53\u304C\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044");
}
function readJunit(report) {
  try {
    return readFileSync4(report, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      assert7.fail("\u6BD4\u8F03\u306E\u30B3\u30DE\u30F3\u30C9\u304CJUnit\u3092\u66F8\u304B\u305A\u306B\u7D42\u308F\u308A\u307E\u3057\u305F");
    }
    throw error;
  }
}
async function compareTests(root, argv) {
  assert7(argv[0] === "bun" && argv.includes("test"), "--\u306E\u5F8C\u306Bbun test\u306Eargv\u304C\u5FC5\u8981\u3067\u3059");
  const config = readConfig(root);
  assert7(config.runner === "bun", "compare-tests\u306FBun\u3060\u3051\u3067\u4F7F\u7528\u3067\u304D\u307E\u3059");
  const run = commandRunner(join6(import.meta.dir, "runtime.mjs"), "setup.mjs compare-tests\u3092\u540C\u3058\u5F15\u6570\u3067\u518D\u5B9F\u884C");
  const { all } = await classification(root, config, run);
  const temp = mkdtempSync(join6(tmpdir(), "feedback-loop-compare-"));
  try {
    const report = join6(temp, "junit.xml");
    await run([...argv, "--reporter=junit", "--reporter-outfile", report], {
      cwd: root,
      stdout: "capture",
      allowFailure: true
    });
    const { suites } = readBunSuites(readJunit(report), root);
    const executed = new Set(suites.keys());
    const listed = new Set(all);
    const missing = all.filter((path) => !executed.has(path));
    const extra = [...executed].filter((path) => !listed.has(path)).sort();
    console.log(JSON.stringify({ missing, extra }));
    process.exitCode = missing.length + extra.length === 0 ? 0 : 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
var usage = `\u4F7F\u3044\u65B9: bun setup.mjs <\u64CD\u4F5C> --repo <package.json\u304C\u3042\u308B\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u306E\u7D76\u5BFE\u30D1\u30B9> [\u5F15\u6570]

\u64CD\u4F5C:
  inspect   \u69CB\u6210\u3092\u8ABF\u3079\u3066JSON\u3067\u8868\u793A\u3057\u307E\u3059\u3002\u30D5\u30A1\u30A4\u30EB\u306F\u5909\u66F4\u3057\u307E\u305B\u3093
  install   \u4E0D\u8DB3\u3059\u308B\u56FA\u5B9A\u30D0\u30FC\u30B8\u30E7\u30F3\u306E\u4F9D\u5B58\u3092\u5C0E\u5165\u3057\u307E\u3059
            --package <oxlint|oxfmt|fallow>@<\u30D0\u30FC\u30B8\u30E7\u30F3>\uFF08\u8907\u6570\u6307\u5B9A\u53EF\uFF09
  apply     .feedback-loop.json\u3092\u8AAD\u307F\u3001\u88DC\u52A9\u30D5\u30A1\u30A4\u30EB\u3068package scripts\u3092\u914D\u7F6E\u3057\u307E\u3059
            mutation\u3092\u63A5\u7D9A\u3059\u308B\u3068\u304D\u3001@mizchi/mutator\u3092\u56FA\u5B9A\u30D0\u30FC\u30B8\u30E7\u30F3\u3067\u5C0E\u5165\u3057\u307E\u3059
            --feedback-command <check:feedback\u306B\u8A2D\u5B9A\u3059\u308B\u8A3A\u65AD\u7528\u30B3\u30DE\u30F3\u30C9>
            --check-command <AGENTS.md\u306B\u8A18\u8F09\u3059\u308B\u5168\u4F53check\u306E\u30B3\u30DE\u30F3\u30C9>\uFF08\u7701\u7565\u6642\u306Fcheck script\uFF09
            --update  \u5C0E\u5165\u6E08\u307F\u306E\u751F\u6210\u7269\u3092\u66F4\u65B0\u3057\u307E\u3059\u3002--feedback-command\u30FB--check-command\u3068\u306F\u4F75\u7528\u3057\u307E\u305B\u3093

  compare-tests  \u901A\u5E38check\u306EBun\u5B9F\u884C\u3068\u5206\u985E\u306E\u4E00\u89A7\u3092\u7167\u5408\u3057\u307E\u3059
                -- bun test [\u901A\u5E38check\u3068\u540C\u3058\u5F15\u6570]

\u5171\u901A:
  --repo <\u30D1\u30B9>   Git checkout\u306E\u4E2D\u3067\u3001\u5BFE\u8C61\u306Epackage.json\u304C\u3042\u308B\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u306E\u7D76\u5BFE\u30D1\u30B9
  -h, --help      \u3053\u306E\u4E00\u89A7\u3092\u8868\u793A\u3057\u307E\u3059`;
var flagOptions = new Set(["--update"]);
var repeatableOptions = new Set(["--package"]);
function splitArgv(argv) {
  const separator = argv.indexOf("--");
  return separator < 0 ? { options: argv, testArgv: [], separated: false } : { options: argv.slice(0, separator), testArgv: argv.slice(separator + 1), separated: true };
}
function parseOptions(args) {
  const values = new Map;
  for (let i = 0;i < args.length; i += 1) {
    const key = args[i];
    assert7(key, "\u7A7A\u306E\u5F15\u6570\u306F\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
    assert7(repeatableOptions.has(key) || !values.has(key), `${key}\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059`);
    const supplied = values.get(key) ?? [];
    values.set(key, supplied);
    if (flagOptions.has(key)) {
      supplied.push("true");
    } else {
      supplied.push(args[i + 1]?.startsWith("-") ? "" : args[++i] ?? "");
    }
  }
  return values;
}
async function setup({
  options: [name = "", ...args],
  testArgv,
  separated
}) {
  const values = parseOptions(args);
  const {
    "--repo": [root = ""] = [],
    "--feedback-command": [feedback = ""] = [],
    "--check-command": [checkCommand] = [],
    "--package": packages = []
  } = Object.fromEntries(values);
  const operations = {
    inspect: {
      options: ["--repo"],
      run: (repo) => {
        const { pkg: _pkg, manager: _manager, ...report } = inspect(repo);
        console.log(JSON.stringify(report, null, 2));
      }
    },
    install: {
      options: ["--repo", "--package"],
      run: (repo) => install(repo, inspectManaged(repo), packages)
    },
    apply: {
      options: ["--repo", "--feedback-command", "--check-command"],
      run: (repo) => apply(repo, inspectManaged(repo), feedback, checkCommand)
    },
    "apply --update": {
      options: ["--repo"],
      run: (repo) => update(repo, inspectManaged(repo))
    },
    "compare-tests": {
      options: ["--repo"],
      testArgv: true,
      run: (repo) => compareTests(repo, testArgv)
    }
  };
  const operation = name === "apply" && values.delete("--update") ? "apply --update" : name;
  const definition = Object.hasOwn(operations, operation) && operations[operation];
  assert7(definition, "\u64CD\u4F5C\u306Finspect\u30FBinstall\u30FBapply\u30FBcompare-tests\u3067\u3059");
  for (const [key, supplied] of values) {
    assert7(definition.options.includes(key), `${operation}\u3067\u306F${key}\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093`);
    assert7(supplied.every((value) => value.trim()), `${key}\u306E\u5024\u304C\u3042\u308A\u307E\u305B\u3093`);
  }
  assert7(isAbsolute3(root), "--repo\u306Bpackage.json\u304C\u3042\u308B\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u306E\u7D76\u5BFE\u30D1\u30B9\u304C\u5FC5\u8981\u3067\u3059");
  assert7(!separated || definition.testArgv, `${operation}\u3067\u306F--\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093`);
  gitRoot(root);
  const repo = realpathSync3(root);
  assert7(existsSync5(join6(repo, "package.json")), "--repo\u306Fpackage.json\u304C\u3042\u308B\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  await definition.run(repo);
}
try {
  assert7(versionAtLeast(process.versions.bun, "1.4.4"), `Bun ${"1.4.4"}\u4EE5\u4E0A\u3067\u8D77\u52D5\u3057\u3066\u304F\u3060\u3055\u3044\uFF08\u73FE\u5728: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.version}`}\uFF09`);
  const input = splitArgv(process.argv.slice(2));
  if (input.options.some((arg) => arg === "--help" || arg === "-h")) {
    console.log(usage);
    process.exit(0);
  }
  await setup(input);
} catch (error) {
  if (!(error instanceof ReportedFailure)) {
    console.error(`setup-feedback-loop\u672A\u5B8C\u4E86: ${errorMessage(error)}`);
  }
  process.exitCode = 1;
}
