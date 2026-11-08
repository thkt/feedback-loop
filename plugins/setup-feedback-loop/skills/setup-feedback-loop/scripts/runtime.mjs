// 生成元: thkt/feedback-loop scripts/feedback-loop/build.ts。直接編集せず、正本を変更して再生成してください
// scripts/feedback-loop/runtime.ts
import assert5 from "node:assert/strict";
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname as dirname2, join as join6 } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath as fileURLToPath2, pathToFileURL as pathToFileURL2 } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";

// scripts/feedback-loop/config.ts
import assert2 from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// scripts/shared/values.ts
import { createHash } from "node:crypto";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

// scripts/feedback-loop/command.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
function launchCommand(argv, runtime, retryCommand, options) {
  const log = options.captureStdout ? console.error : console.log;
  const operation = options.captureStdout ? "収集" : "実行";
  log(`${operation}: ${argv.join(" ")}; 再実行: ${retryCommand}`);
  const startupEnv = { ...options.env };
  delete startupEnv.BUN_OPTIONS;
  delete startupEnv.NODE_OPTIONS;
  return superviseCommand({
    command: process.execPath,
    args: [...process.versions.bun ? ["--no-env-file"] : [], runtime, "execute-child"],
    options: {
      stdio: ["inherit", options.captureStdout ? "pipe" : "inherit", "pipe", "ipc"],
      cwd: options.cwd,
      env: startupEnv,
      detached: true,
      serialization: "json"
    },
    message: { argv, env: options.env },
    monitorParent: false
  });
}
function monitorCommand(argv, options) {
  assert(process.connected, "検査の開始前に親との接続が切れました");
  const [command, ...args] = argv;
  assert(command, "実行コマンドがありません");
  return superviseCommand({
    command,
    args,
    options: {
      stdio: ["inherit", "inherit", "pipe"],
      cwd: options.cwd,
      env: options.env,
      detached: true,
      serialization: "json"
    },
    killAfterMs: 1000,
    monitorParent: true
  });
}
async function execute(argv, options) {
  assert(argv[0], "実行コマンドがありません");
  const commandOptions = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    captureStdout: options.captureStdout ?? false
  };
  return options.monitorParent ? monitorCommand(argv, commandOptions) : launchCommand(argv, options.runtime, options.retryCommand, commandOptions);
}
function clearCancellationTimer(state) {
  if (state.phase === "cancelling") {
    clearTimeout(state.timer);
  }
}
function commandResult(result, failure, state, output) {
  if ("error" in result) {
    throw result.error;
  }
  if (failure !== undefined) {
    assert.fail(`子プロセスの終了を確認できません: ${String(failure.error)}`);
  }
  if (state.phase === "finished" && state.cancelled || result.code !== 0) {
    assert.fail(`検査失敗または取消: ${result.signal ?? result.code}`);
  }
  return output;
}
async function superviseCommand(command) {
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
      child.once("error", (error) => done({ error }));
      child.once("close", (code, signal) => {
        transition({ type: "close" });
        done({ code, signal });
      });
      child.once("exit", () => stop(child, "SIGKILL"));
      assert(child.stderr);
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
    return commandResult(result, failure, state, { stdout, stderr });
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

// scripts/feedback-loop/config.ts
function assertObject(value) {
  assert2(isRecord(value), "オブジェクトが必要です");
}
function assertStringArray(value) {
  assert2(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0), "文字列配列が必要です");
}
function assertRepoRelativePath(path) {
  assert2(!isAbsolute(path) && !path.split("/").includes("..") && !path.startsWith("./") && !path.includes("\\"), `repo相対パスが必要です: ${path}`);
}
function readConfig(root) {
  const value = JSON.parse(readFileSync(join(root, ".feedback-loop.json"), "utf8"));
  assertObject(value);
  assert2(value.version === 1, "未対応の設定versionです");
  assert2(value.runner === "bun" || value.runner === "vitest", "runnerはbunまたはvitestです");
  assert2(typeof value.base === "string" && value.base.trim().length > 0, "比較元baseが必要です");
  const { collect, testGlobs, fullCheck, prepare, testArgs, globalChanges } = value;
  assertStringArray(collect);
  assertStringArray(testGlobs);
  assertStringArray(fullCheck);
  assertStringArray(prepare);
  assertStringArray(testArgs);
  assertStringArray(globalChanges);
  assert2(collect.length > 0 && fullCheck.length > 0 && testGlobs.length > 0, "収集・通常check・テストglobは必須です");
  const bunArgs = value.bunArgs === undefined ? [] : value.bunArgs;
  const allowSkipped = value.allowSkipped === undefined ? true : value.allowSkipped;
  assert2(typeof allowSkipped === "boolean", "allowSkippedはbooleanです");
  assertStringArray(bunArgs);
  assert2(value.runner === "bun" || bunArgs.length === 0, "VitestにはbunArgsを指定できません");
  const bunWorkers = value.bunWorkers === undefined ? 4 : value.bunWorkers;
  assert2(typeof bunWorkers === "number" && Number.isSafeInteger(bunWorkers) && bunWorkers > 0, "bunWorkersは正の安全な整数で指定してください");
  assert2(value.runner === "bun" || value.bunWorkers === undefined, "VitestにはbunWorkersを指定できません");
  if (value.runner === "bun") {
    assert2(![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)), "Bunの隔離は固定です。並列数はbunWorkersで指定してください");
  }
  assert2(Array.isArray(value.assurance), "assurance配列が必要です");
  const assurance = value.assurance.map((item) => {
    assertObject(item);
    assert2(typeof item.path === "string" && typeof item.reason === "string" && item.reason.trim().length > 0, "assuranceにはpathと指定理由が必要です");
    assertRepoRelativePath(item.path);
    return { path: item.path, reason: item.reason };
  });
  assert2(Array.isArray(value.dependencies), "dependencies配列が必要です");
  const dependencies = value.dependencies.map((item) => {
    assertObject(item);
    assertStringArray(item.inputs);
    assertStringArray(item.tests);
    assert2(item.inputs.length > 0 && item.tests.length > 0, "依存対応は空にできません");
    item.inputs.forEach(assertRepoRelativePath);
    item.tests.forEach(assertRepoRelativePath);
    return { inputs: item.inputs, tests: item.tests };
  });
  testGlobs.forEach(assertRepoRelativePath);
  globalChanges.forEach(assertRepoRelativePath);
  return {
    version: 1,
    runner: value.runner,
    base: value.base,
    collect,
    testGlobs,
    assurance,
    fullCheck,
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
var fullRunGlobs = [
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  ".feedback-loop.json",
  "scripts/feedback-loop/**"
];
function requiresFullRun(path, config) {
  return [...fullRunGlobs, ...config.globalChanges].some((glob) => matches(path, glob));
}
function mappedTests(path, config) {
  return config.dependencies.filter((entry) => entry.inputs.some((glob) => matches(path, glob))).flatMap((entry) => entry.tests);
}
function assuranceExcludes(root, config) {
  return config.assurance.flatMap((entry) => ["--exclude", join(root, entry.path)]);
}
function repoPath(root, path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
function filesUnder(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.name === ".git" || entry.name === "node_modules") {
      return [];
    }
    return entry.isDirectory() ? filesUnder(root, `${path}/`) : entry.isFile() ? [path] : [];
  });
}
async function classification(root, config, runtime, retryCommand) {
  const expected = filesUnder(root).filter((path) => config.testGlobs.some((glob) => matches(path, glob))).sort();
  const { stdout } = await execute(config.collect, {
    runtime,
    cwd: root,
    captureStdout: true,
    retryCommand
  });
  const actual = JSON.parse(stdout);
  assertStringArray(actual);
  actual.forEach(assertRepoRelativePath);
  assert2(new Set(actual).size === actual.length, "収集結果が重複しています");
  assert2(JSON.stringify([...actual].sort()) === JSON.stringify(expected), `通常収集とtestGlobsの集合が一致しません
collect=${JSON.stringify(actual)}
glob=${JSON.stringify(expected)}`);
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert2(assurance.size === config.assurance.length, "assurance指定が重複しています");
  assert2([...assurance].every((path) => expected.includes(path)), "assuranceに存在しないテストか集合外の指定があります");
  assert2(config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))), "依存対応に集合外のテストがあります");
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance]
  };
}

