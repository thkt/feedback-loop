# feedback-loop

JavaScript／TypeScript の repo へ、静的検査と関連 quality テストの反復コマンド（`check:feedback`、`test:affected`、`check:classification`）を導入する CLI と Claude Code プラグインです。

## Claude Code へ導入する

Bun 1.4.4 が必要です。対象は npm・Bun と、Vitest・Bun テストの repo です。

```bash
claude plugin marketplace add thkt/feedback-loop
```

```bash
claude plugin install setup-feedback-loop@feedback-loop
```

導入後は、対象 repo の Claude Code で`setup-feedback-loop`スキルを呼びます。手順と呼出し仕様は[スキル本体](plugins/setup-feedback-loop/skills/setup-feedback-loop/SKILL.md)と [references](references/contract.md) にあります。

## 開発

| 置き場所 | 内容 |
| --- | --- |
| `scripts/feedback-loop/`、`scripts/test-runtime/` | CLI と実行部の正本 |
| `references/` | 手順書の正本 |
| `plugins/setup-feedback-loop/` | プラグイン版。`scripts/`と共通の`references/`は生成物です |
| `dist/private/` | thkt/dotagents の私用版スキルへ同梱する生成物 |

正本を変更したら`bun run build:feedback-loop`で再生成します。`bun run check`は、静的検査、生成物と正本の照合、全テストを実行します。

thkt/dotagents の`5d572fc36408`から移しました。それ以前の履歴は thkt/dotagents にあります。
