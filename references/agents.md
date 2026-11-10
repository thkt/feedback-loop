# エージェントへの指示

導入した`check:feedback`を、Claude CodeとCodexが変更のたびに実行して直す状態にする。指示は対象repoの`AGENTS.md`だけに置く。どちらも同じファイルを読むので、エージェントごとの複製を作らない。

## AGENTS.mdの節

`apply`が対象repoの`AGENTS.md`へ「変更後の確認」の節を置く。置き方は[ファイルの配置と接続](contract.md#ファイルの配置と接続)に従う。

既存の`AGENTS.md`に検証の指示があれば、`apply`が置いた節と統合する。全体check・CI・提出前の確認の指示は残す。

## CLAUDE.mdとの関係

Claude Codeは、作業ディレクトリかその上に`CLAUDE.md`か`CLAUDE.local.md`があると、既定では`AGENTS.md`を読まない。`~/.claude/CLAUDE.md`はこの判定に数えない。Codexは`CLAUDE.md`を読まない。

| 対象repoの状態 | すること |
| --- | --- |
| `CLAUDE.md`がない | `apply`が`AGENTS.md`を用意する。`CLAUDE.md`は作らない |
| `CLAUDE.md`がある | `apply`は`@AGENTS.md`の行がなければ先頭へ足す。検証の指示は導入担当が`AGENTS.md`へ移し、`CLAUDE.md`に残さない |
| 共有しない`CLAUDE.local.md`だけがある | `apply`は変更せずに案内を表示する。導入担当は利用者に`@AGENTS.md`の追加を伝える |

読込みの条件は、利用するClaude Codeの版の[AGENTS.mdの説明](https://code.claude.com/docs/en/memory#agents-md)へ照合する。

## 接続後に確認する

エージェントが小さな既知の違反による`check:feedback`の失敗を読み、修正して再実行することを確かめる。

## Codexのサンドボックス

Codexの既定の`workspace-write`は、作業ディレクトリへの書込みを許し、`.git`・`.codex`・`.agents`を読取り専用にし、ネットワークを止める。

| 操作 | 既定のサンドボックスでの扱い |
| --- | --- |
| `inspect`、`apply`、`check:classification`、`test:affected` | 作業ディレクトリの中だけへ書くので、そのまま実行する |
| `install` | パッケージを取得するので、ネットワークの承認を得て実行する |
| `.codex/hooks.json`の作成 | `.codex`へ書くので、承認を得て実行する |
| 外部サービスを使う`prepare`やテスト | 止まった段を未完了として報告し、利用者に`sandbox_workspace_write.network_access`等の設定を確かめる |

`check:feedback`は既定のサンドボックスの中で全段を通す。サンドボックスの外で成功しても、Codexの反復で使えることの確認にはならない。

## 実行漏れがある場合のStop hook

指示だけでは実行が漏れる場合に限り、対象repoへ`Stop` hookを追加する。応答を終える時点で`check:feedback`を実行し、失敗したら診断を返して修正を続けさせる。プラグインにはhookを同梱しない。プラグインを有効にした全repoで発火するためである。hook設定から呼び出すスクリプトを`scripts/feedback-hook.sh`へ保存し、実行権限を付ける。

```sh
#!/bin/sh
input=$(cat)
# 前回の停止取消で続けている場合は、同じ失敗で止め続けない。
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active')" = "true" ] && exit 0
cd "$(printf '%s' "$input" | jq -r '.cwd')" || exit 0
# 変更がなければtest:affectedは「変更なし」で失敗するため、実行しない。
[ -z "$(git status --porcelain)" ] && exit 0
# bun runを導入先のpackage managerに合わせる（npmならnpm run、pnpmならpnpm run）。
bun run check:feedback >&2 || exit 2
```

終了コード2は停止を取り消し、診断を修正の理由としてエージェントへ渡す。修正後の再実行はhookでは保証されず、`AGENTS.md`の指示が担う。hookを提出前の判定に使わない。変更の有無の判定は、分岐点以降のcommitを含めるか等を対象repoに合わせる。この例は`jq`を使う。スクリプトとhook設定は対象repoの変更としてレビューを受ける。

### Claude Codeの設定

対象repoの`.claude/settings.json`へ追加する。`$CLAUDE_PROJECT_DIR`は開始時のcheckoutを指すため、worktreeで作業するセッションではhook入力の`cwd`で移動するスクリプトを使う。`.claude/settings.local.json`は個人用なので、チームで共有する接続には使わない。

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/feedback-hook.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

イベント名・入力・終了コードの意味は、利用するClaude Codeの版の[hooksの説明](https://code.claude.com/docs/en/hooks#stop-input)へ照合する。

### Codexの設定

対象repoの`.codex/hooks.json`へ、Claude Codeと同じ形で追加する。`command`は`"\"$(git rev-parse --show-toplevel)\"/scripts/feedback-hook.sh"`にする。Codexは終了0の`Stop` hookの標準出力をJSONとして読むので、診断はすべて標準エラーへ出す。repoの`.codex/`は利用者がプロジェクトを信頼した場合だけ読まれる。hookは内容のhashごとに利用者の確認が要るため、追加や変更の後は`/hooks`で確認する。

イベント名・入力・終了コードの意味は、利用するCodexの版の[hooksの説明](https://developers.openai.com/codex/hooks)へ照合する。
