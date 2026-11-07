import { applyFeedback } from '../../support/feedback-loop-batch.ts';
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import {
  type Fixture,
  config as baseConfig,
  files as baseFiles,
  fixture,
  header,
  run,
} from '../../support/feedback-loop-batch.ts';
import { git } from '../../support/runner-affected.ts';

// references/contract.mdの「分類の確認記録」と、
// check:classification・--completeの公開入口だけを期待値の根拠にする。
const reviewPath = '.feedback-loop-review.json';
const config = {
  ...baseConfig,
  assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放の確認' }],
};
const files = {
  ...baseFiles,
  '.feedback-loop.json': JSON.stringify(config),
  'test/a.test.ts':
    header +
    "import { value } from '../src/input.ts'; test('a', () => { console.log('QUALITY_A'); expect(value).toBeGreaterThan(0); });\n",
  'test/b.test.ts': header + "test('b', () => { console.log('QUALITY_B'); expect(1).toBe(1); });\n",
  'test/assurance.test.ts':
    header + "test('cleanup', () => { console.log('ASSURANCE_RAN'); expect(1).toBe(1); });\n",
};
const collected = ['test/a.test.ts', 'test/assurance.test.ts', 'test/b.test.ts'];
// 実行時の分類は.feedback-loop.jsonのassurance指定だけで決まる。
const classOf = (path: string) => (path === 'test/assurance.test.ts' ? 'assurance' : 'quality');

type ReviewEntry = { path: string; class: string; sha256: string; reason?: string };

async function sha256(f: Fixture, path: string) {
  return createHash('sha256')
    .update(await readFile(join(f.repo, path)))
    .digest('hex');
}

// 現在の内容から、全収集ファイルの確認済み記録を作る。
async function reviewedEntries(f: Fixture, paths = collected): Promise<ReviewEntry[]> {
  return Promise.all(
    paths.map(async (path) => {
      const entry: ReviewEntry = {
        path,
        class: classOf(path),
        sha256: await sha256(f, path),
      };
      if (entry.class === 'quality') {
        entry.reason = `${path}の公開した入出力を確認する`;
      }
      return entry;
    }),
  );
}

async function writeReview(f: Fixture, review: unknown) {
  await writeFile(
    join(f.repo, reviewPath),
    typeof review === 'string' ? review : JSON.stringify(review),
  );
}

function apply(f: Fixture) {
  const applied = applyFeedback(f, 'bun run test:affected', run);
  expect(applied.code, applied.output).toBe(0);
}

function classify(f: Fixture, complete = false) {
  return run(f, ['run', 'check:classification', ...(complete ? ['--', '--complete'] : [])]);
}

type ReviewFile = { path: string; class: unknown; sha256: unknown; status: unknown };

function reviewOf(stdout: string) {
  const parsed: unknown = JSON.parse(stdout);
  assert(isRecord(parsed), stdout);
  const review = parsed.review;
  assert(isRecord(review), `reviewがありません: ${stdout}`);
  assert(Array.isArray(review.files), stdout);
  const byPath = new Map<string, ReviewFile>();
  for (const file of review.files) {
    assert(isRecord(file) && typeof file.path === 'string', stdout);
    expect(byPath.has(file.path), `review.filesのpath重複: ${file.path}`).toBe(false);
    byPath.set(file.path, {
      path: file.path,
      class: file.class,
      sha256: file.sha256,
      status: file.status,
    });
  }
  // orphansの要素の形は公開仕様で固定されていないため、pathの文字列か{path}を受け付ける。
  assert(Array.isArray(review.orphans), `review.orphansがありません: ${stdout}`);
  const orphans = review.orphans.map((orphan: unknown) => {
    const path = isRecord(orphan) ? orphan.path : orphan;
    assert(typeof path === 'string', stdout);
    return path;
  });
  return { parsed, complete: review.complete, files: byPath, orphans };
}

function sorted(value: unknown) {
  assert(Array.isArray(value) && value.every((item) => typeof item === 'string'), String(value));
  return value.toSorted((x, y) => x.localeCompare(y));
}

async function expectStatuses(
  f: Fixture,
  stdout: string,
  statuses: Record<string, string>,
  orphans: string[] = [],
) {
  const review = reviewOf(stdout);
  const paths = sorted(Object.keys(statuses));
  // 従来のall・quality・assuranceも同じJSONに残る。
  expect(sorted(review.parsed.all)).toEqual(paths);
  expect(sorted(review.parsed.quality)).toEqual(paths.filter((p) => classOf(p) === 'quality'));
  expect(sorted(review.parsed.assurance)).toEqual(paths.filter((p) => classOf(p) === 'assurance'));
  expect(sorted([...review.files.keys()])).toEqual(paths);
  for (const [path, status] of Object.entries(statuses)) {
    expect(review.files.get(path), path).toEqual({
      path,
      // mismatchの行で記録側と実行側のどちらのclassを出すかは仕様で固定されていない。
      class: status === 'mismatch' ? review.files.get(path)?.class : classOf(path),
      sha256: await sha256(f, path),
      status,
    });
  }
  expect(sorted(review.orphans)).toEqual(sorted(orphans));
  expect(review.complete).toBe(
    orphans.length === 0 && Object.values(statuses).every((status) => status === 'reviewed'),
  );
}

