<!-- 生成元: thkt/feedback-loop references/improve-tests.md。直接編集せず、正本を変更して再生成してください -->

# テストの改善の手順

この手順に従うエージェントは、既存のテストがすり抜ける壊し方を見つけ、それを拾うテストを足し、draft PRを作る。PRをmergeするかは利用者が決める。

呼び出す側は、既定のブランチの最新のcommitをcheckoutし、改善するモジュールの一覧を渡す。モジュールは`package.json`のディレクトリからのパスで渡す。コマンドは、`package.json`のあるディレクトリで実行する。

## 終わり方

手順は、最後の行に`improve-tests: exit 0`か`improve-tests: exit 1`を書いて終わる。呼び出す側は、この行の数字を終了コードにする。この手順で「終了0で終わる」「非ゼロで終わる」と書いた箇所は、それぞれこの行の`0`と`1`を指す。

| 状況 | 終わり方 |
| --- | --- |
| 始める前の確認を満たさない | 何も変えずに非ゼロで終わる |
| 開いている改善のPRがある | 何も変えずに終了0で終わる |
| 埋めた壊し方、記録へ足した壊し方、外した記録が1件もない | PRを作らない。飛ばしたモジュールがなければ終了0、あれば非ゼロで終わる |
| `check:feedback`を通せない | PRを作らずに非ゼロで終わる |
| `mutation --check-changes`が非ゼロで終わる | PRを作らずに非ゼロで終わる |
| draft PRを作った | 飛ばしたモジュールがなければ終了0、あれば非ゼロで終わる |

## コマンドの呼び方

package managerは、`package.json`の`packageManager`か、lockfile（`package-lock.json`、`pnpm-lock.yaml`、`bun.lock`）で決める。

| package manager | `mutation`の起動 | `check:feedback`の起動 |
| --- | --- | --- |
| npm | `npm run mutation -- <引数>` | `npm run check:feedback` |
| pnpm | `pnpm mutation <引数>` | `pnpm check:feedback` |
| Bun | `bun run mutation <引数>` | `bun run check:feedback` |

`<引数>`には、次の呼び方の`mutation`より後ろを書く。

| 呼び方 | 使う場面 |
| --- | --- |
| `mutation <モジュール> [--tests <テストファイル>...]` | モジュールの壊し方のうち、既存のテストがすり抜けるものを一覧にする |
| `mutation --key <鍵> --tests <テストファイル>...` | 鍵の壊し方1件を、渡したテストが拾うか確かめる |
| `mutation --check-changes` | 作業ツリーの変更が、この手順で変えてよいファイルに収まるか確かめる |

モジュールを渡した実行と`--key`の実行は、標準出力にJSONだけを書き、案内を標準エラーへ書く。`--check-changes`は、結果を標準エラーへ書く。モジュールを渡した実行は、`survived`・`timedOut`・`errors`・`stale`を持つJSONを書く。各壊し方は`key`（鍵）、`path`、`line`、`rule`、`original`（置き換える前の字）、`replacement`（置き換えた字）を持つ。`--key`の実行は、同じ項目に`verdict`を足したJSONを書く。

## 始める前の確認

1. `git status --porcelain`を実行し、出力が空であることを確かめる。
2. `gh auth status`を実行し、成功することを確かめる。
3. 呼び出す側がモジュールの一覧を渡したことを確かめる。

1つでも満たさなければ、何も変えずに非ゼロで終わる。

次に、開いている改善のPRを探す。改善のPRは、branchの名前が`feedback-loop/improve-tests-`で始まるPRである。

```sh
gh pr list --state open --limit 1000 --json headRefName --jq '[.[] | select(.headRefName | startswith("feedback-loop/improve-tests-"))] | length'
```

結果が1以上なら、何も変えずに終了0で終わる。前の提案を利用者が判断する前に、同じ壊し方の提案を重ねないためである。

## モジュールごとの実行

渡されたモジュールを1つずつ扱う。

1. そのモジュールを読み込むテストを探し、壊し方を拾いそうなものを選ぶ。
2. `mutation <モジュール> --tests <選んだテスト>...`を実行する。
3. 非ゼロで終わったら、そのモジュールを飛ばし、標準エラーの診断を理由として控えて、次のモジュールへ進む。
4. 終了0なら、結果のJSONの`stale`・`timedOut`・`survived`を次の節に従って扱う。

`--tests`を渡すと、`mutation`はまず渡したテストで確かめ、すり抜けた壊し方だけを、qualityから渡したテストを除いたテストで確かめ直す。除いた後のテストが無ければ、確かめ直さない。`--tests`を省くと、壊し方の数だけ全qualityを実行するため、時間がかかる。

