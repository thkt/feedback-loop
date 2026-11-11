# feedback-loop

JavaScript／TypeScript の repo へ、静的検査と関連 quality テストの反復コマンド（`check:feedback`、`check:affected`、`check:classification`）を導入する CLI と、Claude Code と Codex のプラグインです。

導入には Bun 1.4.4 以上が必要です。対象は、パッケージマネージャーに npm、pnpm、Bun のいずれかを使い、テストランナーに Vitest または Bun テストを使う repo です。

## Claude Code へ導入する

```bash
claude plugin marketplace add thkt/feedback-loop
```

```bash
claude plugin install setup-feedback-loop@feedback-loop
```

導入後は、対象 repo の Claude Code で`setup-feedback-loop`スキルを呼びます。手順と呼び出し仕様は[スキル本体](plugins/setup-feedback-loop/skills/setup-feedback-loop/SKILL.md)と[references](references/contract.md)にあります。

## Codex へ導入する

```bash
codex plugin marketplace add thkt/feedback-loop
```

```bash
codex plugin add setup-feedback-loop@feedback-loop
```

導入後は、対象 repo の Codex で`$setup-feedback-loop`を呼びます。サンドボックスの扱いは[Codex のサンドボックス](references/agents.md#codexのサンドボックス)にあります。

## 導入後の対象 repo

対象 repo の全体 check（`package.json`の`check` script）は、静的検査と全テストを実行します。feedback-loop は、全体 check が実行するテストを quality と assurance に分けます。

- quality：品質担保のためのテスト。コードが約束する振る舞い（要求、入出力、公開契約など）が変更で壊れていないかを確かめる。全体 check のテストは既定ですべて quality になる
- assurance：安心のためのテスト。中断や環境障害などの異常時にも壊れないことを確かめる。`check:affected`の実行対象には選ばないが、全体 check と CI では必ず実行する

assurance は、`setup-feedback-loop`スキルを実行したエージェントが内容を読んで判断し、理由を添えて`.feedback-loop.json`に指定します。その指定は、分類に関わっていない別のエージェントが読んで照合します。同意しない指定は、スキルを実行したエージェントが直すか、理由を添えて人の判断に回します。

スキルを実行したエージェントは、既存の検査やテストを外さず、採用した静的検査を全体 check と CI に追加します。そのうえで、対象 repo へ次のものを置きます。

| 置かれるもの | 役割 |
| --- | --- |
| `.feedback-loop.json` | テストの収集範囲、quality と assurance の分類、関連選択の補いを書く設定。スキルを実行したエージェントが内容を確かめて用意する |
| `scripts/feedback-loop/` | `check:affected`と`check:classification`の実行部。Bun テストの repo では依存の記録器も置く |
| `package.json`の scripts | 反復コマンド（`check:feedback`、`check:affected`、`check:classification`）の登録 |
| `AGENTS.md`の「変更後の確認」 | Claude Code と Codex が変更のたびに`check:feedback`を実行して直す指示。`CLAUDE.md`があれば、その先頭で`@AGENTS.md`を読み込む |
| `.feedback-loop-records/` | Bun テストの repo で`check:affected`が保存する依存記録。Git の変更には現れない |

対象 repo へ追加される3つのコマンドの役割は次のとおりです。

| コマンド | 役割 |
| --- | --- |
| `check:feedback` | 導入時に選んだ静的検査と`check:affected`をまとめた診断用コマンド。失敗時は非ゼロで終了する |
| `check:affected` | Git の変更と依存関係（Bun では依存記録、Vitest では import のつながり）から、影響を受ける quality テストだけを実行する。影響範囲を特定できない変更では全 quality を実行し、理由を表示する |
| `check:classification` | テストの収集範囲と assurance の指定を検査する。`check:affected`の実行前にも同じ検査を行う |

## 開発

| 置き場所 | 内容 |
| --- | --- |
| `src/` | CLI と実行部の正本 |
| `references/` | 手順書の正本 |
| `tests/` | テスト。直下に`<対象>.test.ts`を置き、assurance は`.feedback-loop.json`に理由付きで登録する |
| `scripts/` | 生成（`build.ts`）や lint のスクリプト。`feedback-loop/`はこの repo へ`apply`で配置した導入版 |
| `plugins/setup-feedback-loop/` | プラグイン。`scripts/`と`references/`は生成物 |

正本を変更したら`bun run build:feedback-loop`で再生成します。`bun run check`は、静的検査、生成物と正本の照合、全テストを実行します。

Bun の版は`package.json`の`packageManager`、Node.js の版は`.node-version`で固定しています。CI も同じファイルを読みます。`~/.bun`へ書き込めないサンドボックスでは、`bun install --frozen-lockfile --ignore-scripts --cache-dir=<書ける場所>`で依存を導入します。

thkt/dotagents の`5d572fc36408`から移しました。それ以前の履歴は thkt/dotagents にあります。

## ライセンス

[MIT](LICENSE)
