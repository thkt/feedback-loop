import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { errorMessage, isRecord } from '../../src/values.ts';

// 第1引数で解析を選ぶ。閾値と規則の有効・無効は.fallowrc.jsonに置く。
const analyses = new Map<string, readonly string[]>([
  [
    'dead-code',
    [
      '--unused-files',
      '--unused-exports',
      '--unused-types',
      '--unused-deps',
      '--circular-deps',
      '--fail-on-issues',
    ],
  ],
  ['health', ['--complexity']],
]);

// 失敗時に見つかった問題だけを出す。healthの関数一覧などは反復の診断に要らない。
function problems(analysis: string, report: Record<string, unknown>) {
  if (analysis === 'health') {
    return { findings: report.findings };
  }
  return Object.fromEntries(
    Object.entries(report).filter(
      ([key, value]) => key !== 'workspace_diagnostics' && Array.isArray(value) && value.length > 0,
    ),
  );
}

try {
  const analysis = process.argv[2] ?? '';
  const options = analyses.get(analysis);
  assert(options, `Unknown fallow analysis: ${analysis}`);
  const result = spawnSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve('fallow/bin/fallow'),
      analysis,
      ...options,
      '--format',
      'json',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  process.stderr.write(result.stderr ?? '');
  if (result.error) {
    throw result.error;
  }
  const report: unknown = result.stdout ? JSON.parse(result.stdout) : undefined;
  assert(
    isRecord(report) && report.kind === analysis && Array.isArray(report.workspace_diagnostics),
    `Invalid fallow ${analysis} report (${result.signal ?? result.status})`,
  );
  if (result.status !== 0) {
    console.log(JSON.stringify(problems(analysis, report), null, 2));
  }
  assert(result.status === 0, `fallow ${analysis} failed (${result.signal ?? result.status})`);
  assert(
    !report.workspace_diagnostics.some(
      (diagnostic: unknown) => isRecord(diagnostic) && diagnostic.degrades_analysis === true,
    ),
    'Incomplete fallow analysis: inspect workspace_diagnostics',
  );
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
