---
status: "accepted"
date: "2026-11-23"
decision-makers: "thkt"
scope: "Bun テストの導入先の mutation（src/mutator.ts、src/mutation-preload.ts、src/runtime.ts の mutation の操作、src/setup.ts の依存の導入）"
---

# mutation を、@mizchi/mutator を起こす包みにする

## Context and Problem Statement

改善のコマンド（`mutation`）は、既存のテストがすり抜ける壊し方を一覧にする。DR-0001 は、壊し方を自前の規則で作り、ファイルを書き換えて当てると決めた。DR-0002 は、その鍵の作り方を決めた。

2026-11-23 に、Bun テストの導入先で `@mizchi/mutator` 0.5.3 を走らせて測り直した（#251、DR-0001 の「2026-11-23 の測定」）。同じモジュールの 83 件で、今の `mutation` だけが検出した動作の違いは 0 件だった。今の `mutation` は 83 件に 3,706 秒かかり、mutator は 2 モジュール 429 件に 663 秒かかった。2026-11-18 以降、mutation に関わるバグ修正の PR は 10 件あり、そのうちロックと復元の 2 件（PR #220、PR #244）は、ソースを書き換えない方式では起きない。自前の実装を保つか、mutator に乗り換えるかを決める必要があった。

## Decision Drivers

- 既存のテストがすり抜ける壊し方を、今の `mutation` と同じかそれより少ない見落としで一覧にする
- 1 モジュールの実行が、エージェントの 1 回の作業に収まる時間で終わる
- 対象のファイルを書き換えず、強制終了の後に戻す仕組みを要らなくする
- `mutation` の呼び方と標準出力の JSON の形を、改善の手順から見て保つ
- 導入先の日常の実行が、グローバルなツールや毎回取り込む最新版に頼らない（`.claude/OUTCOME.md` の Constraints）

## Considered Options

- `mutation` を、`@mizchi/mutator` を起こす包みにする
- 自前の規則とファイルの書き換えを続ける（DR-0001）
- mutator を、既定の設定のまま起こす
- 型検査に、公開されている `bun check` を包みから起こす
- 時間切れを、生成する `bunfig.toml` の `[test]` の `timeout` で渡す
- 時間切れと `bunArgs` を、`BUN_OPTIONS` でテストの子にも渡す
- `BUN_OPTIONS` を戻す preload を、生成する `bunfig.toml` の `[test]` の `preload` で読ませる
- `bunArgs` のスクリプトを、mutator が起こす `bun test` の前に挟む

## Decision Outcome

Chosen option: "`mutation` を、`@mizchi/mutator` を起こす包みにする", because #251 の測定で、mutator が今の `mutation` の検出をすべて含み（違いは型の上で成り立たない壊し方と、負荷で落ちるテストの偶然の失敗だけ）、1 件あたりの時間が短く、ソースを書き換えないからである。

- 包みは、導入先の `package.json` のディレクトリから `@mizchi/mutator` を解決し、その CLI を `bun` で起こす。壊す対象は、渡したモジュールに限る（`--include`）。`--key` は mutator の `--only` に渡す
- 規則は mutator の 18 種をすべて使う。ログ出力だけの文の除外（`arid`）は切る
- mutator が走らせるテストは quality に限る。生成した `bunfig.toml` の `[test]` の `pathIgnorePatterns` に、Bun が見つけるテストのファイルのうち quality でないものを並べ、`--bun-config` で渡す
- 時間切れと `bunArgs` は `BUN_OPTIONS` で渡し、`--preload` で読ませるファイル（`scripts/feedback-loop/mutation-preload.ts`）が、テストのプロセスの `BUN_OPTIONS` から、利用者が指定した値のほかを消す。テストが起こす子には、時間切れと `bunArgs` が渡らない
- 型検査は mutator では行わず（`--no-typecheck`）、`survived` と `uncovered` の壊し方を、`@mizchi/mutator-typecheck` の公開されていない `createBunChecker` に掛ける。mutator の版を上げてこの関数が無くなるか形が変わると、本物の mutator を fixture の repo で起こすテスト（`tests/mutation.test.ts`）が落ちる
- 記録は mutator の `mutator.accepted.json` を使う。mutator はこのファイルを読んで、拾わない記録の壊し方を一覧から外す。`--key` の鍵が記録にあるかと記録の理由は、包みがこのファイルを読んで知る。利用者が書く公開された形（`{"<鍵>": {"reason": "<理由>"}}`）なので、mutator の報告の文字列（`statusReason` の `accepted: `）や agent の報告（`acceptance.killed`）には頼らない
- 壊す前のテストが落ちれば、やり直さずに非ゼロ終了する
- `apply` は、oxc-parser の代わりに `@mizchi/mutator` を、この repo の `devDependencies` と同じ固定版で入れる。Vitest の導入先には、3 つ目の Issue が入るまで `mutation` を接続しない

