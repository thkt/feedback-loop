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

導入後は、対象 repo の Claude Code で`setup-feedback-loop`スキルを呼びます。手順と呼出し仕様は[スキル本体](plugins/setup-feedback-loop/skills/setup-feedback-loop/SKILL.md)と[references](references/contract.md)にあります。

## Codex へ導入する

Bun 1.4.4 が必要です。対象は Claude Code と同じです。

```bash
codex plugin marketplace add thkt/feedback-loop
```

```bash
codex plugin add setup-feedback-loop@feedback-loop
```

導入後は、対象 repo の Codex で`$setup-feedback-loop`を呼びます。サンドボックスの扱いは[Codex のサンドボックス](plugins/setup-feedback-loop/skills/setup-feedback-loop/references/agents.md#codexのサンドボックス)にあります。

どちらのエージェントでも、反復の指示は対象 repo の`AGENTS.md`へ置きます。

## 開発

| 置き場所 | 内容 |
| --- | --- |
| `scripts/feedback-loop/` | CLI と実行部の正本 |
| `references/` | 手順書の正本 |
| `tests/` | テスト。直下に`<対象>.test.ts`を置き、assurance は`.feedback-loop.json`に理由付きで登録します |
| `plugins/setup-feedback-loop/` | プラグイン。`scripts/`と`references/`は生成物です |

正本を変更したら`bun run build:feedback-loop`で再生成します。`bun run check`は、静的検査、生成物と正本の照合、全テストを実行します。

Bun の版は`package.json`の`packageManager`、Node.js の版は`.node-version`で固定しています。CI も同じファイルを読みます。`~/.bun`へ書けないサンドボックスでは、`bun install --frozen-lockfile --ignore-scripts --cache-dir=<書ける場所>`で依存を導入します。

thkt/dotagents の`5d572fc36408`から移しました。それ以前の履歴は thkt/dotagents にあります。

## ライセンス

[MIT](LICENSE)
