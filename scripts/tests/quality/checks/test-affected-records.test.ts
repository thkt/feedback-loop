import { test, expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadRecords, saveRecords } from '../../../test-runtime/affected-records.ts';
import { git, recordFile } from '../../support/runner-affected.ts';

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

    expect(existsSync(recordFile(root))).toBe(true);
    const saved: unknown = JSON.parse(readFileSync(recordFile(root), 'utf8'));
    expect(saved).toMatchObject({
      version: 1,
      tests: { [a]: { files: { [join(root, 'a2.ts')]: 'missing' } } },
    });
    expect(saved).toHaveProperty(['tests', a, 'basis']);

    // 別 worktree の記録は、その worktree の下に入り、元の worktree の記録に触れない。
    const linked = join(root, '..', `${root.split('/').pop()}-linked`);
    git(root, 'worktree', 'add', '-b', 'linked', linked);
    try {
      const linkedRoot = realpathSync(linked);
      expect(recordFile(linkedRoot)).not.toBe(recordFile(root));
      saveRecords({
        root: linkedRoot,
        ran: new Map([[a, modules(root, 'linked.ts')]]),
        failed: [],
      });
      expect(existsSync(recordFile(linkedRoot))).toBe(true);
      expect(loadRecords(linkedRoot, [], [a]).records.get(a)).toEqual(modules(root, 'linked.ts'));
      expect(loadRecords(root, [], [a]).records.get(a)).toEqual(modules(root, 'a2.ts'));
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });
});

test('失敗したテストファイルの記録は消し、成功したファイルの記録を残す', () => {
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
  });
});

test('読めない記録ファイルは警告して記録なしとして扱い、次の保存で置き換える', () => {
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
      const path = recordFile(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);

      const a = join(root, 'a.test.ts');
      const b = join(root, 'b.test.ts');
      const loaded = loadRecords(root, [], [a, b]);
      expect(loaded.records.size, label).toBe(0);
      expect(loaded.warning, label).toContain('records.json');

      // 次の保存は、読めなかった記録を捨てて新しい記録を書く。
      saveRecords({ root, ran: new Map([[a, modules(root, 'a-dep.ts')]]), failed: [] });
      const reloaded = loadRecords(root, [], [a]);
      expect(reloaded.warning, label).toBeUndefined();
      expect(reloaded.records.get(a), label).toEqual(modules(root, 'a-dep.ts'));
    });
  }
});

test('記録がない場合は警告せず、読めない場合は警告し、保存の失敗を伝える', () => {
  withRepo((root) => {
    const a = join(root, 'a.test.ts');
    expect(loadRecords(root, [], [a])).toEqual({ records: new Map(), warning: undefined });
    const directory = dirname(recordFile(root));
    mkdirSync(directory);
    mkdirSync(recordFile(root));
    const unreadable = loadRecords(root, [], [a]);
    expect(unreadable.records.size).toBe(0);
    expect(unreadable.warning).toContain('を読めないため');
    expect(() => saveRecords({ root, ran: new Map(), failed: [] })).toThrow();
  });
});
