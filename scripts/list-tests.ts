// bun testの既定の収集規則に合わせ、引数のディレクトリ配下のテストファイルをrepo相対パスで一覧する。
const pattern = new Bun.Glob('**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}');
const roots = process.argv.slice(2);
const files = new Set<string>();
for (const root of roots.length > 0 ? roots : ['.']) {
  const base = root.replace(/^\.\/?/, '').replace(/\/$/, '');
  for (const path of pattern.scanSync({ cwd: root, onlyFiles: true })) {
    if (path.split('/').some((part) => part === 'node_modules' || part.startsWith('.'))) {
      continue;
    }
    files.add(base ? `${base}/${path}` : path);
  }
}
console.log(JSON.stringify([...files].sort()));