### Consequences

- Good, because 対象のファイルを書き換えないので、ロック、復元、`mutation --restore` が要らなくなった
- Good, because 壊し方ごとに、その場所を実行するテストだけを走らせる。`--tests` の指定と確かめ直しが要らなくなった
- Good, because どのテストも実行しない壊し方が、`uncovered` として `survived` と分かれる
- Bad, because テストが起こした子プロセスの中でだけ動く壊し方は、mutator から見えず、`uncovered` に出る。#251 の導入先 A では、7,649 件のうち 358 件がそうだった。次の Issue の preload で扱う
- Bad, because 型検査が、mutator の公開されていない関数に頼る。版を上げるときに、fixture のテストで確かめる必要がある
- Bad, because preload が、mutator の起こす `bun test` を、mutator が足す環境変数 `MUTATOR_BUN_MANIFEST` で見分ける。これも公開されていない取り決めである
- Bad, because `bunArgs` にスクリプトのパスを置く導入先と、`[install]` のほかの設定を持つ `bunfig.toml` の導入先では、`mutation` が止まる
- Bad, because mutator の鍵は、関数の中の文を足すか入れ替えた後に、記録した鍵が別の式の壊し方に当たりうる。DR-0002 が防いだことが戻る。#253 の時点で、導入先に記録は 1 件も無い

### Confirmation

- `tests/mutation.test.ts` が、本物の mutator を fixture の repo で起こし、呼び方、実行、判定と出力、記録ファイル、`node` の無い PATH、サブディレクトリの package、型検査に通らない壊し方の除外を確かめる
- `tests/mutation-setup.test.ts` が、`apply` の依存の導入と、preload と改善の手順の配置を確かめる
- 導入先 A と dotagents で `mutation` を走らせることは、thkt が PR を merge する前に対話の session で行う。この DR の時点では確かめていない

## Pros and Cons of the Options

### `mutation` を、`@mizchi/mutator` を起こす包みにする

- Good, because 測った 83 件で、今の `mutation` だけが検出した動作の違いは 0 件だった（#251、2026-11-23、mutator 0.5.3、Bun 1.4.4）
- Bad, because mutator の公開されていない取り決め（`createBunChecker`、`MUTATOR_BUN_MANIFEST`、`@mizchi/mutator-bun` の `dist/session.js` の取消の処理の文字列）に頼る

### 自前の規則とファイルの書き換えを続ける（DR-0001）

- Bad, because 同じ 83 件に 3,706 秒かかった（#251、2026-11-23、この repo の `a938daf` の runtime）
- Bad, because 負荷で落ちるテストの偶然の失敗が、3 件を「検出」にした（#251）
- Bad, because ロックと復元のバグ修正が続いた（PR #220、PR #244）

### mutator を、既定の設定のまま起こす

- Bad, because 導入先の `typescript` が 7.0.2 のとき、既定の型検査が `typescript/unstable/sync` を Bun の上で起こせずに終了 1 になった（#251、2026-11-23、mutator 0.5.3）
- Bad, because 既定の worker の数では、壊す前のテストが落ちて終了 4 になった（#251、2026-11-23）
- Bad, because ログ出力だけの文の壊し方を実行しない。CLI では `console` の出力がプログラムの出力である（`94a0f9c`）

### 型検査に、公開されている `bun check` を包みから起こす

- Good, because 公開されていない関数に頼らない
- Bad, because 壊し方ごとの写しを作って型エラーを比べる処理を、包みの側に書くことになる。thkt は、版を上げたときに気づけるテストを置けるなら、公開されていない関数に頼ると決めた（2026-11-23）
- 動かしていない。未確認

### 時間切れを、生成する `bunfig.toml` の `[test]` の `timeout` で渡す

- Bad, because Bun 1.4.5 は読まなかった。6 秒かかるテストが、`timeout = 15000` で 5.07 秒で落ちた（#251 の試しのプロジェクト、2026-11-23）

### 時間切れと `bunArgs` を、`BUN_OPTIONS` でテストの子にも渡す

- Bad, because 導入先 A で、`--no-env-file` が子にも効き、`.env` が読まれることを確かめるテストが 2 回とも落ちた（2026-11-23、Bun 1.4.4）

