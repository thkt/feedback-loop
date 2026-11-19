---
status: "accepted"
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

- Bad, because 対応する runner は Vitest 5 で、Bun テストに対応しない。Node.js 24 以上を要する
- Bad, because 実装をメモリ上で書き換えるので、子プロセスで動くコードには壊し方が届かない

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

### Reassessment Triggers

- TS 7.1 の正式版で `typescript/ast` がソース上の位置を返すと確かめられたとき。TS 7.1 以上の導入先で、型検査に通らない壊し方の除外と、型からの戻り値の壊し方を検討する
- 規則で作った壊し方のすり抜けを、計測の 12 種のすり抜けと比べたとき。12 種は、計測が手で選んだ 45 種の壊し方のうち、すり抜けたものである（#193、[計測の記録](https://github.com/thkt/ai-agent-knowledge/blob/main/knowledge/measure-tests-before-adding-practices.md)の見直す条件）