## 結果の扱い

| 結果 | 扱い |
| --- | --- |
| `stale`の記録 | 記録ファイル`.feedback-loop-mutants.json`から外す。鍵と`reason`（`killed`・`changed`・`not-generated`）を、外した記録として控える |
| `timedOut`の壊し方 | 拾ったものとして扱い、何もしない |
| `survived`の壊し方 | 次の表のどれか1つを行う |

| `survived`の壊し方の状況 | 行うこと |
| --- | --- |
| テストで拾える | 拾うテストを足す。続けて`mutation --key <鍵> --tests <足したテスト>...`を実行し、結果の`verdict`が`killed`であることを確かめる。`killed`でなければ、テストを直して確かめ直す。拾えないまま終えるテストの変更は戻す。確かめた壊し方は、埋めた壊し方として控える |
| 動作が変わらないと判断した | 記録ファイルの`equivalent`へ、`key`・`original`・`reason`（動作が変わらない理由）を足す。記録へ足した壊し方として控える |
| 変えてよいファイルの外を変えないと埋められない | 埋めずに、理由を添えて、埋めていない壊し方として控える |

記録ファイルの形は`{"equivalent": [{"key": "<鍵>", "original": "<置き換える前の字>", "reason": "<理由>"}]}`である。ファイルがなければ作る。記録をすべて外したときも、ファイルを消さずに`{"equivalent": []}`を残す。HEADにあるファイルを消すと、`mutation --check-changes`が非ゼロで終わる。

## 変えてよいファイル

改善の処理が変えてよいのは、次のとおりである。

- HEADにあるファイルのうち、`.feedback-loop.json`の`testGlobs`に当たるテストのファイルと、記録ファイル`.feedback-loop-mutants.json`の中身
- 新しいファイル。テストの補助（fixture、補助モジュール）として足す

HEADにあるファイルは消さない。改名は、元のパスの削除にあたるので行わない。HEADにあるスナップショットのファイル（`__snapshots__/`など）を持つテストには、スナップショットの比較を足さない。そのファイルが変わるためである。

新しいファイルは、テストだけが読む前提で足す。ディレクトリを読んでファイルを拾う製品のコードやツールがあると、新しいファイルでも動作が変わる。ツールが名前で探す設定ファイルと、製品のコードが読むディレクトリには、ファイルを足さない。`mutation --check-changes`はこれを見分けないため、PRのレビューで利用者が確かめる。`.github/`の下と、`package.json`のディレクトリの外には、新しいファイルも足さない。`mutation --check-changes`が外の変更として示す。

## PRを作る前の確認

1. 埋めた壊し方、記録へ足した壊し方、外した記録が1件もなければ、PRを作らない。飛ばしたモジュールがなければ終了0、あれば非ゼロで終わる。
2. `check:feedback`を実行する。失敗したら、変えてよいファイルの中で直して再実行する。通せなければ、PRを作らずに非ゼロで終わる。
3. `mutation --check-changes`を実行する。非ゼロで終わったら、PRを作らずに非ゼロで終わる。

`mutation --check-changes`は、既定のブランチとHEADの分岐点から作業ツリーまでの変更を確かめ、変えてよいファイルの外の変更があれば、そのパスを示して非ゼロで終わる。commitした変更も数える。`check:feedback`を直すための変更も確かめるよう、最後に実行する。

## PRを作る

1. `feedback-loop/improve-tests-`に、UTCの日時（`YYYYMMDDHHMMSS`）を続けた名前のbranchを作る。
2. 変えたパスだけを`git add -- <パス>...`で加え、commitする。
3. branchをpushする。
4. `gh pr create --draft`で、既定のブランチへのdraft PRを作る。本文は、checkoutの外の一時ファイルに書いて`--body-file`で渡す。

PRはdraftのままにし、mergeしない。本文には次の節を置く。該当がない節には「なし」と書く。

| 節 | 書くこと |
| --- | --- |
| 埋めた壊し方 | 鍵、パスと行、規則、置き換えの前後、足したテスト、`--key`で確かめた`verdict` |
| 記録へ足した壊し方 | 鍵、パスと行、置き換えの前後、動作が変わらない理由 |
| 外した記録 | 鍵と`stale`の理由 |
| 埋めていない壊し方 | 鍵、パスと行、置き換えの前後、埋めなかった理由 |
| 飛ばしたモジュール | モジュールのパスと、`mutation`が非ゼロで終わった理由 |

## 閉じたPRの壊し方

mergeせずに閉じたPRの壊し方は、次の実行でまた`survived`に出る。出さないようにするには、その壊し方を理由を付けて記録ファイルへ足す。