### `BUN_OPTIONS` を戻す preload を、生成する `bunfig.toml` の `[test]` の `preload` で読ませる

- Bad, because preload が `process.env.BUN_OPTIONS` を戻しても、テストが `Bun.spawn` で起こした子は元の `BUN_OPTIONS` を見た。`node:child_process` の子は戻した値を見た。確かめ方: `[test]` に `preload` を書いた bunfig を `--config` で渡し、`BUN_OPTIONS=--timeout=15000 bun test --isolate` で、子の `BUN_OPTIONS` を出すテストを走らせた（Bun 1.4.5、2026-11-23、#253 の実装中）。`BUN_OPTIONS` の `--preload=<パス>` で読ませると、両方の子が戻した値を見た
- 補足: `BUN_OPTIONS` の `--preload <パス>`（空白で区切る形）は、`bun test` を `Script not found "test"` で止めた。引用符で囲んだパスは、引用符ごとパスとして読まれた（同じ日、同じ版）。そのため `--preload=./scripts/feedback-loop/mutation-preload.ts` の形で渡す

### `bunArgs` のスクリプトを、mutator が起こす `bun test` の前に挟む

- Bad, because mutator は、`bun test` を起こすコマンドを差し替える設定を持たない。自分の環境変数をすべて渡すだけである（`@mizchi/mutator-bun` 0.5.3 の `src/session.ts`、2026-11-23 に読んだ）
- Bad, because dotagents（`5970905`）の `bunArgs` のスクリプトが行うのは環境変数の設定だけで、script を包む書き方で同じことができる。dotagents の main に `mutation` の script は無い

## More Information

- 置き換える決定: DR-0001（壊し方を自前の規則で作り、ファイルを書き換えて当てる）と DR-0002（壊し方の鍵に、囲む関数の字を入れる）
- 決定の出どころ: #253 の本文の「決まっていること」の表。thkt が 2026-11-23 に決めた。#251 の測定
- 実装: #253。乗り換えの 1 つ目である。2 つ目の Issue で、テストが起こした子プロセスの中の壊し方に届かせる preload を、3 つ目の Issue で、Vitest の導入先で mutator を `node` で動かす形を扱う
- 版: `@mizchi/mutator` 0.5.3（`package.json` の `devDependencies`）、Bun 1.4.4 以上
- 担当の AI が決めた点で、thkt の決定ではないもの。PR のレビューで見直せる
  - #253 の起票時: 時間切れを 3 倍にすること（試したのは 3 倍だけ）、`testArgs` から `--timeout` だけを読むこと、導入先の `bunfig.toml` を引き継がないこと、記録の形を検査しないこと、`mutation` を同時に 2 つ走らせることを扱わないこと
  - #253 の実装時: 導入先の `mutator.config.*` を読ませないこと（`--config-file` に空の設定を渡す）。preload を `BUN_OPTIONS` の `--preload=./scripts/feedback-loop/mutation-preload.ts` の形で読ませること。preload が、mutator の起こす `bun test` を `MUTATOR_BUN_MANIFEST` で見分けること。mutator が実行時のエラー（`RuntimeError`）とした壊し方を、mutator と同じく検出として扱い、一覧に入れないこと。`Pending` などの判定の無い状態を `errors` に入れること。`--key` で、テストが拾うようになった記録の鍵を、agent の報告の `acceptance.killed` で見分けること。mutator 0.5.3 は、テストが拾った記録の壊し方の json の報告に `accepted` を付けない（`src/accepted.ts` の `applyAcceptance`）。`@mizchi/mutator` を、Bun の解決ではなく、`package.json` のディレクトリから親へ `node_modules` をたどって探すこと。Bun は、`node_modules` が無いとレジストリから取りに行った（Bun 1.4.5、2026-11-23）

### Reassessment Triggers

- mutator の版を上げて、`createBunChecker`、`MUTATOR_BUN_MANIFEST`、`@mizchi/mutator-bun` の `dist/session.js` の取消の処理の文字列のどれかが変わったとき
- mutator が、`bun test` に引数を渡す口か、起こすコマンドを差し替える設定を足したとき。`BUN_OPTIONS` と preload が要らなくなる
- 記録が別の式の壊し方を隠すことが、導入先の利用で起きたとき。照合を足す Issue を作る
- mutator が、`ps` を使わずに、自分が起こしたテストのプロセスを取消で止めるようになったとき。preload の `@mizchi/mutator-bun` の書き換えを消す
- mutator が、`typescript` が 7 以上の導入先でも Bun の上で型検査できるようになったとき
