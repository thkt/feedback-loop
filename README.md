# feedback-loop

JavaScript／TypeScript の repo へ、静的検査と関連 quality テストの反復コマンド（`check:feedback`、`test:affected`、`check:classification`）を導入する CLI と Claude Code プラグインです。

導入には Bun 1.4.4 が必要です。対象は npm・Bun と、Vitest・Bun テストの repo です。

## Claude Code へ導入する

```bash
claude plugin marketplace add thkt/feedback-loop
```

```bash
claude plugin install setup-feedback-loop@feedback-loop
```

導入後は、対象 repo の Claude Code で`setup-feedback-loop`スキルを呼びます。手順と呼出し仕様は[スキル本体](plugins/setup-feedback-loop/skills/setup-feedback-loop/SKILL.md)と[references](references/contract.md)にあります。

## Codex へ導入する

```bash
codex plugin marketplace add thkt/feedback-loop
```

```bash
codex plugin add setup-feedback-loop@feedback-loop
```

導入後は、対象 repo の Codex で`$setup-feedback-loop`を呼びます。サンドボックスの扱いは[Codex のサンドボックス](references/agents.md#codexのサンドボックス)にあります。

## 導入後の対象 repo

導入担当のエージェントは、既存の検査と全テストを保ったまま、次のものを対象 repo へ置きます。全体 check と CI は、これまでどおり quality と assurance の全件を実行します。

| 置かれるもの | 役割 |
| --- | --- |
| `.feedback-loop.json` | テストの収集範囲、quality と assurance の分類、関連選択の補いを書く設定。導入担当が内容を確かめて用意する |
| `scripts/feedback-loop/` | `test:affected`と`check:classification`の実行部。Bun テストの repo では依存の記録器も置く |
| `package.json`の scripts | `check:feedback`、`test:affected`、`check:classification` |
| `AGENTS.md`の「変更後の確認」 | Claude Code と Codex が変更のたびに`check:feedback`を実行して直す指示。`CLAUDE.md`があれば、その先頭で`@AGENTS.md`を読み込む |
| `.feedback-loop-records/` | Bun テストの repo で`test:affected`が保存する依存記録。Git の変更には現れない |

エージェントは変更のたびに`check:feedback`を実行し、診断を読んで直します。3つのコマンドの役割は次のとおりです。

| コマンド | すること |
| --- | --- |
| `check:feedback` | 導入時に選んだ静的検査と`test:affected`をまとめた診断用コマンド。失敗すると非ゼロで終わる |
| `test:affected` | Git の変更と依存関係（Bun では依存記録、Vitest では import のつながり）から、影響を受ける quality テストだけを実行する。影響が分からない変更では全 quality を実行し、理由を表示する |
| `check:classification` | テストの収集範囲と assurance の指定を検査する。`test:affected`も実行の前に同じ検査をする |

## 開発

| 置き場所 | 内容 |
| --- | --- |
| `src/` | CLI と実行部の正本 |
| `references/` | 手順書の正本 |
| `tests/` | テスト。直下に`<対象>.test.ts`を置き、assurance は`.feedback-loop.json`に理由付きで登録します |
| `scripts/` | 生成（`build.ts`）と lint の道具。`feedback-loop/`はこの repo へ`apply`で配置した導入版です |
| `plugins/setup-feedback-loop/` | プラグイン。`scripts/`と`references/`は生成物です |

正本を変更したら`bun run build:feedback-loop`で再生成します。`bun run check`は、静的検査、生成物と正本の照合、全テストを実行します。

Bun の版は`package.json`の`packageManager`、Node.js の版は`.node-version`で固定しています。CI も同じファイルを読みます。`~/.bun`へ書けないサンドボックスでは、`bun install --frozen-lockfile --ignore-scripts --cache-dir=<書ける場所>`で依存を導入します。

thkt/dotagents の`5d572fc36408`から移しました。それ以前の履歴は thkt/dotagents にあります。

## ライセンス

[MIT](LICENSE)