test('staleとunreviewedのqualityは実行され続け、staleなassuranceは除外され続ける', async () => {
  await fixture(files, async (f) => {
    apply(f);
    // aとassuranceだけを記録し、bは未確認のままcommitする。
    const entries = await reviewedEntries(f, ['test/a.test.ts', 'test/assurance.test.ts']);
    await writeReview(f, { version: 1, files: entries });
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'partial review');
    for (const path of ['test/a.test.ts', 'test/assurance.test.ts'] as const) {
      await writeFile(join(f.repo, path), `${files[path]}// 確認後の変更\n`);
    }
    const changed = run(f, ['run', 'test:affected']);
    expect(changed.code, changed.output).toBe(0);
    expect(changed.output).toContain('QUALITY_A');
    expect(changed.output).not.toContain('ASSURANCE_RAN');

    await writeFile(join(f.repo, 'unknown.txt'), 'unmapped input');
    const widened = run(f, ['run', 'test:affected']);
    expect(widened.code, widened.output).toBe(0);
    expect(widened.output).toContain('QUALITY_A');
    expect(widened.output).toContain('QUALITY_B');
    expect(widened.output).not.toContain('ASSURANCE_RAN');

    const classified = classify(f);
    expect(classified.code, classified.output).toBe(0);
    await expectStatuses(f, classified.stdout, {
      'test/a.test.ts': 'stale',
      'test/assurance.test.ts': 'stale',
      'test/b.test.ts': 'unreviewed',
    });
  });
}, 60000);

test('check:feedbackに含めた分類検査は、確認が必要なテストを示して後段のテストを続け、記録の更新後は示さない', async () => {
  await fixture(files, async (f) => {
    const applied = applyFeedback(
      f,
      'bun run check:classification > /dev/null && bun run test:affected',
      run,
    );
    expect(applied.code, applied.output).toBe(0);
    expect(applied.output).toContain('AGENTS.mdの指示');
    await writeReview(f, { version: 1, files: await reviewedEntries(f) });
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'reviewed');
    await writeFile(join(f.repo, 'test/a.test.ts'), `${files['test/a.test.ts']}// 確認後の変更\n`);

    const stale = run(f, ['run', 'check:feedback']);
    expect(stale.code, stale.output).toBe(0);
    expect(stale.output).toContain('分類の確認記録が未完了です');
    expect(stale.output).toContain('stale: test/a.test.ts');
    expect(stale.output).toContain('QUALITY_A');
    expect(stale.stdout).not.toContain('"review"');

    await writeReview(f, { version: 1, files: await reviewedEntries(f) });
    const updated = run(f, ['run', 'check:feedback']);
    expect(updated.code, updated.output).toBe(0);
    expect(updated.output).not.toContain('分類の確認記録が未完了です');
    expect(updated.output).toContain('QUALITY_A');
  });
}, 60000);

test('確認記録の変更は関連選択の入力にならず、記録だけの変更は変更なしとしてテストを実行しない', async () => {
  await fixture(files, async (f) => {
    apply(f);
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'configured');
    // 公開入口の初回実行で依存記録を作る。
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const seeded = run(f, ['run', 'test:affected']);
    expect(seeded.code, seeded.output).toBe(0);

    const control = run(f, ['run', 'test:affected']);
    expect(control.code, control.output).toBe(0);
    expect(control.output).toContain('QUALITY_A');
    expect(control.output).not.toContain('QUALITY_B');
    expect(control.output).not.toContain('quality全件の理由:');

    await writeReview(f, { version: 1, files: await reviewedEntries(f) });
    expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toContain(reviewPath);
    const mixed = run(f, ['run', 'test:affected']);
    expect(mixed.code, mixed.output).toBe(0);
    expect(mixed.output).toContain('QUALITY_A');
    expect(mixed.output).not.toContain('QUALITY_B');
    expect(mixed.output).not.toContain('quality全件の理由:');
    expect(mixed.output).not.toContain('ASSURANCE_RAN');

    // 通常ソースを戻し、未追跡の記録だけが差分に残る状態と、追跡済み記録の変更だけの状態を確かめる。
    await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
    for (const stage of ['untracked', 'tracked-modified'] as const) {
      if (stage === 'tracked-modified') {
        git(f.repo, 'add', reviewPath);
        git(f.repo, 'commit', '-m', 'review record');
        const entries = await reviewedEntries(f);
        await writeReview(f, {
          version: 1,
          files: entries.map((e) =>
            e.path === 'test/b.test.ts' ? { ...e, reason: '確認理由を更新した' } : e,
          ),
        });
        expect(git(f.repo, 'diff', '--name-only')).toBe(reviewPath);
      } else {
        expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe(
          `?? ${reviewPath}`,
        );
      }
      const recordOnly = run(f, ['run', 'test:affected']);
      expect(recordOnly.code, `${stage}: ${recordOnly.output}`).not.toBe(0);
      expect(recordOnly.output).toContain('変更なし');
      for (const marker of ['QUALITY_A', 'QUALITY_B', 'ASSURANCE_RAN']) {
        expect(recordOnly.output, stage).not.toContain(marker);
      }
    }
  });
}, 60000);

