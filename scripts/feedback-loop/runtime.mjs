// 生成元: thkt/feedback-loop scripts/build.ts。直接編集せず、正本を変更して再生成してください
// src/runtime.ts
import assert8 from "node:assert/strict";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/classification.ts
import assert3 from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join as join2 } from "node:path";

// src/config.ts
import assert2 from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// src/values.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertObject(value) {
  assert(isRecord(value), "オブジェクトが必要です");
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
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

// src/config.ts
function assertStringArray(value) {
  assert2(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0), "文字列配列が必要です");
}
function assertRepoRelativePath(path) {
  assert2(!isAbsolute(path) && !path.split("/").includes("..") && !path.startsWith("./") && !path.includes("\\"), `repo相対パスが必要です: ${path}`);
}
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
  globalChanges: true,
  dependencies: true
};
function readConfig(root) {
  const value = JSON.parse(readFileSync(join(root, ".feedback-loop.json"), "utf8"));
  assertObject(value);
  const unknownKeys = Object.keys(value).filter((key) => !Object.hasOwn(configKeys, key));
  assert2(unknownKeys.length === 0, `.feedback-loop.jsonの未知のキーです: ${unknownKeys.join(", ")}`);
  assert2(value.runner === "bun" || value.runner === "vitest", "runnerはbunまたはvitestです");
  if (value.base !== undefined) {
    assert2(typeof value.base === "string" && value.base.trim().length > 0, "比較元baseが必要です");
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
    assert2(collect.length > 0, "収集コマンドは空にできません");
  }
  assertStringArray(testGlobs);
  assertStringArray(prepare);
  assertStringArray(testArgs);
  assertStringArray(globalChanges);
  assert2(testGlobs.length > 0, "テストglobは必須です");
  assert2(typeof allowSkipped === "boolean", "allowSkippedはbooleanです");
  assertStringArray(bunArgs);
  assert2(value.runner === "bun" || bunArgs.length === 0, "VitestにはbunArgsを指定できません");
  assert2(typeof bunWorkers === "number" && Number.isSafeInteger(bunWorkers) && bunWorkers > 0, "bunWorkersは正の安全な整数で指定してください");
  assert2(value.runner === "bun" || value.bunWorkers === undefined, "VitestにはbunWorkersを指定できません");
  if (value.runner === "bun") {
    assert2(![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)), "Bunの隔離は固定です。並列数はbunWorkersで指定してください");
  }
  assert2(Array.isArray(assuranceValue), "assurance配列が必要です");
  const assurance = assuranceValue.map((item) => {
    assertObject(item);
    assert2(typeof item.path === "string" && typeof item.reason === "string" && item.reason.trim().length > 0, "assuranceにはpathと指定理由が必要です");
    assertRepoRelativePath(item.path);
    return { path: item.path, reason: item.reason };
  });
  assert2(Array.isArray(dependenciesValue), "dependencies配列が必要です");
  const dependencies = dependenciesValue.map((item) => {
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
var fullRunGlobs = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lock",
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
    assert3(found || config.collect !== undefined, `testGlobsの探索場所がありません: ${prefix}`);
    return found;
  }).flatMap((prefix) => filesUnder(root, prefix, config.collect === undefined));
  const expected = files.filter((path) => config.testGlobs.some((glob) => matches(path, glob))).sort();
  let actual;
  if (config.collect !== undefined) {
    const { stdout } = await run(config.collect, { cwd: root, captureStdout: true });
    const collected = JSON.parse(stdout);
    assertStringArray(collected);
    collected.forEach(assertRepoRelativePath);
    assert3(new Set(collected).size === collected.length, "収集結果が重複しています");
    actual = collected;
  } else {
    actual = files.filter((path) => !path.split("/").some((part) => part.startsWith(".")) && /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(path)).sort();
  }
  assert3(JSON.stringify([...actual].sort()) === JSON.stringify(expected), `通常収集とtestGlobsの集合が一致しません
collect=${JSON.stringify(actual)}
glob=${JSON.stringify(expected)}`);
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert3(assurance.size === config.assurance.length, "assurance指定が重複しています");
  assert3([...assurance].every((path) => expected.includes(path)), "assuranceに存在しないテストか集合外の指定があります");
  assert3(config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))), "依存対応に集合外のテストがあります");
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance]
  };
}

