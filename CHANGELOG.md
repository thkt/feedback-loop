# 変更履歴

setup-feedback-loop プラグインのバージョンごとに、導入済みの repo の挙動が変わる点と、更新のときに確認する点を載せます。バージョンはプラグインの`plugin.json`の`version`です。

導入済みの repo を新しいバージョンへ上げる手順は、[README の「更新する」](README.md#更新する)にあります。各バージョンの PR の一覧は [GitHub の release](https://github.com/thkt/feedback-loop/releases) にあります。

## [0.4.2] - 2026-11-13

### 追加

- lockfile を workspace のルートに置く構成で、サブパッケージへ導入できます。`--repo`のディレクトリに lockfile も`packageManager`もなければ、Git のルートまでの祖先のうち、lockfile があるいちばん近いディレクトリで package manager を判定します。0.4.1 までは`packageManager`が`null`になり、`install`と`apply`が止まっていました（[#148]）
- `check:affected`が、引数`--base <参照>`を受け取ります。その実行だけ、指定した参照を比較元にします。導入したブランチでは、導入の変更を commit してから`--base HEAD`を付けると、取り込む前に、変更に関わる quality だけが選ばれることを確かめられます。npm では`npm run check:affected -- --base HEAD`、pnpm と Bun では`--`を付けない形で渡します（[#149]）
- 実行部に、変更したファイルをコマンドへ渡す操作`changed`を足しました。`node scripts/feedback-loop/runtime.mjs changed --ext .ts,.tsx -- eslint --max-warnings 0`のように、lint や formatter を変更したファイルだけへ実行します。対象が 0 件ならコマンドを実行しません。`apply`は script を接続しないため、`check:affected`の値と同じ実行系で package script へ書きます。書き方は[`references/contract.md`の「変更したファイルをコマンドへ渡す」](references/contract.md#変更したファイルをコマンドへ渡す)にあります（[#152]）

### 挙動の変更

- `--repo`のディレクトリに lockfile がなければ、祖先のいちばん近い lockfile の変更と削除で、`check:affected`は全 quality を実行します。理由に`../pnpm-lock.yaml`のようにパスを表示します。数えるのは、導入時に判定した package manager の lockfile です。0.4.1 までは外の変更として扱い、全 quality を実行していませんでした（[#148]）
- `inspect`の出力に`packageManagerFrom`が加わりました。祖先の lockfile で判定したときの、その lockfile のパスです。`--repo`のディレクトリで判定したときは`null`です（[#148]）
- `collect`の標準出力を読めないとき、理由と、標準出力の先頭と末尾の 200 文字ずつを表示します。0.4.1 までは、実行系の例外の文だけを表示していました（[#150]）
- `--base`を付けた実行では、診断が案内する再実行のコマンドも同じ`--base`を含みます（[#149]）

- 比較元を決められないとき、`check:affected`は収集コマンドを実行する前に止まります。0.4.1 までは、収集を最後まで実行してから止まっていました。`.feedback-loop.json`に`base`がなく、`origin/HEAD`も、1 つだけの`main`・`master`もない repo が対象です（[#155]）
- その診断は、差分を取る比較元の決め方として、`.feedback-loop.json`の`base`を示します。`origin`のある repo では、`git remote set-head origin --auto`も示します。実行部の`changed`も同じ診断を表示します（[#155]）
- `.feedback-loop.json`の`base`を Git の commit として読めないとき、`check:affected`は収集の前に止まり、読めない参照を示します。0.4.1 までは、収集を実行した後に、git のエラーをそのまま表示していました（[#155]）
- `origin/HEAD`の指す先がないとき、比較元を決められない場合として扱い、`inspect`の`base`は`null`になります。リモートで既定のブランチを改名した後の`git fetch --prune`で起きます。0.4.1 までは、指す先のない参照を比較元にして、git のエラーで止まっていました（[#155]）
- `apply`が収集の失敗で案内する再実行のコマンドは、記号を含まない引数を引用符で囲みません。実行部の案内と同じ書き方です（[#155]）

`check:affected`は、`--base`以外の引数を 0.4.1 までと同じく読みません。

### 不具合の修正

- Bun の repo で`scripts/feedback-loop/record-modules.ts`を読めないか、依存記録を保存できないと、`check:affected`が失敗するたびに一時ディレクトリが残っていました（[#155]）

### 更新のときに確認する点

- workspace の構成で、サブパッケージの`package.json`に`packageManager`を足して導入した場合は、足したままでも動きます。祖先の lockfile の変更で全 quality を実行するようになります。足した`packageManager`は外せます。外しても、祖先の lockfile から同じ package manager を判定します
- `--repo`のディレクトリに lockfile がなく、祖先に同じ package manager の lockfile がある Bun の repo は、更新後の最初の`check:affected`で全 quality を 1 回実行します。依存記録の基点に、その lockfile の内容が加わるためです（[#148]）
- 祖先の lockfile で判定する場合、対象の package がその workspace に属することは確かめません。スキルの手順で、導入担当が`packageManagerFrom`を見て確かめます

### 文書

- `references/runners.md`の「Vitestの収集用コマンド」に、package manager 経由で Vitest を呼ぶと警告が標準出力に混ざることと、`node node_modules/vitest/vitest.mjs list`のように直接起動する書き方を足しました。pnpm 9 と 10 は、警告を標準出力へ出します（[#150]）
- `references/tools.md`と`references/contract.md`に、`changed`の使い方を足しました。flat config の ESLint へ変更したファイルを渡すときは、`--no-warn-ignored`を付けます（[#152]）

### この repo の開発

- oxlint の`suspicious`と`perf`のカテゴリと、型の扱いを絞る個別ルールを有効にしました。導入先へ配る実行部の挙動は変わりません（[#153]）
- 変更の取得を`src/changes.ts`にまとめ、runner へ渡す入力を簡素にしました（[#155]）
- 届いていなかった分岐を確かめるテストを書き直し、重複したテストとテスト本体のループをなくしました（[#155]）

### 確認していないもの

- package の`packageManager`と、祖先の lockfile の package manager が違う構成。祖先の lockfile の変更では、全 quality を実行しません
- submodule。祖先の探索は git が返すルートで区切ります。テストは通常の checkout と worktree だけです
- 導入先から報告のあった、`pnpm exec`が標準出力へ出す警告。pnpm 9 と 10 が`pnpm install`の警告を標準出力へ出すことは確かめました
- `check:feedback`のような、`check:affected`を呼ぶ script へ`--base`を渡す場合の pnpm と Bun の動き。npm は`--base`を自分の設定として読むため、診断で止めて書き方を案内します

## [0.4.1] - 2026-11-12

Vitest の`experimental.recordDependencies`を有効にした repo だけが対象です。`sinceLastRun`はこの設定を有効にするため、同じ扱いになります。どちらも使わない repo の挙動は、0.4.0 と同じです。

### 不具合の修正

- 手元の依存記録が古いと、quality が import するファイルを変更しても、`check:affected`がテストを実行せず終了 0 になっていました。記録の上で assurance にしか届かない変更を終了 0 にする、0.4.0 の動きによるものです（[#140]）
- 手元の依存記録が古いと、記録の上で別の quality にしか届かない変更が、import が増えた quality を選んでいませんでした。0.3.0 以前にもある動きです（[#140]）
- 依存記録のない quality があると、届く先のない変更で全 quality を実行せず、記録のない quality だけを実行していました（[#140]）

Vitest はこの設定のとき、届くテストを手元の依存記録だけで決めます。記録はテストを実行した時点の import で、Git では共有しません。`git pull`で import が増える変更を取り込むと、次にそのテストを実行するまで記録は古いままです。

`check:affected`は、import のつながりと依存記録の両方で照会し、どちらかで届く quality を実行します。依存記録だけが知る依存（実行時に組み立てたパスの import）で届く quality も、変更前と同じく実行します。

### 挙動の変更

- 依存記録のない quality は、変更によらず実行します。届く先のない変更があれば、変更のパスを理由に全 quality を実行します（[#140]）
- assurance のテストに依存記録がなくても、assurance のテストだけが import するファイルの変更は、全 quality へ広げません。変更前は全 quality を実行していました。`check:affected`は assurance を実行しないため、assurance には記録ができません（[#140]）

### 確認していないもの

- 到達先の照会の時間。依存記録を使う repo は、変更 1 件につき 2 回照会します。plugin や TSX の変換がある repo では計っていません
- `vcsProvider: 'mtime'`だけを指定した場合の照会
- テストが`scripts/feedback-loop/runtime.mjs`を import する repo。そのテストは依存記録のないテストと同じ扱いになり、実行するテストが増えます

### この repo の開発

- 変更履歴の先頭のバージョンが`plugin.json`のバージョンと同じであることと、README の導入と更新のコマンドが`marketplace.json`の名前を使っていることを、テストで確かめます（[#141]）

## [0.4.0] - 2026-11-12

### 挙動の変更

- Vitest の repo で、assurance のテストだけが import するファイルを変更したとき、`check:affected`は全 quality を実行しなくなりました。その変更だけなら、テストを実行せず、`変更なし: assuranceのテストにしか届かない変更だけのため、テストを実行していません`を表示して終了 0 にします。変更前は全 quality を実行していました（[#135]）
- その変更があれば、`assuranceのテストにしか届かない変更は、このコマンドでは確かめません。全体checkとCIで実行します: `に続けてパスを表示します。届く quality を実行する場合にも表示します（[#135]）

assurance のテストは、helper と一緒に直すことが多くあります。0.3.0 では、assurance のテストファイル自体の変更だけが対象でした。

次の場合は、変更前と同じく全 quality を実行します。

- どのテストにも届かない変更が同時にある
- `dependencies`の対応先が assurance だけである入力。assurance のテストが import していても同じです
- 読み込みに失敗する assurance のテスト（存在しないファイルの import、構文エラー）だけが import するファイル
- Bun の repo。`check:affected`は assurance を実行しないため、assurance の依存記録がありません

### 設定の確認が要る場合

assurance のテストだけが import するファイルを、quality のテストが import 文以外の方法で使っている repo では、そのファイルの変更で quality が選ばれなくなります。ファイル読込み、子プロセス、`require`、実行時に組み立てたパスの import がこれに当たります。変更前は全 quality を実行していました。

該当する場合は、`.feedback-loop.json`の`dependencies`で、そのファイルと quality のテストの対応を指定してください。書き方は[`references/runners.md`の「関連選択を補う」](references/runners.md#関連選択を補う)にあります。

### 文書

- README に、導入済みの repo を新しいバージョンへ上げる手順を足しました。この変更履歴も、このバージョンから置いています（[#137]）

### この repo の開発

- テストファイルを個別に実行する`test:file`を足しました。`bun test`を直接呼ぶと Bun の既定の 5 秒で動き、ほかの処理と並行して走るとテストが時間切れになっていました（[#134]）

### 確認していないもの

- Vitest の`experimental.recordDependencies`を使う構成
- `package.json`の変更などで全 quality の実行が先に決まった場合は、到達先を調べません。assurance にしか届かない変更があっても、表示は出ません
- 読み込みに失敗する assurance の扱いは、Vitest 5.1.0 のテストで確かめています。4.1.11 は手で確かめました
- 到達先の照会の時間。素の TypeScript の fixture（テスト 250 件、assurance 20 件）では、変更前後の差は約 20 ミリ秒でした。plugin や TSX の変換がある repo では計っていません

## [0.3.0] - 2026-11-11

### script 名の改名

- `apply`が接続する script 名が、`test:affected`から`check:affected`に変わりました。`test:*`を一括実行する repo で、変更がなければ非ゼロ終了するこのコマンドが、全テストの実行に混ざっていたためです（[#122]）

導入済みの repo は、`test:affected`のままでも実行できます。診断の「再実行」も、`check:affected`がなければ`test:affected`を案内します（[#131]）。名前を移す場合は、`apply --update`が表示する差分に従ってください。移す値、消す名前、`test:affected`を呼ぶほかの script の書き換えを表示します。`package.json`は変更しません。手順は[`references/contract.md`の「ファイルの配置と接続」](references/contract.md#ファイルの配置と接続)にあります。

`check:*`を一括実行している repo では、`check:affected`と`check:feedback`を除く明示集合へ接続し直してください。

### 挙動の変更

- assurance に指定したテストファイルだけを変更したとき、`check:affected`はテストを実行せず、`変更なし: assuranceのテストファイルの変更だけのため、テストを実行していません`を表示して終了 0 にします。変更前は全 quality を実行していました。届く quality があれば実行し、ほかに届かない変更があれば全 quality を実行します（[#121]）
- 変更に assurance のテストファイルがあれば、`assuranceのテストファイルは、このコマンドの実行対象に選びません。全体checkとCIで実行します: `に続けてパスを表示します（[#121]、[#127]、[#131]）
- `check:classification`の「通常収集とtestGlobsの集合が一致しません」は、片方にしかないパスだけを向きごとに表示します。収集だけにあるパスは、実在しない、`testGlobs`に当たらない、`testGlobs`に当たるが探索で見つからない、の 3 つに分けます（[#118]、[#126]）
- 診断の「再実行」は、`check:classification`の実行では`check:classification`を案内します。変更前は`check:affected`でした（[#131]）
- Bun の依存記録の持ち主は、`bun test`が実行するテストファイルになりました。名前が`.test`・`.spec`などの規則に合わないテストファイルも記録します。持ち主を決められない場合は、`依存記録の持ち主を決められません`に続けて`Bun.main`の値と Bun のバージョンを表示して失敗します（[#127]）

### 不具合の修正

- Bun の repo で、テストが別のテストファイルを import していると、`check:affected`が`読み込んだテストとJUnitのファイル集合が一致しません`で必ず失敗していました（[#127]）
- Vitest の repo で、assurance を指定するか`testArgs`に`--exclude`があると、到達先の照会のときだけ、設定ファイルの`exclude`が外れていました。除外したテストファイルについて`vi.mock`の警告が出て、そのテストが変更したソースを import していれば`Vitestの到達先がquality集合と一致しません`で失敗していました（[#128]）
- Vitest の repo で、repo のパスに`(`・`[`などの glob の記号があると、assurance の除外が効かず、`check:affected`が失敗していました（[#130]）

Bun は、import されたファイルの`test()`を、import した側のテストとして実行します。assurance のテストファイルを import する quality を選ぶと、その assurance のテストも`check:affected`で実行されます。

### 文書

- `references/runners.md`に、導入先で書く補助スクリプトの書き方を足しました。直接実行されたときだけ処理を始める判定と、子プロセスを起動するテストのタイムアウトです（[#125]）
- `references/contract.md`に、`testGlobs`を通常 check の収集範囲に合わせることと、負荷による失敗を関連選択の失敗と見分ける 2 点を足しました（[#125]）

### 確認していないもの

- Windows。Vitest の assurance の除外は、Windows のパスでは一致しません
- Vitest 5.1.0 より古いバージョンでのテスト。[#128] の原因と修正は 4.1.11 で手で確かめましたが、テストは 5.1.0 で動きます
- `Bun.main`が実行中のテストファイルを指すことは、Bun の文書にありません。1.4.4 と、CI が使う最新の Bun で、記録のテストが確かめています
- 実物の pnpm での実行。pnpm 12.18.0 が実行中の script 名を渡すことは手で確かめました

## [0.2.1] - 2026-11-11

### 不具合の修正

- Vitest の repo で、絞り込みの実行（`test:affected`）だけが`NODE_ENV=development`で動いていました。全 quality の実行と同じく、`NODE_ENV`が未設定なら`test`で動きます（[#109]）

`NODE_ENV`を読むテストが、絞り込みのときだけ失敗していた場合は、このバージョンで成功します。回避のために`NODE_ENV=test`を`test:affected`の前に足していた場合は、外せます。

### 確認していないもの

- Vitest のバージョンによって書き込まれる`DEV`、`MODE`、`PROD`、`BASE_URL`。テストで確かめているのは`NODE_ENV`だけです。照会の前の環境を渡すため、これらもテストの実行へ渡らない作りです

## [0.2.0] - 2026-11-11

### 挙動の変更

- package manager を決められない診断が、原因ごとの文になりました。判定材料なし・指定の競合・未対応・`packageManager`の値に名前がない、の 4 通りです（[#105]）
- 比較元を決められない診断が、原因ごとの文になりました。`main`と`master`の両方がある場合と、`origin/HEAD`も`main`も`master`もない場合です（[#105]）
- `install`・`apply`・`test:affected`が止まるときも、同じ理由を続けて表示します（[#105]）
- `quality全件の理由:`は、変更したファイルのパスを先に、依存記録の理由を後に並べます。依存記録の理由は原因ごとに 1 つになり、`信頼できる依存記録なし`は`依存記録がありません`に変わりました（[#106]）

`inspect`の JSON の項目は変わっていません。診断と理由の文は`references/contract.md`に表で載せています。

### 内部の変更

- `test:affected`が変更を調べる`git diff`を 1 回にまとめました（[#91]）
- 依存の記録で、JSON と TOML の読み込みをテストの終わりの 1 か所で記録します（[#101]）
- 到達しない起動前の取消の保留を削除しました（[#98]）

### 確認していないもの

- 実物の pnpm での実行。代用の pnpm が受け取った引数と、配置された実行部の出力で確かめています
- 1.4.4 より古い Bun での起動。バージョンの判定のテストと Node.js での起動で確かめています

## [0.1.1] - 2026-11-10

### 導入できる対象

- Bun 1.4.4 以上で`setup.mjs`を起動できます。0.1.0 は 1.4.4 と完全に一致するバージョンだけでした（[#71]）
- pnpm を使う repo へ導入できます（[#77]）
- `package.json`が Git のルートより下にある repo へ導入できます。`--repo`にそのディレクトリを指定します（[#79]）

### 追加

- `.feedback-loop.json`の`ignoredChanges`で、テストに影響しないファイル（ドキュメントなど）を glob で宣言できます。当たる変更は全 quality を実行する理由になりません。当たる変更だけの場合は、テストを実行せず終了 0 で終わります（[#86]）
- `inspect`が、Git のルートの設定ファイルと CI 定義も返します（[#79]）

### 挙動の変更

- 依存記録の基点の形が変わりました。更新後の最初の`test:affected`は、1 回だけ全 quality を実行します（[#67]、[#77]）
- `bun test`へ`--isolate`を渡さなくなりました。`--parallel`がテストファイルごとの分離を含むため、挙動は変わりません（[#89]）
- 診断文が変わりました。`--repo`の指定に関する文言と、`bunArgs`・`testArgs`の分離の指定を拒否する文言です（[#79]、[#89]）
- `--check-command`を省略した`apply`は、再実行の案内に`--check-command`を付けません（[#79]）

### 不具合の修正

- Bun の runner で、`describe`を使ったテストがあると`test:affected`が必ず失敗していました（[#81]）
- Vitest の runner で、package の外にある共有コードの変更を見逃していました（[#84]）
- テストが環境変数を必要とする repo で、診断が案内する`test:affected`が失敗していました。環境変数を読み込むコマンドで包んだ`test:affected`と`check:classification`を、`apply`が保持します（[#85]）
- `collect`を省略した設定で探索場所のディレクトリがないと、生の ENOENT が出ていました。場所を示す診断になります（[#69]）
- `inspect`の`configFiles`が`.oxlintrc.json`と`.oxfmtrc.json`を返していませんでした（[#63]）

### 確認していないもの

- 実物の pnpm での実行。代用の pnpm が受け取った引数と、配置された実行部の出力で確かめています
- 1.4.4 より古い Bun での起動。バージョンの判定のテストと Node.js での起動で確かめています

## 0.1.0 - 2026-11-09

プラグインにバージョンを付けた最初のバージョンです。tag と GitHub の release はありません。

[0.4.2]: https://github.com/thkt/feedback-loop/releases/tag/v0.4.2
[0.4.1]: https://github.com/thkt/feedback-loop/releases/tag/v0.4.1
[0.4.0]: https://github.com/thkt/feedback-loop/releases/tag/v0.4.0
[0.3.0]: https://github.com/thkt/feedback-loop/releases/tag/v0.3.0
[0.2.1]: https://github.com/thkt/feedback-loop/releases/tag/v0.2.1
[0.2.0]: https://github.com/thkt/feedback-loop/releases/tag/v0.2.0
[0.1.1]: https://github.com/thkt/feedback-loop/releases/tag/v0.1.1
[#63]: https://github.com/thkt/feedback-loop/pull/63
[#67]: https://github.com/thkt/feedback-loop/pull/67
[#69]: https://github.com/thkt/feedback-loop/pull/69
[#71]: https://github.com/thkt/feedback-loop/pull/71
[#77]: https://github.com/thkt/feedback-loop/pull/77
[#79]: https://github.com/thkt/feedback-loop/pull/79
[#81]: https://github.com/thkt/feedback-loop/pull/81
[#84]: https://github.com/thkt/feedback-loop/pull/84
[#85]: https://github.com/thkt/feedback-loop/pull/85
[#86]: https://github.com/thkt/feedback-loop/pull/86
[#89]: https://github.com/thkt/feedback-loop/pull/89
[#91]: https://github.com/thkt/feedback-loop/pull/91
[#98]: https://github.com/thkt/feedback-loop/pull/98
[#101]: https://github.com/thkt/feedback-loop/pull/101
[#105]: https://github.com/thkt/feedback-loop/pull/105
[#106]: https://github.com/thkt/feedback-loop/pull/106
[#109]: https://github.com/thkt/feedback-loop/pull/109
[#118]: https://github.com/thkt/feedback-loop/pull/118
[#121]: https://github.com/thkt/feedback-loop/pull/121
[#122]: https://github.com/thkt/feedback-loop/pull/122
[#125]: https://github.com/thkt/feedback-loop/pull/125
[#126]: https://github.com/thkt/feedback-loop/pull/126
[#127]: https://github.com/thkt/feedback-loop/pull/127
[#128]: https://github.com/thkt/feedback-loop/pull/128
[#130]: https://github.com/thkt/feedback-loop/pull/130
[#131]: https://github.com/thkt/feedback-loop/pull/131
[#134]: https://github.com/thkt/feedback-loop/pull/134
[#135]: https://github.com/thkt/feedback-loop/pull/135
[#137]: https://github.com/thkt/feedback-loop/pull/137
[#140]: https://github.com/thkt/feedback-loop/pull/140
[#141]: https://github.com/thkt/feedback-loop/pull/141
[#148]: https://github.com/thkt/feedback-loop/pull/148
[#149]: https://github.com/thkt/feedback-loop/pull/149
[#150]: https://github.com/thkt/feedback-loop/pull/150
[#152]: https://github.com/thkt/feedback-loop/pull/152
[#153]: https://github.com/thkt/feedback-loop/pull/153
[#155]: https://github.com/thkt/feedback-loop/pull/155