// scripts/feedback-loop/vitest.ts
import assert3 from "node:assert/strict";
import { join as join5 } from "node:path";
import { pathToFileURL } from "node:url";

// scripts/feedback-loop/selection.ts
import { existsSync as existsSync2 } from "node:fs";
import { join as join4 } from "node:path";

// scripts/test-runtime/affected.ts
import { spawnSync } from "node:child_process";
import { join as join2 } from "node:path";
function selectAffected({ changed, testFiles, records }) {
  return {
    reached: new Map(changed.map((path) => [
      path,
      testFiles.includes(path) ? [path] : testFiles.filter((file) => records.get(file)?.has(path))
    ])),
    unrecorded: testFiles.filter((file) => !records.has(file))
  };
}
function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}
function nulSeparated(text) {
  return text.split("\x00").filter((path) => path !== "");
}
function mergeBase(root, base) {
  return git(root, ["merge-base", base, "HEAD"]).trim();
}
function changedFiles({ root, base }) {
  const comparison = mergeBase(root, base);
  const tracked = git(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--relative",
    "-z",
    comparison
  ]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])].map((path) => join2(root, path));
}

// scripts/test-runtime/affected-records.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync, mkdirSync, readFileSync as readFileSync2, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
function recordsPath(root) {
  return join3(root, ".feedback-loop-records", "records.json");
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
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.tests)) {
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
function loadRecords(root, changed, testFiles) {
  const path = recordsPath(root);
  const loaded = readDependencyRecords(path);
  switch (loaded.kind) {
    case "missing":
      return { records: new Map, warning: undefined };
    case "unreadable":
      return {
        records: new Map,
        warning: `${path} を読めないため、記録なしとして扱います: ${errorMessage(loaded.error)}`
      };
    case "invalid":
      return { records: new Map, warning: `${path} の形が不正なため、記録なしとして扱います` };
    case "valid":
      return validatedRecords(root, loaded.entries, changed, testFiles);
  }
}
function digest(path, digests) {
  const cached = digests.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const hash = existsSync(path) ? sha256(readFileSync2(path)) : "missing";
  digests.set(path, hash);
  return hash;
}
function sourceBasis(root, digests) {
  const head = spawnSync2("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) {
    throw new Error(`記録の基点を取得できません: ${head.stderr}`);
  }
  return JSON.stringify([
    head.stdout.trim(),
    process.version,
    process.versions.bun,
    ...[
      ...new Set([
        fileURLToPath(import.meta.url),
        ...["affected-records.ts", "affected.ts", "record-modules.ts"].map((name) => join3(dirname(fileURLToPath(import.meta.url)), name))
      ])
    ].map((path) => digest(path, digests)),
    ...[
      ".feedback-loop.json",
      "bunfig.toml",
      "package.json",
      "bun.lock",
      "bun.lockb",
      "package-lock.json"
    ].map((name) => digest(join3(root, name), digests))
  ]);
}
function validatedRecords(root, entries, changed, testFiles) {
  try {
    const digests = new Map;
    const basis = sourceBasis(root, digests);
    const accounted = new Set(changed);
    const current = new Set(testFiles);
    const relevant = [...entries].filter(([file]) => current.has(file));
    const valid = new Map(relevant.filter(([, entry]) => entry.basis === basis && Object.entries(entry.files).every(([module, hash]) => accounted.has(module) || hash === digest(module, digests))).map(([file, entry]) => [file, new Set(Object.keys(entry.files))]));
    return valid.size === relevant.length ? { records: valid, warning: undefined } : { records: new Map, warning: "古い、または基点不明の依存記録は採用せず全件へ広げます" };
  } catch (error) {
    return { records: new Map, warning: `依存記録の基点を確認できません: ${String(error)}` };
  }
}
function saveRecords({ root, ran, failed }) {
  const path = recordsPath(root);
  const loaded = readDependencyRecords(path);
  if (loaded.kind === "unreadable") {
    throw loaded.error;
  }
  const entries = loaded.kind === "valid" ? loaded.entries : new Map;
  const digests = new Map;
  const basis = sourceBasis(root, digests);
  for (const [file, modules] of ran) {
    entries.set(file, {
      basis,
      files: Object.fromEntries([...modules].sort().map((module) => [module, digest(module, digests)]))
    });
  }
  for (const file of failed) {
    entries.delete(file);
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join3(directory, ".gitignore"), `*
`);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, tests: Object.fromEntries(entries) }, null, 2)}
`);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

// scripts/feedback-loop/selection.ts
async function selectQuality(root, config, quality, changed, source) {
  const changes = changed.map((file) => {
    const path = repoPath(root, file);
    const targets = [...quality.includes(path) ? [path] : [], ...mappedTests(path, config)];
    return { path, targets: targets.filter((test) => quality.includes(test)) };
  });
  const fullRun = changes.filter(({ path }) => requiresFullRun(path, config) || config.runner === "vitest" && !existsSync2(join4(root, path))).map(({ path }) => path);
  const reachability = await source.reach(changes, fullRun.length > 0);
  const selected = new Set(reachability?.unrecorded);
  const unreached = [];
  for (const { path, targets } of changes) {
    const reached = [...targets, ...reachability?.reached.get(path) ?? []];
    if (reached.length === 0 && reachability !== undefined && !fullRun.includes(path)) {
      unreached.push(path);
    }
    reached.forEach((file) => selected.add(file));
  }
  const reasons = [
    ...fullRun,
    ...source.warning === undefined ? [] : [source.warning],
    ...unreached,
    ...source.missingRecords ? ["信頼できる依存記録なし"] : []
  ];
  const all = reasons.length > 0;
  return { all, reasons, files: all ? quality : quality.filter((file) => selected.has(file)) };
}
function selectBunQuality(root, config, quality, changed) {
  const testFiles = quality.map((path) => join4(root, path));
  const { records, warning } = loadRecords(root, changed, testFiles);
  return selectQuality(root, config, quality, changed, {
    warning,
    missingRecords: records.size === 0,
    async reach(changes) {
      const inputsByTest = new Map(records);
      for (const { path, targets } of changes) {
        for (const test of targets) {
          const file = join4(root, test);
          inputsByTest.set(file, new Set([...inputsByTest.get(file) ?? [], join4(root, path)]));
        }
      }
      const result = selectAffected({ changed, testFiles, records: inputsByTest });
      return {
        reached: new Map([...result.reached].map(([path, files]) => [
          repoPath(root, path),
          files.map((file) => repoPath(root, file))
        ])),
        unrecorded: result.unrecorded.map((file) => repoPath(root, file))
      };
    }
  });
}

// scripts/feedback-loop/vitest.ts
function vitestAPI(value) {
  assertObject(value);
  assert3(typeof value.parseCLI === "function" && typeof value.createVitest === "function", "導入版Vitestの公開収集APIを利用できません");
}
async function selectVitest(root, config, quality, changed, apiPath) {
  return selectQuality(root, config, quality, changed, {
    async reach(changes, fullRunKnown) {
      if (fullRunKnown) {
        return;
      }
      const reached = new Map;
      const pending = changes.map(({ path }) => path).filter((path) => !quality.includes(path));
      if (pending.length === 0) {
        return { reached, unrecorded: [] };
      }
      const api = await import(pathToFileURL(apiPath).href);
      vitestAPI(api);
      const exclude = assuranceExcludes(root, config);
      const parsed = api.parseCLI([
        "vitest",
        "related",
        ...pending,
        ...config.testArgs,
        ...exclude,
        "--run"
      ]);
      const context = await api.createVitest("test", { ...parsed.options, watch: false });
      try {
        for (const path of pending) {
          context.config.related = [join5(root, path)];
          const specs = await context.getRelevantTestSpecifications();
          const files = specs.map((spec) => repoPath(root, spec.moduleId));
          const targets = files.filter((file) => quality.includes(file));
          assert3(targets.length === files.length, `Vitestの到達先がquality集合と一致しません: ${files.filter((file) => !quality.includes(file)).join(", ")}`);
          reached.set(path, targets);
        }
      } finally {
        await context.close();
      }
      return { reached, unrecorded: [] };
    }
  });
}

// scripts/feedback-loop/bun-report.ts
import assert4 from "node:assert/strict";
import { resolve } from "node:path";
function elements(node, name) {
  return node.children.filter((child) => typeof child !== "string" && ("name" in child) && child.name === name);
}
function count(node, name, fallback) {
  const value = node.attributes[name] ?? fallback;
  assert4(value !== undefined && /^\d+$/.test(value), `JUnitの${name}が不正です`);
  const result = Number(value);
  assert4(Number.isSafeInteger(result), `JUnitの${name}が不正です`);
  return result;
}
function counts(node, allowSkipped) {
  const tests = count(node, "tests");
  const skipped = count(node, "skipped");
  assert4(tests > 0 && skipped <= tests, "JUnitの完了件数が不正または0件です");
  assert4(allowSkipped || skipped === 0, "許可されていないskipがあります");
  assert4(count(node, "failures") === 0 && count(node, "errors", "0") === 0, "JUnitに失敗が記録されています");
  return { tests, skipped };
}
function readBunReport(text, root, candidates, allowSkipped) {
  const report = Bun.XML.parse(text, { compact: false });
  assert4(report.name === "testsuites", "Bun JUnitのrootがありません");
  const total = counts(report, allowSkipped);
  const completed = new Map;
  let tests = 0;
  let skipped = 0;
  for (const suite of elements(report, "testsuite")) {
    const file = suite.attributes.file;
    assert4(file && file.trim(), "JUnitのテストファイルがありません");
    const owner = resolve(root, file);
    assert4(candidates.has(owner), `JUnitに候補外のファイルがあります: ${file}`);
    assert4(!completed.has(owner), `JUnitのファイルが重複しています: ${file}`);
    const summary = counts(suite, allowSkipped);
    const cases = elements(suite, "testcase");
    assert4(cases.length === summary.tests, `JUnitのファイル別件数が一致しません: ${file}`);
    let skippedCases = 0;
    for (const item of cases) {
      assert4(item.attributes.file && resolve(root, item.attributes.file) === owner, `JUnitのtestcaseのファイルが一致しません: ${file}`);
      assert4(elements(item, "failure").length === 0 && elements(item, "error").length === 0, `JUnitのtestcaseが失敗しています: ${file}`);
      if (elements(item, "skipped").length > 0) {
        skippedCases++;
      }
    }
    assert4(skippedCases === summary.skipped, `JUnitのskip件数が一致しません: ${file}`);
    tests += summary.tests;
    skipped += summary.skipped;
    completed.set(owner, summary.tests - summary.skipped);
  }
  assert4(tests === total.tests && skipped === total.skipped, "JUnitのファイル別件数と全体件数が一致しません");
  return completed;
}

// scripts/feedback-loop/bun-records.ts
function bunRecordUpdates(states, succeeded) {
  const ran = new Map;
  const failed = [];
  for (const [file, state] of states) {
    switch (state.status) {
      case "pending":
      case "excluded":
        break;
      case "passed":
        if (succeeded) {
          ran.set(file, state.modules);
        } else {
          failed.push(file);
        }
        break;
      case "running":
      case "skipped":
        failed.push(file);
        break;
    }
  }
  return { ran, failed };
}

// scripts/feedback-loop/runtime.ts
var runtime = fileURLToPath2(import.meta.url);
var retryCommand = `${"__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__"} run test:affected`;
function recorderModule(value) {
  assertObject(value);
  assert5(typeof value.recorderEnv === "function" && typeof value.readRecords === "function", "記録器を読み込めません");
}
function hasNoChangedTests(comparison, report, recorded, stderr) {
  return comparison !== undefined && !existsSync3(report) && recorded.size === 0 && /^--changed: (?:\d+ changed files?, but no test files are affected|no changed files, nothing to run)\r?$/m.test(stripVTControlCharacters(stderr));
}
async function runBunBatch(root, config, batch) {
  const candidates = new Set(batch.files.map((file) => join6(root, file)));
  const report = join6(batch.dir, "results.xml");
  const recordDir = join6(batch.dir, "records");
  await mkdir(recordDir, { recursive: true });
  const argv = [
    process.versions.bun ? process.execPath : "bun",
    ...config.bunArgs,
    "test",
    ...batch.files.map((file) => `./${file}`),
    ...config.testArgs,
    "--no-orphans",
    "--isolate",
    `--parallel=${config.bunWorkers}`,
    "--reporter=junit",
    "--reporter-outfile",
    report,
    ...batch.comparison === undefined ? [] : [`--changed=${batch.comparison}`]
  ];
  const { stderr } = await execute(argv, {
    runtime,
    retryCommand,
    env: batch.recorder.recorderEnv(process.env, recordDir, batch.recorderFile)
  });
  const recorded = await batch.recorder.readRecords(recordDir);
  const results = hasNoChangedTests(batch.comparison, report, recorded, stderr) ? new Map : readBunReport(await readFile(report, "utf8"), root, candidates, config.allowSkipped);
  assert5(recorded.size === results.size && [...recorded.keys()].every((file) => results.has(file)), "読み込んだテストとJUnitのファイル集合が一致しません");
  assert5(batch.comparison !== undefined || results.size === candidates.size, "指定したテストの結果が欠落しています");
  return new Map([...results].map(([owner, count]) => {
    const modules = recorded.get(owner);
    assert5(modules, `完了したテストの依存記録がありません: ${owner}`);
    return [owner, { count, modules }];
  }));
}
async function bunTests(root, config, quality, changed) {
  const selected = await selectBunQuality(root, config, quality, changed);
  if (selected.all) {
    console.log(`quality全件の理由: ${selected.reasons.join(", ")}`);
  }
  const comparison = mergeBase(root, config.base);
  const dir = await mkdtemp(join6(tmpdir(), "feedback-loop-"));
  const recorderFile = join6(root, "scripts/feedback-loop/record-modules.ts");
  const recorder = await import(pathToFileURL2(recorderFile).href);
  recorderModule(recorder);
  const states = new Map(quality.map((file) => [join6(root, file), { status: "pending" }]));
  let succeeded = false;
  try {
    const runBatch = async (files, changed, index) => {
      for (const file of files) {
        states.set(join6(root, file), { status: "running" });
      }
      const results = await runBunBatch(root, config, {
        files,
        comparison: changed ? comparison : undefined,
        dir: join6(dir, String(index)),
        recorderFile,
        recorder
      });
      for (const file of files) {
        const owner = join6(root, file);
        const result = results.get(owner);
        states.set(owner, result === undefined ? { status: "excluded" } : result.count > 0 ? { status: "passed", modules: result.modules } : { status: "skipped" });
      }
    };
    await runBatch(quality, !selected.all, 0);
    if (!selected.all) {
      const remaining = selected.files.filter((file) => states.get(join6(root, file))?.status === "excluded");
      if (remaining.length > 0) {
        await runBatch(remaining, false, 1);
      }
    }
    const results = [...states.values()].filter((state) => state.status === "passed" || state.status === "skipped");
    console.log(`quality選択: ${results.length}件（Bunの実行結果と補完依存の和集合）`);
    assert5(results.length > 0, "候補0件: 関連テストがありません");
    assert5(results.some((state) => state.status === "passed"), "未実行: 選択したテストがすべてskipされています");
    succeeded = true;
  } finally {
    saveRecords({ root, ...bunRecordUpdates(states, succeeded) });
    await rm(dir, { recursive: true, force: true });
  }
}
async function vitestTests(root, config, quality, changed) {
  const require2 = createRequire(join6(root, "package.json"));
  const packagePath = require2.resolve("vitest/package.json");
  const installed = JSON.parse(readFileSync3(packagePath, "utf8"));
  assertObject(installed);
  assertObject(installed.bin);
  assert5(typeof installed.bin.vitest === "string", "Vitestの公開CLIがありません");
  const cli = join6(dirname2(packagePath), installed.bin.vitest);
  const selected = await selectVitest(root, config, quality, changed, require2.resolve("vitest/node"));
  assert5(selected.files.length > 0, "候補0件: Vitestの関連qualityがありません");
  const exclude = assuranceExcludes(root, config);
  const selection = selected.all ? ["run", ...quality] : ["related", ...selected.files, "--run"];
  if (selected.all) {
    console.log(`quality全件の理由: 設定変更、削除、または依存先不明: ${selected.reasons.join(", ")}`);
  }
  const dir = await mkdtemp(join6(tmpdir(), "feedback-vitest-"));
  try {
    const report = join6(dir, "results.json");
    await execute([
      process.execPath,
      cli,
      ...selection,
      ...config.testArgs,
      ...exclude,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ], { runtime, retryCommand });
    const result = JSON.parse(await readFile(report, "utf8"));
    assertObject(result);
    assert5(result.success === true && typeof result.numTotalTests === "number" && result.numTotalTests > 0, "Vitestが完了していません。候補0件または結果欠落");
    assert5(Array.isArray(result.testResults), "Vitestのファイル結果がありません");
    assert5(typeof result.numPassedTests === "number" && result.numPassedTests > 0, "未実行: Vitestで成功したテストがありません");
    if (!config.allowSkipped) {
      assert5(result.numPassedTests === result.numTotalTests, "未実行: Vitestにskipまたはtodoがあります");
    }
    const executed = result.testResults.map((item) => {
      assertObject(item);
      assert5(typeof item.name === "string", "Vitest結果のファイル名が不正です");
      return repoPath(root, item.name);
    });
    assert5(executed.length > 0 && executed.every((file) => quality.includes(file)), "Vitestの実行結果がquality集合と一致しません");
    const completed = new Set(executed);
    assert5(selected.files.every((file) => completed.has(file)), "Vitestの選択したテストの結果が欠落しています");
    console.log(`quality選択: ${new Set(executed).size}件（Vitestの実行結果）`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function executeChild() {
  assert5(process.connected && typeof process.send === "function", "内部の検査監視には親とのIPC接続が必要です");
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
  const { argv, env } = input;
  assert5(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string"));
  assertObject(env);
  const environment = {};
  for (const [key, value] of Object.entries(env)) {
    assert5(typeof value === "string");
    environment[key] = value;
  }
  process.stderr.on("error", () => {
    process.exitCode = 1;
    if (process.connected) {
      process.disconnect?.();
    }
  });
  await execute(argv, { runtime, env: environment, monitorParent: true });
}
async function runAffected(root, config, classes) {
  const changed = changedFiles({ root, base: config.base });
  console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
  assert5(changed.length > 0, "変更なし: テストを実行しません");
  assert5(classes.quality.length > 0, "候補0件: qualityがありません");
  if (config.prepare.length > 0) {
    await execute(config.prepare, { runtime, retryCommand });
  }
  if (config.runner === "bun") {
    await bunTests(root, config, classes.quality, changed);
  } else {
    await vitestTests(root, config, classes.quality, changed);
  }
  console.log("選択したqualityが成功しました。全体checkの成功ではありません");
}
try {
  const root = process.cwd();
  const operation = process.argv[2];
  if (operation === "execute-child") {
    await executeChild();
  } else {
    assert5(operation === "classification" || operation === "affected", "操作はclassificationまたはaffectedです");
    if (operation === "classification") {
      const args = process.argv.slice(3);
      assert5(args.length === 0, `classificationは引数を取りません: ${args.join(" ")}`);
    }
    const config = readConfig(root);
    const classes = await classification(root, config, runtime, retryCommand);
    if (operation === "classification") {
      console.log(JSON.stringify(classes, null, 2));
    } else {
      await runAffected(root, config, classes);
    }
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
