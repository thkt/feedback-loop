import { test, expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadRecords, saveRecords } from '../../../test-runtime/affected-records.ts';
import { selectAffected } from '../../../test-runtime/affected.ts';
import { git } from '../../support/runner-affected.ts';

// 手順書で決まっている保存先です。実装の recordsPath を使いません。
function storedPath(root: string): string {
  return join(root, '.feedback-loop-records', 'records.json');
}

function withRepo(run: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'affected-records-')));
  try {
    git(root, 'init', '-b', 'main');
    writeFileSync(join(root, 'base.txt'), 'x');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'base');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function modules(root: string, ...names: string[]): Set<string> {
  return new Set(names.map((name) => join(root, name)));
}

test('実行したテストファイルの記録だけを置き換え、実行しなかったファイルの記録を残す', () => {
  withRepo((root) => {
    const a = join(root, 'a.test.ts');
    const b = join(root, 'b.test.ts');
    saveRecords({
      root,
      ran: new Map([
        [a, modules(root, 'a1.ts')],
        [b, modules(root, 'b1.ts')],
      ]),
      failed: [],
    });
    saveRecords({ root, ran: new Map([[a, modules(root, 'a2.ts')]]), failed: [] });

    const loaded = loadRecords(root, [], [a, b]);
    expect(loaded.warning).toBeUndefined();
    expect(loaded.records.get(a)).toEqual(modules(root, 'a2.ts'));
    expect(loaded.records.get(b)).toEqual(modules(root, 'b1.ts'));

    expect(existsSync(storedPath(root))).toBe(true);
    const saved: unknown = JSON.parse(readFileSync(storedPath(root), 'utf8'));
    expect(saved).toMatchObject({
      version: 1,
      tests: { [a]: { files: { [join(root, 'a2.ts')]: 'missing' } } },
    });
    expect(saved).toHaveProperty(['tests', a, 'basis']);
    expect(readFileSync(join(dirname(storedPath(root)), '.gitignore'), 'utf8')).toBe('*\n');
    expect(readdirSync(dirname(storedPath(root))).sort()).toEqual(['.gitignore', 'records.json']);

    // 別 worktree の記録は、その worktree の下に入り、元の worktree の記録に触れない。
    const linked = join(root, '..', `${root.split('/').pop()}-linked`);
    git(root, 'worktree', 'add', '-b', 'linked', linked);
    try {
      const linkedRoot = realpathSync(linked);
      expect(storedPath(linkedRoot)).not.toBe(storedPath(root));
      saveRecords({
        root: linkedRoot,
        ran: new Map([[a, modules(root, 'linked.ts')]]),
        failed: [],
      });
      expect(existsSync(storedPath(linkedRoot))).toBe(true);
      expect(loadRecords(linkedRoot, [], [a]).records.get(a)).toEqual(modules(root, 'linked.ts'));
      expect(loadRecords(root, [], [a]).records.get(a)).toEqual(modules(root, 'a2.ts'));
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });
});

test('失敗したテストファイルの記録は消し、次回は記録なしとして選ばれる', () => {
  withRepo((root) => {
    const ok = join(root, 'ok.test.ts');
    const bad = join(root, 'bad.test.ts');
    saveRecords({
      root,
      ran: new Map([
        [ok, modules(root, 'ok.ts')],
        [bad, modules(root, 'bad.ts')],
      ]),
      failed: [],
    });
    // bad.test.ts は今回失敗した。実行はしたので ran にも入っているが、記録は残さない。
    saveRecords({
      root,
      ran: new Map([[bad, modules(root, 'bad.ts', 'half-read.ts')]]),
      failed: [bad],
    });

    const { records } = loadRecords(root, [], [ok, bad]);
    expect(records.has(bad)).toBe(false);
    expect(records.get(ok)).toEqual(modules(root, 'ok.ts'));

    // 記録なしのテストファイルは、自分が読んだと分かっていない変更でも選ばれる。
    const selection = selectAffected({
      changed: [join(root, 'ok.ts')],
      testFiles: [ok, bad],
      records,
    });
    expect(selection).toEqual({ kind: 'tests', tests: [ok, bad] });
  });
});

test('読めない記録ファイルは記録なしとして扱い、警告を出して全テストを選ぶ', () => {
  const unreadable = [
    { label: 'JSON として壊れている', body: '{not json' },
    { label: '形が違う', body: '["a.test.ts"]' },
    { label: '未対応の版', body: '{"version":2,"tests":{}}' },
    { label: '基点が不正', body: '{"version":1,"tests":{"a":{"basis":null,"files":{}}}}' },
    {
      label: 'ハッシュが不正',
      body: '{"version":1,"tests":{"a":{"basis":"x","files":{"b":null}}}}',
    },
  ];
  for (const { label, body } of unreadable) {
    withRepo((root) => {
      const path = storedPath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);

      const a = join(root, 'a.test.ts');
      const b = join(root, 'b.test.ts');
      const loaded = loadRecords(root, [], [a, b]);
      expect(loaded.records.size, label).toBe(0);
      expect(loaded.warning, label).toContain('records.json');

      const selection = selectAffected({
        changed: [join(root, 'a-dep.ts')],
        testFiles: [a, b],
        records: loaded.records,
      });
      expect(selection, label).toEqual({ kind: 'all', reasons: [join(root, 'a-dep.ts')] });

      // 次の保存は、読めなかった記録を捨てて新しい記録を書く。
      saveRecords({ root, ran: new Map([[a, modules(root, 'a-dep.ts')]]), failed: [] });
      const reloaded = loadRecords(root, [], [a]);
      expect(reloaded.warning, label).toBeUndefined();
      expect(reloaded.records.get(a), label).toEqual(modules(root, 'a-dep.ts'));
    });
  }
});

test('記録がない場合と読めない場合を区別し、旧形式は読まず変更しない', () => {
  withRepo((root) => {
    const a = join(root, 'a.test.ts');
    expect(loadRecords(root, [], [a])).toEqual({ records: new Map(), warning: undefined });
    const directory = dirname(storedPath(root));
    mkdirSync(directory);
    const legacy = [
      'test-deps.json',
      'test-deps.json.basis.json',
      'test-deps.json.pending',
      'test-deps.json.hash.previous',
    ];
    for (const name of legacy) {
      writeFileSync(join(directory, name), 'legacy');
    }
    expect(loadRecords(root, [], [a])).toEqual({ records: new Map(), warning: undefined });
    saveRecords({ root, ran: new Map([[a, modules(root, 'a.ts')]]), failed: [] });
    for (const name of legacy) {
      expect(readFileSync(join(directory, name), 'utf8')).toBe('legacy');
    }
    rmSync(storedPath(root));
    mkdirSync(storedPath(root));
    const unreadable = loadRecords(root, [], [a]);
    expect(unreadable.records.size).toBe(0);
    expect(unreadable.warning).toContain('を読めないため');
    expect(() => saveRecords({ root, ran: new Map(), failed: [] })).toThrow();
  });
});
