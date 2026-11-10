// 生成元: thkt/feedback-loop scripts/build.ts。直接編集せず、正本を変更して再生成してください
// @bun
// src/setup.ts
import assert6 from "assert/strict";
import { spawnSync as spawnSync2 } from "child_process";
import {
  existsSync as existsSync2,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  realpathSync as realpathSync2,
  writeFileSync
} from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute as isAbsolute2, join as join3 } from "path";

// src/classification.ts
import assert3 from "assert/strict";
import { readdirSync, statSync } from "fs";
import { join as join2 } from "path";

// src/config.ts
import assert2 from "assert/strict";
import { existsSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";

// src/values.ts
import assert from "assert/strict";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertObject(value) {
  assert(isRecord(value), "\u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u304C\u5FC5\u8981\u3067\u3059");
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function versionAtLeast(version, minimum) {
  const parse = (text) => /^(\d+)\.(\d+)\.(\d+)/.exec(text ?? "")?.slice(1).map(Number);
  const [actual, required] = [parse(version), parse(minimum)];
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

// src/config.ts
function assertStringArray(value) {
  assert2(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0), "\u6587\u5B57\u5217\u914D\u5217\u304C\u5FC5\u8981\u3067\u3059");
}
function assertRepoRelativePath(path) {
  assert2(!isAbsolute(path) && !path.split("/").includes("..") && !path.startsWith("./") && !path.includes("\\"), `repo\u76F8\u5BFE\u30D1\u30B9\u304C\u5FC5\u8981\u3067\u3059: ${path}`);
}
var configKeys = new Set([
  "runner",
  "base",
  "collect",
  "testGlobs",
  "assurance",
  "prepare",
  "bunArgs",
  "bunWorkers",
  "testArgs",
  "allowSkipped",
  "globalChanges",
  "dependencies"
]);
function readConfig(root) {
  const value = JSON.parse(readFileSync(join(root, ".feedback-loop.json"), "utf8"));
  assertObject(value);
  const unknownKeys = Object.keys(value).filter((key) => !configKeys.has(key));
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
    bunArgs = [],
    bunWorkers = 4,
    allowSkipped = true,
    assurance: assuranceValue = [],
    dependencies: dependenciesValue = []
  } = value;
  if (collect !== undefined || value.runner === "vitest") {
    assertStringArray(collect);
    assert2(collect.length > 0, "\u53CE\u96C6\u30B3\u30DE\u30F3\u30C9\u306F\u7A7A\u306B\u3067\u304D\u307E\u305B\u3093");
  }
  assertStringArray(testGlobs);
  assertStringArray(prepare);
  assertStringArray(testArgs);
  assertStringArray(globalChanges);
  assert2(testGlobs.length > 0, "\u30C6\u30B9\u30C8glob\u306F\u5FC5\u9808\u3067\u3059");
  assert2(typeof allowSkipped === "boolean", "allowSkipped\u306Fboolean\u3067\u3059");
  assertStringArray(bunArgs);
  assert2(value.runner === "bun" || bunArgs.length === 0, "Vitest\u306B\u306FbunArgs\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
  assert2(typeof bunWorkers === "number" && Number.isSafeInteger(bunWorkers) && bunWorkers > 0, "bunWorkers\u306F\u6B63\u306E\u5B89\u5168\u306A\u6574\u6570\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  assert2(value.runner === "bun" || value.bunWorkers === undefined, "Vitest\u306B\u306FbunWorkers\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
  if (value.runner === "bun") {
    assert2(![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)), "Bun\u306E\u9694\u96E2\u306F\u56FA\u5B9A\u3067\u3059\u3002\u4E26\u5217\u6570\u306FbunWorkers\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
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
    assertStringArray(item.inputs);
    assertStringArray(item.tests);
    assert2(item.inputs.length > 0 && item.tests.length > 0, "\u4F9D\u5B58\u5BFE\u5FDC\u306F\u7A7A\u306B\u3067\u304D\u307E\u305B\u3093");
    item.inputs.forEach(assertRepoRelativePath);
    item.tests.forEach(assertRepoRelativePath);
    return { inputs: item.inputs, tests: item.tests };
  });
  testGlobs.forEach(assertRepoRelativePath);
  globalChanges.forEach(assertRepoRelativePath);
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
    globalChanges,
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
function repoPath(root, path) {
  const absolute = resolve(root, path);
  const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
  const local = relative(root, canonical);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local) ? local.split(sep).join("/") : absolute;
}

// src/classification.ts
function filesUnder(root, prefix, excludeHidden) {
  return readdirSync(join2(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.name === ".git" || entry.name === "node_modules" || excludeHidden && entry.isDirectory() && entry.name.startsWith(".")) {
      return [];
    }
    return entry.isDirectory() ? filesUnder(root, `${path}/`, excludeHidden) : entry.isFile() ? [path] : [];
  });
}
async function classification(root, config, run) {
  const prefixes = config.testGlobs.map((glob) => {
    const fixed = glob.split(/[*?]/, 1)[0] ?? "";
    return fixed.slice(0, fixed.lastIndexOf("/") + 1);
  });
  const roots = [...new Set(prefixes)].filter((prefix, _, all) => !all.some((parent) => parent !== prefix && prefix.startsWith(parent)));
  const files = roots.filter((prefix) => !prefix.split("/").some((part) => part === ".git" || part === "node_modules" || config.collect === undefined && part.startsWith("."))).filter((prefix) => {
    const found = statSync(join2(root, prefix), { throwIfNoEntry: false })?.isDirectory() ?? false;
    assert3(found || config.collect !== undefined, `testGlobs\u306E\u63A2\u7D22\u5834\u6240\u304C\u3042\u308A\u307E\u305B\u3093: ${prefix}`);
    return found;
  }).flatMap((prefix) => filesUnder(root, prefix, config.collect === undefined));
  const expected = files.filter((path) => config.testGlobs.some((glob) => matches(path, glob))).sort();
  let actual;
  if (config.collect !== undefined) {
    const { stdout } = await run(config.collect, { cwd: root, captureStdout: true });
    const collected = JSON.parse(stdout);
    assertStringArray(collected);
    collected.forEach(assertRepoRelativePath);
    assert3(new Set(collected).size === collected.length, "\u53CE\u96C6\u7D50\u679C\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059");
    actual = collected;
  } else {
    actual = files.filter((path) => !path.split("/").some((part) => part.startsWith(".")) && /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(path)).sort();
  }
  assert3(JSON.stringify([...actual].sort()) === JSON.stringify(expected), `\u901A\u5E38\u53CE\u96C6\u3068testGlobs\u306E\u96C6\u5408\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093
collect=${JSON.stringify(actual)}
glob=${JSON.stringify(expected)}`);
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

// src/git.ts
import { execFile, spawnSync } from "child_process";
function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function defaultBase(root) {
  const remoteHead = gitOutput(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD"
  ]);
  if (remoteHead) {
    return remoteHead;
  }
  for (const prefix of ["refs/remotes/origin/", "refs/heads/"]) {
    const found = ["main", "master"].filter((name) => gitOutput(root, ["rev-parse", "--verify", "--quiet", `${prefix}${name}`]) !== undefined);
    if (found.length > 0) {
      return found.length === 1 ? `${prefix === "refs/heads/" ? "" : "origin/"}${found[0]}` : null;
    }
  }
  return null;
}

// src/installed.ts
var packageManagerToken = "__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__";
function installedFiles(read, packageManager, runner) {
  const files = new Map([
    [
      "scripts/feedback-loop/runtime.mjs",
      read("runtime.mjs").replaceAll(packageManagerToken, packageManager)
    ]
  ]);
  if (runner === "bun") {
    files.set("scripts/feedback-loop/record-modules.ts", read("record-modules.ts"));
  }
  return files;
}

// src/bun-report.ts
import assert4 from "assert/strict";
function elements(node, name) {
  return node.children.filter((child) => typeof child !== "string" && ("name" in child) && child.name === name);
}
function readBunSuites(text, root) {
  const report = Bun.XML.parse(text, { compact: false });
  assert4(report.name === "testsuites", "Bun JUnit\u306Eroot\u304C\u3042\u308A\u307E\u305B\u3093");
  const suites = new Map;
  for (const suite of elements(report, "testsuite")) {
    const file = suite.attributes.file;
    assert4(file && file.trim(), "JUnit\u306E\u30C6\u30B9\u30C8\u30D5\u30A1\u30A4\u30EB\u304C\u3042\u308A\u307E\u305B\u3093");
    const owner = repoPath(root, file);
    assert4(!suites.has(owner), `JUnit\u306E\u30D5\u30A1\u30A4\u30EB\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059: ${file}`);
    suites.set(owner, suite);
  }
  return { report, suites };
}

// src/command.ts
import assert5 from "assert/strict";
import { spawn } from "child_process";
function commandRunner(runtime, retryCommand) {
  return async (argv, options = {}) => {
    assert5(argv[0], "\u5B9F\u884C\u30B3\u30DE\u30F3\u30C9\u304C\u3042\u308A\u307E\u305B\u3093");
    const {
      cwd = process.cwd(),
      env = process.env,
      captureStdout = false,
      allowFailure = false
    } = options;
    const log = captureStdout ? console.error : console.log;
    const operation = captureStdout ? "\u53CE\u96C6" : "\u5B9F\u884C";
    log(`${operation}: ${argv.join(" ")}; \u518D\u5B9F\u884C: ${retryCommand}`);
    const startupEnv = { ...env };
    delete startupEnv.BUN_OPTIONS;
    delete startupEnv.NODE_OPTIONS;
    return superviseCommand({
      command: process.execPath,
      args: [...process.versions.bun ? ["--no-env-file"] : [], runtime, "execute-child"],
      options: {
        stdio: ["inherit", captureStdout ? "pipe" : "inherit", "pipe", "ipc"],
        cwd,
        env: startupEnv,
        detached: true,
        serialization: "json"
      },
      message: { argv, env, allowFailure },
      monitorParent: false
    });
  };
}
function clearCancellationTimer(state) {
  if (state.phase === "cancelling") {
    clearTimeout(state.timer);
  }
}
function commandResult(result, failure, state, output, allowFailure) {
  if ("error" in result) {
    throw result.error;
  }
  if (failure !== undefined) {
    assert5.fail(`\u5B50\u30D7\u30ED\u30BB\u30B9\u306E\u7D42\u4E86\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093: ${String(failure.error)}`);
  }
  if (state.phase === "finished" && state.cancelled || result.signal !== null || !allowFailure && result.code !== 0) {
    assert5.fail(`\u691C\u67FB\u5931\u6557\u307E\u305F\u306F\u53D6\u6D88: ${result.signal ?? result.code}`);
  }
  return output;
}
async function superviseCommand(command) {
  assert5(!command.monitorParent || process.connected, "\u691C\u67FB\u306E\u958B\u59CB\u524D\u306B\u89AA\u3068\u306E\u63A5\u7D9A\u304C\u5207\u308C\u307E\u3057\u305F");
  let state = { phase: "starting" };
  let failure;
  const stop = (child, signal) => {
    if (child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!hasErrorCode(error, "ESRCH")) {
        failure ??= { error };
      }
    }
  };
  const transition = (event) => {
    if (event.type === "started") {
      const pendingSignal = state.phase === "starting" ? state.pendingSignal : undefined;
      state = { phase: "running", child: event.child };
      if (pendingSignal === undefined) {
        return;
      }
      event = { type: "cancel", signal: pendingSignal };
    }
    if (event.type === "close") {
      clearCancellationTimer(state);
      state = { phase: "finished", cancelled: state.phase === "cancelling" };
      return;
    }
    switch (state.phase) {
      case "starting":
        state = { phase: "starting", pendingSignal: event.signal };
        return;
      case "finished":
        return;
      case "running": {
        const { child } = state;
        state = { phase: "cancelling", child, timer: undefined };
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
  let stdout = "";
  let stdoutBytes = 0;
  let stderr = "";
  const interrupt = () => transition({ type: "cancel", signal: "SIGINT" });
  const terminate = () => transition({ type: "cancel", signal: "SIGTERM" });
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
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  if (command.monitorParent) {
    process.on("disconnect", terminate);
  }
  try {
    const result = await new Promise((done) => {
      const child = spawn(command.command, command.args, command.options);
      child.once("error", (error) => done({ error }));
      child.once("close", (code, signal) => {
        transition({ type: "close" });
        done({ code, signal });
      });
      child.once("exit", () => stop(child, "SIGKILL"));
      assert5(child.stderr);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (!process.stderr.destroyed) {
          process.stderr.write(chunk);
        }
        stderr += chunk.slice(0, Math.max(0, 4096 - stderr.length));
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", collect);
      transition({ type: "started", child });
      if (command.message !== undefined) {
        child.send(command.message, sent);
      }
    });
    return commandResult(result, failure, state, { stdout, stderr }, command.allowFailure ?? false);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("disconnect", terminate);
    clearCancellationTimer(state);
    if (command.monitorParent && process.connected) {
      process.disconnect?.();
    }
  }
}

// src/setup.ts
function stringMap(value) {
  assertObject(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    assert6(typeof item === "string", `${key}\u306F\u6587\u5B57\u5217\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044`);
    result[key] = item;
  }
  return result;
}
function inspect(root) {
  const pkg = JSON.parse(readFileSync2(join3(root, "package.json"), "utf8"));
  assertObject(pkg);
  const scripts = stringMap(pkg.scripts ?? {});
  const devDependencies = stringMap(pkg.devDependencies ?? {});
  const dependencies = stringMap(pkg.dependencies ?? {});
  const hints = new Set;
  if (typeof pkg.packageManager === "string") {
    hints.add(pkg.packageManager.split("@")[0] ?? "unknown");
  }
  for (const [path, manager] of [
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "unknown"],
    ["pnpm-lock.yaml", "unknown"]
  ]) {
    if (existsSync2(join3(root, path))) {
      hints.add(manager);
    }
  }
  const first = [...hints][0];
  const packageManager = hints.size === 1 && (first === "bun" || first === "npm") ? first : null;
  const configFiles = readdirSync2(root, { withFileTypes: true }).filter((entry) => entry.isFile() && /(?:config|lock|mise|bunfig|feedback-loop|eslint|prettier|biome|oxlint|oxfmt|fallow)/.test(entry.name)).map((entry) => entry.name);
  const workflow = join3(root, ".github/workflows");
  if (existsSync2(workflow)) {
    configFiles.push(...readdirSync2(workflow).map((name) => `.github/workflows/${name}`));
  }
  const base = defaultBase(root);
  return {
    packageManager,
    base,
    scripts,
    devDependencies,
    dependencies,
    configFiles: configFiles.sort(),
    runtime: pkg.engines ?? pkg.packageManager ?? null,
    tools: Object.keys({ ...dependencies, ...devDependencies }).filter((name) => /eslint|prettier|biome|oxlint|oxfmt|fallow|typescript|vitest/.test(name)),
    diagnostics: [
      [packageManager, "package manager\u304C\u672A\u6307\u5B9A\u3001\u7AF6\u5408\u3001\u307E\u305F\u306F\u672A\u5BFE\u5FDC\u3067\u3059"],
      [
        base,
        "\u6BD4\u8F03\u5143\u3092\u6C7A\u3081\u3089\u308C\u307E\u305B\u3093\u3002origin/HEAD\u304C\u306A\u304F\u3001main\u3068master\u304C\u4E21\u65B9\u3042\u308B\u304B\u3001\u3069\u3061\u3089\u3082\u3042\u308A\u307E\u305B\u3093"
      ]
    ].filter(([found]) => !found).map(([, message]) => message),
    pkg
  };
}
function install(root, inspected, packages) {
  assert6(inspected.packageManager, "package manager\u3092\u9078\u629E\u3067\u304D\u307E\u305B\u3093");
  assert6(packages.length > 0, "--package NAME@\u56FA\u5B9A\u7248\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const missing = [];
  const requested = new Map;
  for (const spec of packages) {
    const match = /^(oxlint|oxfmt|fallow)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
    assert6(match, `\u81EA\u52D5\u5C0E\u5165\u306Foxlint\u30FBoxfmt\u30FBfallow\u306E\u56FA\u5B9A\u7248\u3060\u3051\u306B\u5BFE\u5FDC\u3057\u307E\u3059: ${spec}`);
    const [, name = "", version] = match;
    assert6(version);
    assert6(!requested.has(name) || requested.get(name) === version, `\u8907\u6570\u306E\u7248\u304C\u6307\u5B9A\u3055\u308C\u3066\u3044\u307E\u3059: ${name}`);
    requested.set(name, version);
    const current = inspected.devDependencies[name] ?? inspected.dependencies[name];
    assert6(current === undefined || current === version, `\u65E2\u5B58\u7248\u3092\u7F6E\u63DB\u3057\u307E\u305B\u3093: ${name}=${current}`);
    if (current === undefined && !missing.includes(spec)) {
      missing.push(spec);
    }
  }
  if (missing.length === 0) {
    console.log("\u6307\u5B9A\u3057\u305F\u56FA\u5B9A\u7248\u306F\u5C0E\u5165\u6E08\u307F\u3067\u3059\u3002\u5909\u66F4\u3057\u307E\u305B\u3093");
    return;
  }
  const args = inspected.packageManager === "bun" ? ["add", "--dev", "--exact", ...missing] : ["install", "--save-dev", "--save-exact", ...missing];
  console.log(`\u5C0E\u5165: ${inspected.packageManager} ${args.join(" ")}`);
  const result = spawnSync2(inspected.packageManager, args, { cwd: root, stdio: "inherit" });
  assert6(!result.error && result.status === 0, `\u4F9D\u5B58\u5C0E\u5165\u672A\u5B8C\u4E86: ${missing.join(", ")}; ${String(result.error ?? result.signal ?? result.status)}\u3002\u90E8\u5206\u5909\u66F4\u3092\u4FDD\u6301\u3057\u3066\u3044\u307E\u3059\u3002package.json\u3068lockfile\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044`);
  const after = inspect(root);
  assert6(missing.every((spec) => {
    const [name = "", version] = spec.split("@");
    return after.devDependencies[name] === version;
  }), "\u5C0E\u5165\u5F8C\u306EdevDependencies\u304C\u6307\u5B9A\u3057\u305F\u56FA\u5B9A\u7248\u3068\u4E00\u81F4\u3057\u307E\u305B\u3093");
}
function generatedFiles(config, packageManager) {
  return installedFiles((name) => readFileSync2(join3(import.meta.dir, name), "utf8"), packageManager, config.runner);
}
function runtimeCommands(config) {
  let runtime = { bun: "bun", vitest: "node" }[config.runner];
  if (config.bunArgs.includes("--no-env-file")) {
    runtime += " --no-env-file";
  }
  return {
    "test:affected": `${runtime} scripts/feedback-loop/runtime.mjs affected`,
    "check:classification": `${runtime} scripts/feedback-loop/runtime.mjs classification`
  };
}
function writeFiles(root, updates) {
  for (const [path, body] of updates) {
    console.log(`\u914D\u7F6E: ${path}`);
    mkdirSync(dirname(join3(root, path)), { recursive: true });
    writeFileSync(join3(root, path), body);
  }
}
function planGeneratedFiles(root, generated, mode) {
  const updates = new Map;
  const conflicts = [];
  for (const [path, body] of generated) {
    const target = join3(root, path);
    const current = existsSync2(target) ? readFileSync2(target, "utf8") : undefined;
    if (current === body) {
      continue;
    }
    if (current === undefined || mode === "update" && gitOutput(root, ["status", "--porcelain", "--untracked-files=all", "--", path]) === "") {
      updates.set(path, body);
    } else {
      conflicts.push(path);
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
function update(root, inspected) {
  assert6(inspected.packageManager, "package manager\u3092\u9078\u629E\u3067\u304D\u307E\u305B\u3093");
  const config = readConfig(root);
  const { updates, conflicts } = planGeneratedFiles(root, generatedFiles(config, inspected.packageManager), "update");
  assert6(conflicts.length === 0, `\u672A\u30B3\u30DF\u30C3\u30C8\u306E\u5909\u66F4\u307E\u305F\u306F\u672A\u8FFD\u8DE1\u306E\u30D5\u30A1\u30A4\u30EB\u304C\u3042\u308B\u305F\u3081\u3001\u3069\u306E\u30D5\u30A1\u30A4\u30EB\u3082\u66F4\u65B0\u3057\u307E\u305B\u3093\u3002\u30B3\u30DF\u30C3\u30C8\u3059\u308B\u304B\u5909\u66F4\u3092\u623B\u3057\u3066\u304B\u3089\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044: ${conflicts.join(", ")}`);
  reportConnectionDiffs(inspected, runtimeCommands(config));
  writeFiles(root, updates);
  console.log(updates.size === 0 ? "\u751F\u6210\u7269\u306F\u6700\u65B0\u3067\u3059\u3002\u5909\u66F4\u3057\u307E\u305B\u3093" : "\u751F\u6210\u7269\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F\u3002check:classification\u3068check:feedback\u3092\u5B9F\u884C\u3057\u3066\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
}
function planAgentInstructions(root, packageManager, check) {
  const updates = new Map;
  const agentsPath = join3(root, "AGENTS.md");
  const agents = existsSync2(agentsPath) ? readFileSync2(agentsPath, "utf8") : "";
  if (/^## \u5909\u66F4\u5F8C\u306E\u78BA\u8A8D[ \t]*\r?$/m.test(agents)) {
    console.log("AGENTS.md\u306E\u300C## \u5909\u66F4\u5F8C\u306E\u78BA\u8A8D\u300D\u306F\u65E2\u5B58\u306E\u5185\u5BB9\u3092\u4FDD\u6301\u3057\u307E\u3059");
  } else {
    const section = `## \u5909\u66F4\u5F8C\u306E\u78BA\u8A8D

\u30B3\u30FC\u30C9\u3084\u30C6\u30B9\u30C8\u3092\u5909\u66F4\u3057\u305F\u3089\u3001\u4F5C\u696D\u3092\u7D42\u3048\u308B\u524D\u306B\`${packageManager} run check:feedback\`\u3092\u5B9F\u884C\u3059\u308B\u3002\u5931\u6557\u3057\u305F\u3089\u8A3A\u65AD\u3092\u8AAD\u3093\u3067\u76F4\u3057\u3001\u6210\u529F\u3059\u308B\u307E\u3067\u518D\u5B9F\u884C\u3059\u308B\u3002assurance\u306E\u30C6\u30B9\u30C8\u3084\u3001\u5F71\u97FF\u3092\u5224\u65AD\u3067\u304D\u306A\u3044\u5909\u66F4\u3067\u306F\`${check}\`\u3082\u5B9F\u884C\u3059\u308B\u3002\`check:feedback\`\u306E\u6210\u529F\u3092\u5168\u4F53check\u306E\u6210\u529F\u3068\u3057\u3066\u5831\u544A\u3057\u306A\u3044\u3002
`;
    const prefix = agents ? `${agents}${agents.endsWith(`
`) ? `
` : `

`}` : "";
    updates.set("AGENTS.md", prefix + section);
  }
  const claudePath = join3(root, "CLAUDE.md");
  if (existsSync2(claudePath)) {
    const claude = readFileSync2(claudePath, "utf8");
    if (!/^@AGENTS\.md[ \t]*\r?$/m.test(claude)) {
      updates.set("CLAUDE.md", `@AGENTS.md
${claude}`);
    }
  } else if (existsSync2(join3(root, "CLAUDE.local.md"))) {
    console.log("CLAUDE.local.md\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002\u5229\u7528\u8005\u304C@AGENTS.md\u306E\u884C\u3092\u8FFD\u52A0\u3057\u3066\u304F\u3060\u3055\u3044");
  }
  return updates;
}
async function apply(root, inspected, feedback, checkCommand) {
  assert6(inspected.packageManager, "package manager\u3092\u9078\u629E\u3067\u304D\u307E\u305B\u3093");
  assert6(feedback, "--feedback-command\u306B\u8A3A\u65AD\u7528\u30B3\u30DE\u30F3\u30C9\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const check = checkCommand ?? (inspected.scripts.check !== undefined ? `${inspected.packageManager} run check` : undefined);
  assert6(check, "\u5168\u4F53check\u304C\u672A\u6307\u5B9A\u3067\u3059\u3002--check-command\u306B\u5168\u4F53check\u306E\u30B3\u30DE\u30F3\u30C9\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const config = readConfig(root);
  const retryCommand = [
    process.execPath,
    ...process.execArgv,
    import.meta.path,
    "apply",
    "--repo",
    root,
    "--feedback-command",
    feedback,
    "--check-command",
    check
  ].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
  const run = commandRunner(join3(import.meta.dir, "runtime.mjs"), retryCommand);
  await classification(root, config, run);
  const commands = { ...runtimeCommands(config), "check:feedback": feedback };
  for (const [name, command] of Object.entries(commands)) {
    assert6(inspected.scripts[name] === undefined || inspected.scripts[name] === command, `\u65E2\u5B58\u30B3\u30DE\u30F3\u30C9\u3068\u885D\u7A81\u3057\u3066\u3044\u307E\u3059: ${name}`);
  }
  const { updates, conflicts } = planGeneratedFiles(root, generatedFiles(config, inspected.packageManager), "apply");
  assert6(conflicts.length === 0, `\u914D\u7F6E\u6E08\u307F\u30D5\u30A1\u30A4\u30EB\u3068\u885D\u7A81\u3057\u3066\u3044\u307E\u3059: ${conflicts.join(", ")}`);
  const nextPackage = { ...inspected.pkg, scripts: { ...inspected.scripts, ...commands } };
  if (JSON.stringify(nextPackage) !== JSON.stringify(inspected.pkg)) {
    updates.set("package.json", `${JSON.stringify(nextPackage, null, 2)}
`);
  }
  for (const [path, body] of planAgentInstructions(root, inspected.packageManager, check)) {
    updates.set(path, body);
  }
  console.log(JSON.stringify({ scripts: commands }));
  writeFiles(root, updates);
  console.log("\u88DC\u52A9\u30D5\u30A1\u30A4\u30EB\u3092\u914D\u7F6E\u3057\u307E\u3057\u305F");
  console.log("\u9759\u7684\u691C\u67FB\u30FB\u901A\u5E38check\u30FBCI\u306E\u63A5\u7D9A\u3001AGENTS.md\u306E\u65E2\u5B58\u6307\u793A\u3068\u306E\u7D71\u5408\u3068\u52D5\u4F5C\u78BA\u8A8D\u306F\u5C0E\u5165\u62C5\u5F53\u304C\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044");
}
async function compareTests(root, argv) {
  assert6(argv[0] === "bun" && argv.includes("test"), "--\u306E\u5F8C\u306Bbun test\u306Eargv\u304C\u5FC5\u8981\u3067\u3059");
  const config = readConfig(root);
  assert6(config.runner === "bun", "compare-tests\u306FBun\u3060\u3051\u3067\u4F7F\u7528\u3067\u304D\u307E\u3059");
  const run = commandRunner(join3(import.meta.dir, "runtime.mjs"), "setup.mjs compare-tests\u3092\u540C\u3058\u5F15\u6570\u3067\u518D\u5B9F\u884C");
  const { all } = await classification(root, config, run);
  const temp = mkdtempSync(join3(tmpdir(), "feedback-loop-compare-"));
  try {
    const report = join3(temp, "junit.xml");
    await run([...argv, "--reporter=junit", "--reporter-outfile", report], {
      cwd: root,
      captureStdout: true,
      allowFailure: true
    });
    const { suites } = readBunSuites(readFileSync2(report, "utf8"), root);
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
var usage = `\u4F7F\u3044\u65B9: bun setup.mjs <\u64CD\u4F5C> --repo <Git checkout\u306E\u7D76\u5BFE\u30D1\u30B9> [\u5F15\u6570]

\u64CD\u4F5C:
  inspect   \u69CB\u6210\u3092\u8ABF\u3079\u3066JSON\u3067\u8868\u793A\u3057\u307E\u3059\u3002\u30D5\u30A1\u30A4\u30EB\u306F\u5909\u66F4\u3057\u307E\u305B\u3093
  install   \u4E0D\u8DB3\u3059\u308B\u56FA\u5B9A\u7248\u306E\u4F9D\u5B58\u3092\u5C0E\u5165\u3057\u307E\u3059
            --package <oxlint|oxfmt|fallow>@<\u7248>\uFF08\u8907\u6570\u6307\u5B9A\u53EF\uFF09
  apply     .feedback-loop.json\u3092\u8AAD\u307F\u3001\u88DC\u52A9\u30D5\u30A1\u30A4\u30EB\u3068package scripts\u3092\u914D\u7F6E\u3057\u307E\u3059
            --feedback-command <check:feedback\u306B\u8A2D\u5B9A\u3059\u308B\u8A3A\u65AD\u7528\u30B3\u30DE\u30F3\u30C9>
            --check-command <AGENTS.md\u306B\u8A18\u8F09\u3059\u308B\u5168\u4F53check\u306E\u30B3\u30DE\u30F3\u30C9>\uFF08\u7701\u7565\u6642\u306Fcheck script\uFF09
            --update  \u5C0E\u5165\u6E08\u307F\u306E\u751F\u6210\u7269\u3092\u66F4\u65B0\u3057\u307E\u3059\u3002--feedback-command\u30FB--check-command\u3068\u306F\u4F75\u7528\u3057\u307E\u305B\u3093

  compare-tests  \u901A\u5E38check\u306EBun\u5B9F\u884C\u3068\u5206\u985E\u306E\u4E00\u89A7\u3092\u7167\u5408\u3057\u307E\u3059
                -- bun test [\u901A\u5E38check\u3068\u540C\u3058\u5F15\u6570]

\u5171\u901A:
  --repo <\u30D1\u30B9>   \u5BFE\u8C61Git checkout\u306E\u30EB\u30FC\u30C8\u306E\u7D76\u5BFE\u30D1\u30B9
  -h, --help      \u3053\u306E\u4E00\u89A7\u3092\u8868\u793A\u3057\u307E\u3059`;
function parseOptions(args) {
  const separator = args.indexOf("--");
  const testArgv = separator < 0 ? [] : args.splice(separator).slice(1);
  const values = new Map;
  for (let i = 0;i < args.length; i += 1) {
    const key = args[i];
    assert6(key, "\u7A7A\u306E\u5F15\u6570\u306F\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
    assert6(key === "--package" || !values.has(key), `${key}\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059`);
    const supplied = values.get(key) ?? [];
    values.set(key, supplied);
    if (key === "--update") {
      supplied.push("true");
    } else {
      supplied.push(args[i + 1]?.startsWith("-") ? "" : args[++i] ?? "");
    }
  }
  return { separator, testArgv, values };
}
async function setup([name = "", ...args]) {
  const { separator, testArgv, values } = parseOptions(args);
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
        const { pkg: _pkg, ...report } = inspect(repo);
        console.log(JSON.stringify(report, null, 2));
      }
    },
    install: {
      options: ["--repo", "--package"],
      run: (repo) => install(repo, inspect(repo), packages)
    },
    apply: {
      options: ["--repo", "--feedback-command", "--check-command"],
      run: (repo) => apply(repo, inspect(repo), feedback, checkCommand)
    },
    "apply --update": {
      options: ["--repo"],
      run: (repo) => update(repo, inspect(repo))
    },
    "compare-tests": {
      options: ["--repo"],
      testArgv: true,
      run: (repo) => compareTests(repo, testArgv)
    }
  };
  const operation = name === "apply" && values.delete("--update") ? "apply --update" : name;
  const definition = Object.hasOwn(operations, operation) && operations[operation];
  assert6(definition, "\u64CD\u4F5C\u306Finspect\u30FBinstall\u30FBapply\u30FBcompare-tests\u3067\u3059");
  for (const [key, supplied] of values) {
    assert6(definition.options.includes(key), `${operation}\u3067\u306F${key}\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093`);
    assert6(supplied.every((value) => value.trim()), `${key}\u306E\u5024\u304C\u3042\u308A\u307E\u305B\u3093`);
  }
  assert6(isAbsolute2(root), "--repo\u306BGit checkout\u306E\u7D76\u5BFE\u30D1\u30B9\u304C\u5FC5\u8981\u3067\u3059");
  assert6(separator < 0 || definition.testArgv, `${operation}\u3067\u306F--\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093`);
  const top = gitOutput(root, ["rev-parse", "--show-toplevel"]);
  assert6(top !== undefined, "--repo\u306FGit checkout\u306E\u30EB\u30FC\u30C8\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const repo = realpathSync2(root);
  assert6(realpathSync2(top) === repo, "--repo\u306FGit checkout\u306E\u30EB\u30FC\u30C8\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  await definition.run(repo);
}
try {
  assert6(versionAtLeast(process.versions.bun, "1.4.4"), `Bun ${"1.4.4"}\u4EE5\u4E0A\u3067\u8D77\u52D5\u3057\u3066\u304F\u3060\u3055\u3044\uFF08\u73FE\u5728: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.version}`}\uFF09`);
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  if (options.some((arg) => arg === "--help" || arg === "-h")) {
    console.log(usage);
    process.exit(0);
  }
  await setup(argv);
} catch (error) {
  console.error(`setup-feedback-loop\u672A\u5B8C\u4E86: ${errorMessage(error)}`);
  process.exitCode = 1;
}
