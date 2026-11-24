---
status: "superseded by DR-0003"
date: "2026-11-19"
decision-makers: "thkt"
scope: "mutation の壊し方の作り方と当て方（src/mutants.ts、src/mutation.ts、src/mutation-run.ts、src/mutation-guard.ts、src/equivalents.ts）"
---

# 壊し方を自前の規則で作り、ファイルを書き換えて当てる

## Context and Problem Statement

改善のコマンド（`mutation`）は、既存のテストがすり抜ける壊し方を一覧にする（#187）。対象は Bun テストの導入先である。この repo のテストは子プロセスを起動し、実行時に `src/` から生成したスキルを通して実装に届く（`tests/support/feedback-loop-skill.ts`）。導入先の日常の実行は、グローバルなツールや毎回取り込む最新版に頼らない（`.claude/OUTCOME.md` の Constraints）。壊し方をどう作り、どう当てるかを決める必要があった。

## Decision Drivers

- Bun テストの導入先で動く
- 子プロセスで動くコードにも、壊し方が届く
- 導入先に secret（LLM の API キーなど）を増やさない
- 同じソースから、同じ壊し方と鍵を作る。動作の変わらない壊し方の記録（#191）と、鍵で突き合わせる
- 導入先に足す依存は、`devDependencies` の固定版 1 つに収める

## Considered Options

- oxc-parser の構文木から、mizchi/mutator の規則を移して壊し方を作り、ファイルを書き換えて当てる
- StrykerJS を導入する
- mizchi/mutator をそのまま導入する
- LLM が壊し方を作るツール（Mutahunter、LLMorpheus）を使う
- エージェントに壊し方を選ばせ、コマンドは当てるだけにする
- 構文解析に @babel/parser を同梱する
- 導入先の `typescript` の JS API で構文解析する
- 壊し方ごとに repo を複製して走らせる
- すべての壊し方を環境変数の切り替えの形にして、1 回だけ書き込む

## Decision Outcome

Chosen option: "oxc-parser の構文木から、mizchi/mutator の規則を移して壊し方を作り、ファイルを書き換えて当てる", because Decision Drivers をすべて満たすからである。

- 構文解析は oxc-parser で行う。生成した runtime は oxc-parser を同梱せず、導入先の `devDependencies` の固定版を、`mutation` を実行したときに読み込む
- 規則は、mizchi/mutator（MIT）の `packages/core/src/mutators.ts` から移す。許諾の文は `src/mutants-license.txt` に置き、生成する runtime の先頭にも書く
- 壊し方は、対象のファイルを書き換えて 1 件ずつ当て、走らせた後に元へ戻す
- 壊し方の実行は、日々の反復の実行部（`runBunTests`）と別の経路で行う（`src/mutation-run.ts`）。既存の実行部は、終了コードが 0 以外なら理由を問わず同じ失敗として止まり、壊し方で落ちたことと起動の失敗を区別できない。依存記録も書き換える
- 鍵は、パス・囲む関数・関数の中の構文木の経路・規則・置き換えの hash からなる。パスと関数の部分の `:` と `%` は、`%3A` と `%25` に置き換える。関数の名前は文字列のメンバー名から `:` を含みうるので、置き換えないと鍵の字だけでパスの境目が決まらない（#191）

### Consequences

- Good, because 導入先は oxc-parser を `devDependencies` の固定版で入れるだけで使える。生成した runtime は、読み込みの時点では Node.js の組み込みモジュールだけを import する
- Good, because 同じソースから同じ壊し方と鍵を作るので、動作の変わらない壊し方の記録と突き合わせられる
- Bad, because 規則を自分で保守する。mizchi/mutator から規則を移すたびに、移した元の commit と許諾の文を合わせる
- Bad, because 実行中は対象のファイルが変わる。ロックと記録で、ほかの実行と重ならないようにし、強制終了の後の実行で元へ戻す（`src/mutation-guard.ts`）。HEAD と同じ内容のファイルにだけ当てる
- Bad, because 壊し方 1 件ごとにテストを走らせるので、時間がかかる。`--tests` で最初に走らせるテストを絞り、すり抜けたものだけを全 quality で確かめ直す
- Bad, because 型を見ないので、型検査に通らない壊し方も作る