test('applyは確認記録を作成・変更せず、記録の有無にかかわらず再applyが進む', async () => {
  await fixture(files, async (f) => {
    apply(f);
    expect(existsSync(join(f.repo, reviewPath))).toBe(false);
    // 未確認を含む構造上正しい記録を置いても、再applyはそれを書き換えない。
    const partial = JSON.stringify({
      version: 1,
      files: await reviewedEntries(f, ['test/a.test.ts']),
    });
    await writeReview(f, partial);
    apply(f);
    expect(await readFile(join(f.repo, reviewPath), 'utf8')).toBe(partial);
    const classified = classify(f);
    expect(classified.code, classified.output).toBe(0);
    expect(reviewOf(classified.stdout).complete).toBe(false);
  });
});

// 記録はcheck:classificationだけが読む。テストの削除・改名・分類変更で残った記録や、
// 不正な記録ファイルを理由にtest:affectedと再applyを止めない。
const scenarios = ['delete', 'rename', 'reclassify', 'invalid-json'] as const;

async function operate(f: Fixture, scenario: (typeof scenarios)[number]) {
  if (scenario === 'delete') {
    git(f.repo, 'rm', '-q', 'test/b.test.ts');
  } else if (scenario === 'rename') {
    git(f.repo, 'mv', 'test/b.test.ts', 'test/renamed.test.ts');
  } else if (scenario === 'reclassify') {
    await writeFile(
      join(f.repo, '.feedback-loop.json'),
      JSON.stringify({
        ...config,
        assurance: [...config.assurance, { path: 'test/b.test.ts', reason: '分類を変更した対照' }],
      }),
    );
  } else {
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
  }
}

type Scenario = (typeof scenarios)[number];

async function recordAndCommit(f: Fixture, scenario: Scenario, withRecord: boolean) {
  apply(f);
  if (withRecord) {
    await writeReview(
      f,
      scenario === 'invalid-json'
        ? '{"version":1,"files":['
        : { version: 1, files: await reviewedEntries(f) },
    );
  }
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-m', 'configured with review record');
}

function expectAffected(scenario: Scenario, output: string) {
  expect(output).not.toContain('ASSURANCE_RAN');
  // reclassifyではbがassuranceへ移るため実行しない。他の操作では残ったqualityを実行する。
  if (scenario === 'reclassify') {
    expect(output).not.toContain('QUALITY_B');
  } else {
    expect(output).toContain('QUALITY_A');
  }
  if (scenario === 'rename') {
    expect(output).toContain('QUALITY_B');
  }
}

// 記録を読むcheck:classificationだけが、残った記録を表示または拒否する。
function expectClassifiedAfter(f: Fixture, scenario: Scenario) {
  const daily = classify(f);
  if (scenario === 'invalid-json') {
    expect(daily.code, daily.output).not.toBe(0);
    expect(daily.output).toContain(reviewPath);
    return;
  }
  expect(daily.code, daily.output).toBe(0);
  const review = reviewOf(daily.stdout);
  if (scenario === 'reclassify') {
    expect(review.files.get('test/b.test.ts')?.status).toBe('mismatch');
  } else {
    expect(review.orphans).toEqual(['test/b.test.ts']);
  }
  expect(daily.stderr).toContain('test/b.test.ts');
  expect(review.complete).toBe(false);
  const complete = classify(f, true);
  expect(complete.code, complete.output).not.toBe(0);
  expect(complete.stderr).toContain('test/b.test.ts');
}

for (const scenario of scenarios) {
  test(`記録をcommitした後の${scenario}でも、test:affectedと再applyは記録を理由に止まらない`, async () => {
    // 記録なしの対照でも同じ操作が終了0になることを先に確かめ、記録の有無だけを比べる。
    for (const withRecord of [false, true]) {
      await fixture(files, async (f) => {
        await recordAndCommit(f, scenario, withRecord);
        await operate(f, scenario);
        const label = withRecord ? '記録あり' : '記録なしの対照';
        const affected = run(f, ['run', 'test:affected']);
        expectAffected(scenario, affected.output);
        expect(affected.code, `${label}: ${affected.output}`).toBe(0);
        const before = withRecord ? await readFile(join(f.repo, reviewPath), 'utf8') : '';
        const reapplied = applyFeedback(f, 'bun run test:affected', run);
        expect(reapplied.code, `${label}: ${reapplied.output}`).toBe(0);
        if (withRecord) {
          expect(affected.output).not.toContain(reviewPath);
          expect(await readFile(join(f.repo, reviewPath), 'utf8')).toBe(before);
          expectClassifiedAfter(f, scenario);
        }
      });
    }
  }, 60000);
}