// src/bun.ts
import assert5 from "node:assert/strict";
import { existsSync as existsSync4 } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join as join5 } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

// src/selection.ts
import { existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";
async function selectQuality(root, config, quality, changed, source) {
  const changes = changed.map((path) => {
    const targets = [...quality.includes(path) ? [path] : [], ...mappedTests(path, config)];
    return { path, targets: targets.filter((test) => quality.includes(test)) };
  });
  const fullRun = changes.filter(({ path }) => requiresFullRun(path, config) || config.runner === "vitest" && !existsSync2(join3(root, path))).map(({ path }) => path);
  const reachability = await source.reach(changes, fullRun.length > 0);
  const selected = new Set(reachability?.always);
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

// src/records.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join as join4, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
function recordsPath(root) {
  return join4(root, ".feedback-loop-records", "records.json");
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
function openRecords(root, changed, testFiles) {
  const path = recordsPath(root);
  const loaded = readDependencyRecords(path);
  const digests = new Map;
  const hash = (file) => digest(root, file, digests);
  const basis = sourceBasis(root, hash);
  const usable = loaded.kind === "valid" ? validatedRecords(loaded.entries, changed, testFiles, hash, basis) : { records: new Map, warning: loadWarning(path, loaded) };
  return {
    ...usable,
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
      writeRecords(path, entries);
    }
  };
}
function loadWarning(path, loaded) {
  switch (loaded.kind) {
    case "missing":
      return;
    case "unreadable":
      return `${path} を読めないため、記録なしとして扱います: ${errorMessage(loaded.error)}`;
    case "invalid":
      return `${path} の形が不正なため、記録なしとして扱います`;
  }
}
function digest(root, path, digests) {
  const cached = digests.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const absolute = resolve2(root, path);
  const hash = existsSync3(absolute) ? sha256(readFileSync2(absolute)) : "missing";
  digests.set(path, hash);
  return hash;
}
function sourceBasis(root, hash) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) {
    throw new Error(`記録の基点を取得できません: ${head.stderr}`);
  }
  return JSON.stringify([
    head.stdout.trim(),
    process.version,
    process.versions.bun,
    ...[
      fileURLToPath(import.meta.url),
      join4(dirname(fileURLToPath(import.meta.url)), "record-modules.ts")
    ].map(hash),
    ...[
      ".feedback-loop.json",
      "bunfig.toml",
      "package.json",
      "bun.lock",
      "package-lock.json",
      "pnpm-lock.yaml"
    ].map(hash)
  ]);
}
function validatedRecords(entries, changed, testFiles, hash, basis) {
  try {
    const accounted = new Set(changed);
    const current = new Set(testFiles);
    const relevant = [...entries].filter(([file]) => current.has(file));
    const valid = new Map(relevant.filter(([, entry]) => entry.basis === basis && Object.entries(entry.files).every(([module, recorded]) => accounted.has(module) || recorded === hash(module))).map(([file, entry]) => [file, new Set(Object.keys(entry.files))]));
    return valid.size === relevant.length ? { records: valid, warning: undefined } : { records: new Map, warning: "古い、または基点不明の依存記録は採用せず全件へ広げます" };
  } catch (error) {
    return { records: new Map, warning: `依存記録の入力を確認できません: ${String(error)}` };
  }
}
function writeRecords(path, entries) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join4(directory, ".gitignore"), `*
`);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 2, tests: Object.fromEntries(entries) }, null, 2)}
`);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

// src/bun-report.ts
import assert4 from "node:assert/strict";
function elements(node, name) {
  return node.children.filter((child) => typeof child !== "string" && ("name" in child) && child.name === name);
}
function testcases(node) {
  return [...elements(node, "testcase"), ...elements(node, "testsuite").flatMap(testcases)];
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
function readBunSuites(text, root) {
  const report = Bun.XML.parse(text, { compact: false });
  assert4(report.name === "testsuites", "Bun JUnitのrootがありません");
  const suites = new Map;
  for (const suite of elements(report, "testsuite")) {
    const file = suite.attributes.file;
    assert4(file && file.trim(), "JUnitのテストファイルがありません");
    const owner = repoPath(root, file);
    assert4(!suites.has(owner), `JUnitのファイルが重複しています: ${file}`);
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
    assert4(candidates.has(owner), `JUnitに候補外のファイルがあります: ${file}`);
    const summary = counts(suite, allowSkipped);
    const cases = testcases(suite);
    assert4(cases.length === summary.tests, `JUnitのファイル別件数が一致しません: ${file}`);
    let skippedCases = 0;
    for (const item of cases) {
      assert4(item.attributes.file && repoPath(root, item.attributes.file) === owner, `JUnitのtestcaseのファイルが一致しません: ${file}`);
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

// src/bun.ts
function bunRecordUpdates(states, succeeded) {
  const ran = new Map;
  const failed = [];
  for (const [file, state] of states) {
    switch (state.status) {
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
function recorderModule(value) {
  assertObject(value);
  assert5(typeof value.recorderEnv === "function" && typeof value.readRecords === "function", "記録器を読み込めません");
}
function hasNoChangedTests(comparison, report, recorded, stderr) {
  return comparison !== undefined && !existsSync4(report) && recorded.size === 0 && /^--changed: (?:\d+ changed files?, but no test files are affected|no changed files, nothing to run)\r?$/m.test(stripVTControlCharacters(stderr));
}
async function runBunBatch({ root, config, run }, batch) {
  const candidates = new Set(batch.files);
  const report = join5(batch.dir, "results.xml");
  const recordDir = join5(batch.dir, "records");
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
  const { stderr } = await run(argv, {
    env: batch.recorder.recorderEnv(process.env, recordDir, batch.recorderFile)
  });
  const recorded = new Map([...await batch.recorder.readRecords(recordDir)].map(([owner, modules]) => [
    repoPath(root, owner),
    new Set([...modules].map((path) => repoPath(root, path)))
  ]));
  const results = hasNoChangedTests(batch.comparison, report, recorded, stderr) ? new Map : readBunReport(await readFile(report, "utf8"), root, candidates, config.allowSkipped);
  assert5(recorded.size === results.size && [...recorded.keys()].every((file) => results.has(file)), "読み込んだテストとJUnitのファイル集合が一致しません");
  assert5(batch.comparison !== undefined || results.size === candidates.size, "指定したテストの結果が欠落しています");
  return new Map([...results].map(([owner, count]) => {
    const modules = recorded.get(owner);
    assert5(modules, `完了したテストの依存記録がありません: ${owner}`);
    return [owner, { count, modules }];
  }));
}
async function runBunTests(ctx) {
  const { root, config, comparison, quality, changed } = ctx;
  const { records, warning, save: saveRecords } = openRecords(root, changed, quality);
  const selected = await selectQuality(root, config, quality, changed, {
    warning,
    missingRecords: records.size === 0,
    async reach(changes) {
      const inputsByTest = new Map(records);
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
  if (selected.all) {
    console.log(`quality全件の理由: ${selected.reasons.join(", ")}`);
  }
  const dir = await mkdtemp(join5(tmpdir(), "feedback-loop-"));
  const recorderFile = join5(root, "scripts/feedback-loop/record-modules.ts");
  const recorder = await import(pathToFileURL(recorderFile).href);
  recorderModule(recorder);
  const states = new Map;
  let succeeded = false;
  try {
    const runBatch = async (files, changed, index) => {
      for (const file of files) {
        states.set(file, { status: "running" });
      }
      const results = await runBunBatch(ctx, {
        files,
        comparison: changed ? comparison : undefined,
        dir: join5(dir, String(index)),
        recorderFile,
        recorder
      });
      for (const file of files) {
        const result = results.get(file);
        states.set(file, result === undefined ? { status: "excluded" } : result.count > 0 ? { status: "passed", modules: result.modules } : { status: "skipped" });
      }
    };
    await runBatch(quality, !selected.all, 0);
    if (!selected.all) {
      const remaining = selected.files.filter((file) => states.get(file)?.status === "excluded");
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
    saveRecords(bunRecordUpdates(states, succeeded));
    await rm(dir, { recursive: true, force: true });
  }
}

// src/vitest.ts
import assert6 from "node:assert/strict";
import { dirname as dirname2, join as join6 } from "node:path";
import { readFileSync as readFileSync3 } from "node:fs";
import { mkdtemp as mkdtemp2, readFile as readFile2, rm as rm2 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL as pathToFileURL2 } from "node:url";
function vitestAPI(value) {
  assertObject(value);
  assert6(typeof value.parseCLI === "function" && typeof value.createVitest === "function", "導入版Vitestの公開収集APIを利用できません");
}
async function selectVitest(root, config, quality, changed, outside, apiPath, exclude) {
  return selectQuality(root, config, quality, changed, {
    async reach(changes, fullRunKnown) {
      if (fullRunKnown) {
        return;
      }
      const reached = new Map;
      const always = [];
      const inside = changes.map(({ path }) => path).filter((path) => !quality.includes(path));
      const pending = [...inside, ...outside];
      if (pending.length === 0) {
        return { reached, always };
      }
      const api = await import(pathToFileURL2(apiPath).href);
      vitestAPI(api);
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
        const targetsOf = async (path) => {
          context.config.related = [join6(root, path)];
          const specs = await context.getRelevantTestSpecifications();
          const files = specs.map((spec) => repoPath(root, spec.moduleId));
          const targets = files.filter((file) => quality.includes(file));
          assert6(targets.length === files.length, `Vitestの到達先がquality集合と一致しません: ${files.filter((file) => !quality.includes(file)).join(", ")}`);
          return targets;
        };
        for (const path of inside) {
          reached.set(path, await targetsOf(path));
        }
        for (const path of outside) {
          always.push(...await targetsOf(path));
        }
      } finally {
        await context.close();
      }
      return { reached, always };
    }
  });
}
async function runVitestTests({
  root,
  config,
  quality,
  changed,
  outside,
  run
}) {
  const require2 = createRequire(join6(root, "package.json"));
  const packagePath = require2.resolve("vitest/package.json");
  const installed = JSON.parse(readFileSync3(packagePath, "utf8"));
  assertObject(installed);
  assertObject(installed.bin);
  assert6(typeof installed.bin.vitest === "string", "Vitestの公開CLIがありません");
  const cli = join6(dirname2(packagePath), installed.bin.vitest);
  const exclude = config.assurance.flatMap((entry) => ["--exclude", join6(root, entry.path)]);
  const selected = await selectVitest(root, config, quality, changed, outside, require2.resolve("vitest/node"), exclude);
  assert6(changed.length > 0 || selected.files.length > 0, "変更なし: テストを実行しません");
  assert6(selected.files.length > 0, "候補0件: Vitestの関連qualityがありません");
  const selection = selected.all ? ["run", ...quality] : ["related", ...selected.files, "--run"];
  if (selected.all) {
    console.log(`quality全件の理由: 設定変更、削除、または依存先不明: ${selected.reasons.join(", ")}`);
  }
  const dir = await mkdtemp2(join6(tmpdir2(), "feedback-vitest-"));
  try {
    const report = join6(dir, "results.json");
    await run([
      process.execPath,
      cli,
      ...selection,
      ...config.testArgs,
      ...exclude,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ]);
    const result = JSON.parse(await readFile2(report, "utf8"));
    assertObject(result);
    assert6(result.success === true && typeof result.numTotalTests === "number" && result.numTotalTests > 0, "Vitestが完了していません。候補0件または結果欠落");
    assert6(Array.isArray(result.testResults), "Vitestのファイル結果がありません");
    assert6(typeof result.numPassedTests === "number" && result.numPassedTests > 0, "未実行: Vitestで成功したテストがありません");
    if (!config.allowSkipped) {
      assert6(result.numPassedTests === result.numTotalTests, "未実行: Vitestにskipまたはtodoがあります");
    }
    const executed = result.testResults.map((item) => {
      assertObject(item);
      assert6(typeof item.name === "string", "Vitest結果のファイル名が不正です");
      return repoPath(root, item.name);
    });
    assert6(executed.length > 0 && executed.every((file) => quality.includes(file)), "Vitestの実行結果がquality集合と一致しません");
    const completed = new Set(executed);
    assert6(selected.files.every((file) => completed.has(file)), "Vitestの選択したテストの結果が欠落しています");
    console.log(`quality選択: ${completed.size}件（Vitestの実行結果）`);
  } finally {
    await rm2(dir, { recursive: true, force: true });
  }
}

// src/git.ts
import { execFile, spawnSync as spawnSync2 } from "node:child_process";
function gitOutput(root, args) {
  const result = spawnSync2("git", args, { cwd: root, encoding: "utf8" });
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
async function mergeBase(root, base) {
  return (await git(root, ["merge-base", base, "HEAD"])).trim();
}
async function changedFiles({
  root,
  comparison
}) {
  const [tracked, untracked, shown] = await Promise.all([
    git(root, ["diff", "--name-only", "--no-renames", "--relative", "-z", comparison]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(root, ["rev-parse", "--show-prefix"])
  ]);
  const changed = [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])];
  const prefix = shown.trim();
  if (prefix === "") {
    return { changed, outside: [] };
  }
  const all = await git(root, ["diff", "--name-only", "--no-renames", "-z", comparison]);
  const up = "../".repeat(prefix.split("/").filter(Boolean).length);
  return {
    changed,
    outside: nulSeparated(all).filter((path) => !path.startsWith(prefix)).map((path) => up + path)
  };
}

// src/command.ts
import assert7 from "node:assert/strict";
import { spawn } from "node:child_process";
function commandRunner(runtime, retryCommand) {
  return async (argv, options = {}) => {
    assert7(argv[0], "実行コマンドがありません");
    const {
      cwd = process.cwd(),
      env = process.env,
      captureStdout = false,
      allowFailure = false
    } = options;
    const log = captureStdout ? console.error : console.log;
    const operation = captureStdout ? "収集" : "実行";
    log(`${operation}: ${argv.join(" ")}; 再実行: ${retryCommand}`);
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
async function runMonitor() {
  assert7(process.connected && typeof process.send === "function", "内部の検査監視には親とのIPC接続が必要です");
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
  const { argv, env, allowFailure = false } = input;
  assert7(typeof allowFailure === "boolean");
  assert7(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string"));
  const environment = stringRecord(env);
  process.stderr.on("error", () => {
    process.exitCode = 1;
    if (process.connected) {
      process.disconnect?.();
    }
  });
  const [command, ...args] = argv;
  assert7(command, "実行コマンドがありません");
  await superviseCommand({
    command,
    args,
    options: {
      stdio: ["inherit", "inherit", "pipe"],
      cwd: process.cwd(),
      env: environment,
      detached: true,
      serialization: "json"
    },
    killAfterMs: 1000,
    monitorParent: true,
    allowFailure
  });
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
    assert7.fail(`子プロセスの終了を確認できません: ${String(failure.error)}`);
  }
  if (state.phase === "finished" && state.cancelled || result.signal !== null || !allowFailure && result.code !== 0) {
    assert7.fail(`検査失敗または取消: ${result.signal ?? result.code}`);
  }
  return output;
}
async function superviseCommand(command) {
  assert7(!command.monitorParent || process.connected, "検査の開始前に親との接続が切れました");
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
      assert7(child.stderr);
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

// src/runtime.ts
var run = commandRunner(fileURLToPath2(import.meta.url), `${"bun"} run test:affected`);
async function affected(root, config) {
  const changes = (async () => {
    const base = config.base ?? defaultBase(root);
    assert8(base, "比較元を決められません。.feedback-loop.jsonにbaseを指定してください: origin/HEADがなく、mainとmasterが両方あるか、どちらもありません");
    const comparison = await mergeBase(root, base);
    return { comparison, ...await changedFiles({ root, comparison }) };
  })();
  const [collected, compared] = await Promise.allSettled([
    classification(root, config, run),
    changes
  ]);
  if (collected.status === "rejected") {
    throw collected.reason;
  }
  if (compared.status === "rejected") {
    throw compared.reason;
  }
  const classes = collected.value;
  const { comparison, changed, outside } = compared.value;
  console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
  assert8(changed.length > 0 || config.runner === "vitest" && outside.length > 0, "変更なし: テストを実行しません");
  assert8(classes.quality.length > 0, "候補0件: qualityがありません");
  if (config.prepare.length > 0) {
    await run(config.prepare);
  }
  const ctx = { root, config, comparison, quality: classes.quality, changed, outside, run };
  await (config.runner === "bun" ? runBunTests : runVitestTests)(ctx);
  console.log("選択したqualityが成功しました。全体checkの成功ではありません");
}
try {
  const root = process.cwd();
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "execute-child") {
    await runMonitor();
  } else if (operation === "classification") {
    assert8(args.length === 0, `classificationは引数を取りません: ${args.join(" ")}`);
    console.log(JSON.stringify(await classification(root, readConfig(root), run), null, 2));
  } else {
    assert8(operation === "affected", "操作はclassificationまたはaffectedです");
    await affected(root, readConfig(root));
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${errorMessage(error)}`);
  process.exitCode = 1;
}