### Confirmation

- `tests/mutants.test.ts` が、規則ごとの壊し方と、鍵が位置によらないこと、鍵の `:` と `%` の置き換えを確かめる
- `tests/mutation.test.ts` が、本物の runtime を fixture の repo で起動し、一覧と `--key` の結果を確かめる。生成した runtime が読み込みの時点で組み込みモジュールだけを import することも、同じファイルが確かめる
- `tests/mutation-interruption.test.ts` が、強制終了と取消の後に対象のファイルを元へ戻すことを確かめる

## Pros and Cons of the Options

### oxc-parser の構文木から、mizchi/mutator の規則を移して壊し方を作り、ファイルを書き換えて当てる

- Good, because ESTree の形の構文木を返すので、mizchi/mutator の規則をそのまま移せる
- Good, because ファイルを書き換えるので、子プロセスで動くコードにも壊し方が届く
- Bad, because 規則と当て方を自分で保守する

### StrykerJS を導入する

- Bad, because 公式の runner に Bun テスト用が無い。コミュニティ製の `@hughescr/stryker-bun-runner` は、中身と保守の状況を確かめられなかった

### mizchi/mutator をそのまま導入する

- Bad, because 決定の時点（mutator `97f8260`）では、対応する runner は Vitest 5 で、Bun テストに対応しなかった。Node.js 24 以上を要した。2026-11-23 の 0.5.3 では、この 2 点は成り立たない。Bun テストの runner が足された（experimental、Bun 1.4 以上）。本体は `bun node_modules/.bin/mutator` で、`node` を使わずに最後まで走った。ただし README は本体を Node.js で動かすと書き、`package.json` の `engines` は Node.js 24 以上のままである
- Bad, because 実装をメモリ上で書き換えるので、子プロセスで動くコードには壊し方が届かない。Bun テストの導入先 1 つ（ソース 24 ファイル、テスト 58 ファイル）では、7,649 件の壊し方のうち 737 件が、どのテストからも届かない扱いになった。そのうち 358 件は、子プロセスが実行していた。子プロセスからだけ届くモジュールでは、307 件のうち 1 件も実行されなかった。条件とほかの値は、[2026-11-23 の測定](#2026-11-23-の測定251)に書いた

### LLM が壊し方を作るツール（Mutahunter、LLMorpheus）を使う

- Bad, because ツールの中に LLM の API キーが要り、導入先に secret が増える

### エージェントに壊し方を選ばせ、コマンドは当てるだけにする

- Bad, because 挙げ漏れを外から見分けられず、「すり抜けが 0 件」が成り立たない
- Bad, because 実行のたびに集合が変わり、動作の変わらない壊し方の記録と突き合わせられない

### 構文解析に @babel/parser を同梱する

- Bad, because 構文木の形が ESTree と違い、mizchi/mutator の規則を移すときに読み替えが要る。同梱したときの大きさは測っていない

### 導入先の `typescript` の JS API で構文解析する

- Bad, because TS 7 のネイティブ版には JS の API が無い（この repo の 7.0.2 で確かめた）

### 壊し方ごとに repo を複製して走らせる

- Bad, because `node_modules` の symlink が、pnpm と Vite で実体のパスへ解決され、複製の外を読む。生成物の入口が 2 つになる

### すべての壊し方を環境変数の切り替えの形にして、1 回だけ書き込む

- Bad, because この repo のテストは実行時に `src/` から生成し直すので、build を省く利点が無い
- Bad, because 文や宣言の単位の切り替えを作る処理が大きい
- Bad, because 環境変数を引き継がない子プロセスでは、拾うべき壊し方がすり抜けに見える

## More Information

- 決定の出どころ: #187 の本文の `## Approach`、#187 の検討記録の[コメント](https://github.com/thkt/feedback-loop/issues/187#issuecomment-6948533409)、#191 の本文の Constraints
- 実装: PR #194（#187）と PR #206（#191）
- 移した元: mizchi/mutator の `97f8260590f80c20c1b7ccfcf8a92db5be5b7c7e`
- 版: oxc-parser 0.158.0（`package.json` の `devDependencies`）、Bun 1.4.4
- 検討の範囲外: 起動のきっかけ（CI、利用者のスケジュール）は導入先への接続（#192）で扱う。エージェントのセッション中（`check:feedback` や Stop hook）には起動しない。Codex の `workspace-write` ではネットワークと `.git` への書き込みが止まり、壊し方の書き換えが作業中の working tree を乱すためである

### 2026-11-23 の測定（#251）

mizchi/mutator をそのまま導入しない理由を、Bun テストの導入先 1 つで測り直した。thkt は 2026-11-23 に、この値を見て、mutator と小さい部品に乗り換えると決めた。置き換える決定は、#253 で DR-0003 に書く。この DR の Decision Outcome は変えていない。

測った条件は次のとおりである。

- Bun 1.4.4、`@mizchi/mutator` 0.5.3。mutator の本体は `bun` で起動した。導入先のテストが `node` を起こすので、PATH から `node` は外していない
- ソースは 24 ファイル（5,717 行）である。テストは 67 ファイルのうち 58 ファイルを使った。外した 9 ファイルのうち 8 ファイルは、測定のサンドボックスがプロセスの一覧の取得と `/tmp` への書き込みを止めるので、壊す前から落ちる。残る 1 ファイルは、子に渡る環境変数が 2 つだけであることを確かめるテストで、`bun` の子へ変数を足す preload を使うと落ちる
- preload は、#251 のコメントに置いた試作である。mutator の公開していない取り決め（`globalThis.__mutator__`、`MUTATOR_*` の環境変数、manifest の形）に頼る
- 今の `mutation` は、この repo の `a938daf` の runtime で、同じ 58 ファイルを quality として走らせた

mutator を最後まで走らせるには、設定を 2 つ足す必要があった。

| 起きたこと | 足した設定 | 残ること |
| --- | --- | --- |
| 既定の型検査が、TypeScript 7 の API（`typescript/unstable/sync`）を Bun の上で起こせずに落ち、終了 1 になった。導入先は `devDependencies` に TypeScript 7 を持つ | `typecheck: false` | 型検査に通らない壊し方が、すり抜けの一覧に混ざる |
| 既定の worker の数（CPU の数）では、壊す前のテストが 1 件落ち、終了 4 になった | `maxWorkers: 4`（導入先のテストの並列数と同じ） | `bun test` へ引数を渡す口が無い。`bunfig.toml` の `[test]` に `timeout` を書いたが、試しのプロジェクト（Bun 1.4.5）では読まれなかった。この測定は、既定の 5 秒で走ったと見ている。`BUN_OPTIONS` の `--timeout` は効いた |

子プロセスに届かない壊し方の件数は、次のとおりである。壊し方は 7,649 件で、子プロセスの警告に出たテストは 58 ファイルのうち 20 ファイルだった。全部の実行は約 3 時間 26 分と見積もられたので、全体は壊す前の実行だけを行った。

| 条件 | どのテストからも届かない壊し方 |
| --- | --- |
| preload なし | 737 件 |
| `bun` の子へ、渡された `env` に関わらず変数を足す preload | 444 件 |
| 子が preload を読める `env` のときだけ変数を足す preload（外すテストを 8 ファイルにした 59 ファイルで測った。preload なしは 728 件） | 708 件 |

preload を足しても届かない壊し方が残る理由は、テストが子に最小の `env` を渡すことである。語で数えると、テスト 67 ファイルのうち 27 ファイルがプロセスを起こす。`env` を渡すのは 21 ファイルで、そのうち 20 ファイルは `process.env` を引き継ぐ書き方を持たない。`bun` でない子を起こす語は 3 ファイルにあった。

届かない扱いの壊し方を、どれかのプロセスが実行したかどうかで分けた。mutator が壊し方を埋め込んだソースを、別の clone のディスクに書き、どのプロセスが実行しても記録が残る形にして、同じ 58 ファイルを走らせた。

| 条件 | 届かない扱い | どのプロセスも実行しない | 子プロセスが実行したが、mutator から見えない |
| --- | --- | --- | --- |
| preload なし | 737 件 | 379 件 | 358 件 |
| `bun` の子へ変数を足す preload | 444 件 | 379 件 | 65 件 |
| 上の preload に、子の記録を 50 ミリ秒ごとに書く処理を足した版 | 436 件 | 379 件 | 57 件 |

どのプロセスも実行しない 379 件は、テストが無いコードである。ファイルを書き換える方式でも、すり抜けになる。21 ファイルに分かれ、多い順に 77 件、55 件、55 件、51 件、30 件である。

見えない 65 件は、2 ファイルにあった。53 件は、`node` で起こした子だけが実行していた。12 件は、テストが途中で止める `bun` の子が実行していた。試作の preload は子の記録を終了のときにだけ書くので、止められた子の記録が残らない。記録を 50 ミリ秒ごとにも書くと、12 件のうち 10 件が見えた。最後の版で見えない 57 件のうち、55 件は `node` の子が実行する壊し方である。

`node` の子には、`NODE_OPTIONS` の `--import` で、`module.registerHooks` を使うファイルを読ませると届いた（Node.js 26.13.0）。見えない壊し方は 57 件から 2 件になり、届かない扱いは 381 件になった。新しく届いた 55 件を実行すると、38 件が検出、17 件がすり抜けだった。

preload が子の `env` に足した変数は、子の preload が `process.env` から消すようにした。子に渡る環境変数を確かめるテストを戻した 59 ファイルで、壊す前の実行が通った。

2 つのモジュールで、壊し方を実行した。A は子プロセスからだけ届く（203 行、307 件）。B はテストが直接 import する（87 行、122 件）。

| mutator | preload なし | `bun` の子へ変数を足す preload |
| --- | --- | --- |
| かかった時間（A と B の合計） | 92 秒 | 663 秒 |
| A の検出、すり抜け、届かない | 0 件、0 件、268 件 | 184 件、54 件、30 件 |
| B の検出、すり抜け、届かない | 83 件、34 件、5 件 | 83 件、34 件、5 件 |

A の残りの 39 件は、ログ出力だけの文の中にあり、mutator が既定で実行しなかった。A で届かない 30 件は、すべて、どのプロセスも実行しない壊し方だった。

B で、今の `mutation` と突き合わせた。今の `mutation` は、83 件に 3,706 秒かかった。検出は 47 件、時間切れは 22 件、すり抜けは 14 件である。A では今の `mutation` を走らせていない。B と同じ 1 件あたりの時間なら、188 件に 2 時間を超える。

| 今の `mutation` の 83 件 | 件数 |
| --- | --- |
| mutator も検出した（今の `mutation` の時間切れ 18 件を含む） | 45 |
| 両方ですり抜けた | 14 |
| 今の `mutation` だけが検出した。型検査に通らない壊し方で、作業ツリーを写して型検査するテストが落とした | 11 |
| 今の `mutation` だけが検出した。負荷で落ちることのあるテスト 1 件だけが落ちて、検出か時間切れになった | 3 |
| mutator が作らない | 10 |

今の `mutation` だけが検出した 14 件に、mutator が見落とした動作の違いは無かった。11 件は、型の上で成り立たない壊し方である。3 件は、同じ 1 件のテストだけが落ちていた。そのテストは、壊していない状態でも、mutator の 7 回の実行のうち 1 回落ちた。3 件を鍵ごとに、そのテストのファイルだけで 3 回ずつ走らせ直すと、どれもすり抜けた。うち 1 件を、最初と同じ 24 ファイルで 2 回走らせ直すと、1 回はすり抜け、1 回は同じテストが落ちて検出になった。今の `mutation` は、こうしたテストがある導入先で、同じ壊し方に実行ごとに違う判定を返す。

mutator にだけ出た壊し方は 49 件である。38 件を検出し、5 件は届かず、6 件がすり抜けた。すり抜けた 6 件の規則は、`StringLiteral` が 3 件、`Regex` が 2 件、`ObjectLiteral` が 1 件である。

型検査が落ちる条件を、ほかのプロジェクトで確かめた。落ちるのは、`typescript` が 7 以上のときに mutator が選ぶ経路だけである。

| プロジェクトの `typescript` | mutator が選ぶ検査 | Bun の上での結果 |
| --- | --- | --- |
| 5.9.3（非公開のプロジェクト、Bun 1.4.5） | TypeScript の compiler API | 通った。828 件のうち 143 件を型エラーとして除き、終了 0、9.9 秒 |
| 6.0.3（#251 の試しのプロジェクト） | TypeScript の compiler API | 通った |
| 入っていない（同じ試しのプロジェクト） | `bun check`（Bun が同梱する TypeScript 7.0.2） | 通った |
| 7.0.2（最初の導入先） | `typescript/unstable/sync` | 落ちた（終了 1） |

mutator の設定では、`typescript` が 7 以上の導入先に `bun check` の経路を選ばせられない。`bun check` の検査（`@mizchi/mutator-typecheck` の `createBunChecker`。パッケージの入口からは公開されていない）を、最初の導入先の B に直接当てると、122 件のうち 33 件を型エラーと判定した（0.4 秒）。今の `mutation` だけが検出した型の 11 件は、すべてその中に入っていた。feedback-loop を導入済みで、この測定で読んだ 2 つのプロジェクトは、どちらも TypeScript 7.0.2 である。

preload が、作りの違う子プロセスにも届くかを、dotagents（公開、`5970905`、ソース 71 ファイル、quality のテスト 44 ファイル、Bun 1.4.5）で確かめた。壊し方は 15,900 件で、壊す前の実行だけを行った。

| 条件 | 届かない扱い | どのプロセスも実行しない | 子プロセスが実行したが、mutator から見えない |
| --- | --- | --- | --- |
| preload なし | 7,084 件 | 5,837 件 | 1,247 件 |
| `bun` の子へ変数を足し、子の記録を 50 ミリ秒ごとに書く preload | 5,862 件 | 5,837 件 | 25 件 |

見えない 25 件は 2 ファイルにあり、`env` が 4 つだけの `bun` の子が実行していた。その子を何が起こしたかは、確かめていない。全部の実行は、2 並列で約 82 時間と見積もられた。

dotagents では、壊す前のテストが落ちて終了 4 になることがあった。原因は、Bun の既定の時間切れ（5 秒）である。落ちたテストは、mutator を通さない実行で 2.5 秒から 4.7 秒かかる。mutator はテストを `--isolate` で起こす。mutator を通さずに `--isolate` だけを付けても、2 件がちょうど 5.0 秒で落ちた。

| 時間切れ | 壊す前の実行（2 並列） |
| --- | --- |
| 既定の 5 秒 | 11 回のうち 4 回、1 件以上が落ちた |
| `BUN_OPTIONS` の `--timeout=15000` | 4 回とも通った |

測った導入先は 2 つで、どちらも Bun テストである。Vitest の導入先では測っていない。次の 2 点は、#251 を起票した側が 2026-11-23 に確かめたことで、この測定では走らせていない。Vitest の導入先は 1 つあり（非公開）、Vitest 4.1.11 と Node.js 22 である。mutator の Vitest の runner は Vitest 5 と Node.js 24 以上を要するので、そこでは動かない。試しのプロジェクト（Vitest 5.1.1、Node.js 26.13.1）では、mutator は Node.js の上で走り、`node` を PATH から外した Bun だけでは走らなかった。壊し方の集合をこの repo の `src/` で突き合わせた件数と、preload のコードは、#251 のコメントにある。

### Reassessment Triggers

- mizchi/mutator が Bun テストの runner を足し、本体が Bun で走るようになったとき。2026-11-23 に 0.5.3 で確かめ、[2026-11-23 の測定](#2026-11-23-の測定251)を行った
- TS 7.1 の正式版で `typescript/ast` がソース上の位置を返すと確かめられたとき。TS 7.1 以上の導入先で、型検査に通らない壊し方の除外と、型からの戻り値の壊し方を検討する
- 規則で作った壊し方のすり抜けを、計測の 12 種のすり抜けと比べたとき。12 種は、計測が手で選んだ 45 種の壊し方のうち、すり抜けたものである（#193、[計測の記録](https://github.com/thkt/ai-agent-knowledge/blob/main/knowledge/measure-tests-before-adding-practices.md)の見直す条件）
