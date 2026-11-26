<!-- 生成元: thkt/feedback-loop references/mutation.md。直接編集せず、正本を変更して再生成してください -->

# 改善のコマンドと手順

`.feedback-loop.json`の[`mutation`](contract.md#導入設定)が`true`のrepoで、`apply`が接続する`mutation`と、それを使う改善の手順の呼び出し方を定めます。

## 改善のコマンド

`mutation`は、対象のモジュールの壊し方を[@mizchi/mutator](https://github.com/mizchi/mutator)で実行し、既存のテストが拾わない壊し方を一覧にします。`apply`が`mutation` scriptとして接続します。Bunテストのrepoでも、Vitestのrepoでも、呼び方、標準出力のJSON、終了コードは同じです。

Vitestのrepoでは、mutatorがVitest 5以上とNode.js 24以上を求めます（`@mizchi/mutator-vitest`の`peerDependencies`の`vitest ^5.0.0`と、`engines`の`node >=24`）。Vitest 4.1.11とNode.js 22は推奨しません。`mutation`は版を確かめずに起動します。

| 呼び方 | 扱い |
| --- | --- |
| `mutation <モジュール>` | モジュールの壊し方を、qualityで確かめる |
| `mutation <モジュール> --key <鍵>` | 鍵の壊し方1件だけを確かめる。鍵はmutatorの鍵で、パスを含まないため、モジュールは省けない |
| `--with-assurance` | モジュールを渡す2つの形の後に足す。`--key <鍵>`との順は問わない。mutatorが走らせるテストを、qualityとassuranceの両方にする。assuranceが0件のrepoでは、指定しないときと同じ結果になる。`--check-changes`とは一緒に渡せず、非ゼロ終了する |
| `mutation --check-changes` | 作業ツリーの変更が、[改善の手順](#改善の手順の呼び出し)で変えてよいファイルに収まるか確かめる。壊し方は実行しない |

`--tests`と`--restore`は、引数の誤りとして非ゼロ終了します。mutatorは、壊し方ごとに走らせるテストを自分で選び、ファイルを書き換えないためです。

npmでは`npm run -s mutation -- src/a.ts --key 'k1a2b3'`のように、script名の後に`--`を書いてから引数を渡します。`-s`を付けると、npmはscriptの見出し（`> <package>@<version> mutation`とコマンドの行）を標準出力に書きません。付けないと、見出しが結果のJSONの前に付き、JSONとして読めません。pnpmでも`pnpm -s mutation src/a.ts`のように`-s`を付けます。pnpm 10は、付けないと見出しを標準出力に書きます。pnpmとBunでは`--`は要りません。pnpmが引数に残す`--`は読み飛ばします。モジュールは、`package.json`のディレクトリからの、repoの中のファイルのパスで渡します。

壊し方は、mutatorが既定で使う規則をすべて使います。mutatorが既定で切っている規則（0.5.5では`ArrayElement`と`ObjectProperty`）は使いません。mutatorの既定はログ出力だけの文（`console.log(…)`など）の中の壊し方を実行しませんが、`mutation`はこの除外を切り、その壊し方も実行して判定します。CLIでは、`console`の出力がプログラムの出力であるためです。`package.json`のディレクトリにある`mutator.config.*`は読みません。

次の表の段のうち、「Bunテスト」と書いた段はBunテストのrepoだけ、「Vitest」と書いた段はVitestのrepoだけに当てはまります。印の無い段は両方に当てはまります。

| 段 | 扱い |
| --- | --- |
| 起動の前 | `@mizchi/mutator`を`package.json`のディレクトリから解決できなければ、`@mizchi/mutatorを読み込めません`を表示して非ゼロ終了する。親のディレクトリの`node_modules`にある場合も解決する |
| 起動の前（Bunテスト） | `bunArgs`の各要素は、`-`で始め、空白を含めず、値を取る引数は`--env-file=.env.test`のように`=`でつなぐ。`bunArgs`は`BUN_OPTIONS`で渡すので、スクリプトのパスも、別の要素に書いた値も、空白も渡せない。外れる要素があれば、`bunArgsの「<要素>」は、mutationでは渡せません`に続けて、この書き方と、スクリプトなら[ファイルの配置と接続](contract.md#ファイルの配置と接続)の書き方で`check:affected`と`mutation`のscriptを包むことを示し、非ゼロ終了する。`package.json`のディレクトリの`bunfig.toml`が`[install]`のほかの設定を持てば、理由を示して非ゼロ終了する。`[install]`だけなら、読まずに進む。`[install]`の設定は、`[install]`の見出しの下に書く |
| 準備 | 分類の検査（`check:classification`と同じ条件）を行い、`prepare`を1回実行する。qualityが0件なら、`prepare`を実行せず、mutatorを起こさずに非ゼロ終了する |
| mutatorの起動（Bunテスト） | 解決した`@mizchi/mutator`のCLIを`bun`で起こす。`node`がPATHに無くても走る。並列数は`bunWorkers`である。mutatorが走らせるテストはqualityに限る。assuranceのテストと、`testGlobs`に当たらないテストは走らせない。`--with-assurance`を渡すと、assuranceのテストも走らせる。`testGlobs`に当たらないテストは、渡しても走らせない |
| mutatorの起動（Vitest） | 解決した`@mizchi/mutator`のCLIを、`mutation`を起こした`node`で起こす。mutatorが走らせるテストはqualityに限り、`mutation`が生成するVitestの設定で絞る。`--with-assurance`を渡すと、assuranceのテストも走らせる |
| 時間切れと並列数（Bunテスト） | `testArgs`の`--timeout`の値の3倍を、mutatorが起こす`bun test`に渡す。`--timeout 60000`と`--timeout=60000`の両方の書き方を読む。`--timeout`が無ければ、Bunの既定の5000の3倍を渡す。ほかの`testArgs`は渡さない |
| 時間切れと並列数（Vitest） | mutatorと、repoのVitestの設定に任せる。`mutation`は指定しない |
| `bunArgs`と`BUN_OPTIONS`（Bunテスト） | `bunArgs`は、時間切れと同じく`BUN_OPTIONS`で渡す。時間切れと`bunArgs`は、mutatorの本体と、mutatorが起こす`bun test`のプロセスに効く。テストが起こす子には渡らない。利用者が`BUN_OPTIONS`で指定した値は、テストのプロセスでも、テストが起こす子でも、そのまま有効である |
| 環境変数 | mutatorには、mutatorが自分の起こすプロセスへ渡す環境変数（`MUTATOR_ACTIVE`、`MUTATOR_BUN_MANIFEST`、`MUTATOR_BUN_OUT`、`MUTATOR_HIT_LIMIT`、`MUTATOR_WATCH_PARENT`）を渡さない。外側のmutatorが走らせたテストの中から`mutation`を起こしても、外側の壊し方の設定が内側に届かない |
| 壊す前のテスト | 1件でも落ちれば、やり直さず、落ちたテストの名前を標準エラーに出し、標準出力に何も書かずに非ゼロ終了する |
| 型検査（Bunテスト） | `package.json`のディレクトリに`tsconfig.json`があれば、`survived`と`uncovered`の壊し方をBunの型検査に掛け、型エラーになる壊し方を一覧から外す。`tsconfig.json`が無ければ型検査を行わない。導入先の`typescript`の版は使わない |
| 型検査（Vitest） | mutatorに任せる。mutatorは、`tsconfig.json`があり、導入先の`typescript`を解決できれば、壊し方を実行する前に型検査をし、型に通らない壊し方をテストで判定しない。`mutation`はその壊し方を一覧から外す。解決できなければ、PATHに`bun`があればBunの型検査を使い、無ければ型検査を飛ばして、型に通らない壊し方もテストで判定する |
| 置くファイル | mutatorが作る`.mutator/`と、`mutation`が作るファイル（`.feedback-loop-records/mutator/`）は、`package.json`のディレクトリの下に置き、Gitの変更に現れない。`.git`の下には書かない。対象のモジュールを含め、追跡しているファイルを書き換えない |
| 取消（Bunテスト） | 取消のシグナルを受けると、mutatorとテストのプロセスを止めて非ゼロ終了する。`ps`を実行できない環境でも止める。止められない版のmutatorでは、標準エラーに`@mizchi/mutator-bunの取消の処理を書き換えられませんでした`を表示する。このときは、`ps`を実行できない環境で、取消の後もテストのプロセスが残ることがある |
| 取消（Vitest） | 取消のシグナルを受けると、実行部がmutatorのプロセスグループへシグナルを送り、mutatorとVitestのworkerを止めて非ゼロ終了する。mutatorはrepoの設定によらずVitestを`forks`のpoolで走らせ、workerはmutatorと同じプロセスグループにいる。`ps`を実行できない環境でも止まる |

Vitestのrepoでは、`mutation`がVitestの設定ファイルを`.feedback-loop-records/mutator/`に生成してmutatorへ渡します。

- 生成する設定は、repoの設定を読み込み、`test.include`をqualityのテストのファイルのパスだけに置き換える。`--with-assurance`を渡すと、qualityとassuranceのテストのファイルのパスに置き換える。repoの設定が関数なら、Vitestが渡す値で呼ぶ。
- repoの設定の`test.exclude`は残すので、それに当たるqualityとassuranceのテストは走らない。repoの設定に`test.exclude`が無ければ、Vitestの既定の`test.exclude`が当たる。
- repoの設定は、`testArgs`に`--config <パス>`、`--config=<パス>`、`-c <パス>`、`-c=<パス>`があればそのパスである。パスは`package.json`のディレクトリからの相対パスか絶対パスで、複数あれば最後のものを使う。
- `testArgs`に指定が無ければ、`package.json`のディレクトリの`vitest.config.{ts,mts,cts,js,mjs,cjs}`、次に`vite.config.{ts,mts,cts,js,mjs,cjs}`のうち最初に見つかったものである。どれも無ければ、生成する設定は`test.include`だけを持つ。
- `testArgs`のほかの引数は渡さない。`--exclude`も渡さない。
- `testArgs`の`--config`か`-c`にパスが無ければ、`prepare`の前に`testArgs の <引数> に、Vitest の設定ファイルのパスがありません`を表示して非ゼロ終了する。
- repoの設定が`test.projects`を持つか、空でない`test.includeSource`を持てば、mutatorが`test.projects を持つ Vitest の設定では、mutation を使えません`か`test.includeSource を持つ Vitest の設定では、mutation を使えません`を標準エラーに出す。`mutation`は標準出力に何も書かずに非ゼロ終了する。

テストが起こした子プロセスの中でだけ動く壊し方は、mutatorから見えません。その壊し方は、ほかのテストが実行しなければ`uncovered`に出ます。

`--with-assurance`を渡すと、mutatorがassuranceのテストも走らせるため、1モジュールの時間が延びます。assuranceのテストが製品のコードを子プロセスでだけ実行するrepoでは、mutatorがその実行を見られないため、渡しても一覧は変わりません。`mutation`を同時に2つ走らせることは扱いません。

標準出力には結果のJSONだけを書きます。実行の表示、進み具合、案内は標準エラーへ書きます。一覧のJSONの形と各項目、`--key`の実行が書く`verdict`は、改善の手順`improve-tests.md`の[コマンドの呼び方](improve-tests.md#コマンドの呼び方)にあります。

mutatorが実行時のエラーで終わったとした壊し方は、拾ったものとして扱い、一覧に入れません。

型検査に通らない壊し方は、`--key`の実行で`verdict`を`error`とします。`reason`は、Bunテストのrepoでは型エラー、Vitestのrepoでは`型検査に通りません`です。

モジュールを渡した実行は、`errors`が空なら終了0にします。`survived`・`uncovered`・`timedOut`があっても0です。

- `survived`と`uncovered`が空なら、標準エラーに`テストをすり抜けた壊し方は0件です（時間切れ<件数>件）`を表示する。
- mutatorがそのモジュールから壊し方を1件も作らなければ、空の一覧を書く。標準エラーに`mutatorは<モジュール>から壊し方を作りませんでした`と、mutatorが対象にしないファイルか、壊せるコードが無いファイルであることを表示する。

モジュールを渡した実行は、次のいずれかで非ゼロ終了します。

- `errors`がある
- 引数の誤り、またはモジュールがrepoの中のファイルでない
- mutatorを読み込めない
- 分類の検査で止まる、qualityが0件、または`prepare`が失敗する
- 壊す前のテストが落ちる
- Bunテストのrepoで、`bunArgs`か`bunfig.toml`が使えない形である
- Vitestのrepoで、`testArgs`の`--config`か`-c`にパスが無いか、設定が`test.projects`か`test.includeSource`を持つ
- 取消

`--key`の実行は、`verdict`が`killed`か`timedOut`なら終了0にします。次のいずれかと、モジュールを渡した実行の非ゼロの条件では、非ゼロ終了します。

- `verdict`が`survived`・`uncovered`・`error`である
- 鍵に当たる壊し方が、そのモジュールから作られない
- 鍵が`mutator.accepted.json`にある。`prepare`の後、壊し方を実行せず、標準出力に何も書かない。記録の理由と、記録から外すと結果を標準出力に書くことを示す。理由が空の記録では、理由を出さない
- `mutator.accepted.json`をJSONとして読めないか、どれかの項目が`{"reason": "<理由>"}`の形でない。書き方と、形の違う鍵を示す

`--check-changes`の実行は、変えてよいファイルの外の変更がなければ、標準エラーに`改善の処理が変えてよいファイルの外の変更はありません`を表示して終了0にします。変更がないときも0です。次のいずれかで非ゼロ終了します。

- 外の変更がある。`改善の処理が変えてよいファイルの外の変更があります: `に続けて、パスと理由を表示する
- 引数の誤り
- `.feedback-loop.json`を読めない
- 比較元を決められないか読めない、または比較元とHEADの分岐点を求められない
- Gitのrepoでないか、HEADのcommitがない

`--check-changes`が数える変更と、変えてよいファイルは、改善の手順の[変えてよいファイル](improve-tests.md#変えてよいファイル)と[PRを作る前の確認](improve-tests.md#prを作る前の確認)にあります。

拾わなくてよい壊し方は、mutatorの記録ファイル`mutator.accepted.json`に書きます。`package.json`と同じディレクトリに置き、利用者かエージェントが直接書きます。ファイルがなければ記録は0件です。記録の形は`{"<鍵>": {"reason": "<理由>"}}`です。mutatorがこのファイルを読み、記録した鍵の壊し方を一覧に入れません。`mutation`は、`--key`の実行でだけ記録を読み、形を確かめます。`check:classification`と`check:affected`は確かめません。

mutatorの鍵は、壊し方の位置によらず、関数の中の構造から作ります。関数の中の文を足すか入れ替えると、記録した鍵が別の式の壊し方に当たり、その壊し方を一覧から隠すことがあります。`mutation`は、作られなくなった記録の鍵を知らせません。mutatorは、渡していないモジュールの記録も「もう無い」と知らせるためです。

## 改善の手順の呼び出し

改善の手順`scripts/feedback-loop/improve-tests.md`は、スケジュールやCIで走るエージェントが従う手順です。エージェントは、[改善のコマンド](#改善のコマンド)で、既存のテストがすり抜ける壊し方を見つけ、拾うテストを足し、draft PRを作ります。手順はPRをmergeしません。起動のきっかけ（CI、利用者のスケジュール）は、導入担当が用意します。

利用者が対話で呼ぶときは、プラグイン`setup-feedback-loop`に同梱した`improve-tests`スキルを使えます。Claude Codeで`/improve-tests src/x.ts`のように改善するモジュールを渡すと、エージェントはこの手順に従います。

呼び出す側は、次のことを用意します。

| 用意すること | 内容 |
| --- | --- |
| checkout | 既定のブランチの最新のcommitをcheckoutする。ほかの人やエージェントが使っていないcheckoutで実行する。手順は始めに作業ツリーの変更の有無を確かめるが、実行中にほかの作業が書き込むことは検出しない |
| モジュールの一覧 | 改善するモジュールのパスを、`package.json`のディレクトリから書いて渡す。`git diff --name-only --relative`などで作る。手順は、一覧がなければ何も変えずに非ゼロで終わる |
| `gh` | 認証済みの`gh`。手順は、開いている改善のPRの確認とPRの作成に`gh`を使う。`gh auth status`が失敗すれば、何も変えずに非ゼロで終わる |
| ネットワークとGitへの書き込み | 手順は、commit、push、PRの作成を行う。Codexのサンドボックスの`read-only`と`workspace-write`は、`.git`への書き込みかネットワークを止めるため、隔離した環境で`--sandbox danger-full-access`を指定する |
| CIの認証 | エージェントの認証のsecret（Claude CodeのAPIキーなど）と、branchのpushとPRの作成の権限を持つtoken。GitHub Actionsでは、`contents: write`と`pull-requests: write`を与え、tokenを`GH_TOKEN`で渡す。`GITHUB_TOKEN`でPRを作るには、repoの設定で[Allow GitHub Actions to create and approve pull requests](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)を有効にする。[`GITHUB_TOKEN`で作ったPRでは、ほかのworkflowが起動しない](https://docs.github.com/en/actions/concepts/security/github_token)ため、PRでCIを走らせるならGitHub Appのtokenなどを使う |

エージェントは、終わり方を最後の行に`improve-tests: exit <0か1>`の形で書きます。`claude -p`と`codex exec`の終了コードはエージェントの判断を表さないため、呼び出す側がこの行を終了コードにします。この行がなければ、非ゼロとして扱います。

手順の費用は、壊し方1件ごとのテストの実行です。mutatorは、壊す前のテストの実行で、どのテストがどの壊し方の場所を実行するかを調べ、壊し方ごとにその場所を実行するテストだけを走らせます。前の実行の結果は`.mutator/`に残り、変えていないモジュールとテストの判定は次の実行で使い直します。

次の例は、CIのjobと、利用者のスケジュール（cronやlaunchd）のどちらからも、同じスクリプトとして実行します。Claude Code（`claude -p`）で呼ぶ例です。直近7日に追加・変更したモジュールを渡します。7日より前のcommitがなければ、すべてのモジュールを渡します。モジュールがなければ、エージェントを起動せずに終了0で終わります。CIでは、`rev-list --before`が7日前のcommitを読めるよう、履歴を省かずにcheckoutします。

```sh
set -eu
git fetch origin
git checkout --detach "origin/$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"
since=$(git rev-list -1 --before='7 days ago' HEAD)
since=${since:-$(git hash-object -t tree /dev/null)}
modules=$(git diff --name-only --relative --diff-filter=AM "$since" HEAD -- 'src/*.ts' ':!*.test.ts' | tr '\n' ' ')
[ -n "$modules" ] || exit 0
log=$(mktemp)
claude -p --permission-mode bypassPermissions "scripts/feedback-loop/improve-tests.mdの手順に従ってください。モジュール: $modules" | tee "$log"
code=$(sed -n 's/^improve-tests: exit \([01]\)$/\1/p' "$log" | tail -n 1)
exit "${code:-1}"
```

Codex（`codex exec`）で呼ぶ例です。checkoutとモジュールの一覧は、上の例と同じです。`-o`で、エージェントの最後のメッセージをcheckoutの外のファイルへ書きます。

```sh
last=$(mktemp)
codex exec --sandbox danger-full-access -o "$last" "scripts/feedback-loop/improve-tests.mdの手順に従ってください。モジュール: $modules"
code=$(sed -n 's/^improve-tests: exit \([01]\)$/\1/p' "$last" | tail -n 1)
exit "${code:-1}"
```

`--permission-mode bypassPermissions`と`--sandbox danger-full-access`は、確認なしにコマンドを実行します。使い捨てのCIのrunnerか、改善のためだけのcheckoutで使います。
