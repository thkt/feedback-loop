<!-- 生成元: thkt/feedback-loop references/agent-instructions.md。直接編集せず、正本を変更して再生成してください -->

# エージェントへの指示

導入した`check:feedback`を、Claude CodeとCodexが変更のたびに実行して直す状態にする。指示は対象repoの`AGENTS.md`だけに置く。どちらも同じファイルを読むので、エージェントごとの複製を作らない。

## AGENTS.mdの節

`apply`が対象repoの`AGENTS.md`へ「変更後の確認」の節を置く。置き方は[ファイルの配置と接続](contract.md#ファイルの配置と接続)に従う。`package.json`がGitのルートより下にあるrepoでは、[Gitのルートの`AGENTS.md`へ置く](contract.md#gitのルートより下のpackage)。

既存の`AGENTS.md`に検証の指示があれば、`apply`が置いた節と統合する。全体check・CI・提出前の確認の指示は残す。

## CLAUDE.mdとの関係

Claude Codeは、作業ディレクトリかその上に`CLAUDE.md`か`CLAUDE.local.md`があると、既定では`AGENTS.md`を読まない。`~/.claude/CLAUDE.md`はこの判定に数えない。Codexは`CLAUDE.md`を読まない。

| 対象repoの状態 | すること |
| --- | --- |
| `CLAUDE.md`がない | `apply`が`AGENTS.md`を用意する。`CLAUDE.md`は作らない |
| `CLAUDE.md`がある | `apply`は`@AGENTS.md`の行がなければ先頭へ足す。検証の指示は導入担当が`AGENTS.md`へ移し、`CLAUDE.md`に残さない |
| 共有しない`CLAUDE.local.md`だけがある | `apply`は変更せずに案内を表示する。導入担当は利用者に`@AGENTS.md`の追加を伝える |

読込みの条件は、利用するClaude Codeのバージョンの[AGENTS.mdの説明](https://code.claude.com/docs/en/memory#agents-md)へ照合する。

## 接続後に確認する

エージェントが小さな既知の違反による`check:feedback`の失敗を読み、修正して再実行することを確かめる。

## Codexのサンドボックス

Codexの既定の`workspace-write`は、作業ディレクトリへの書込みを許し、`.git`・`.codex`・`.agents`を読取り専用にし、ネットワークを止める。

| 操作 | 既定のサンドボックスでの扱い |
| --- | --- |
| `inspect`、`check:classification`、`check:affected`、@mizchi/mutatorを入れない`apply` | 作業ディレクトリの中だけへ書くので、そのまま実行する |
| `install`、@mizchi/mutatorを入れる`apply` | パッケージを取得するので、ネットワークの承認を得て実行する。`apply`は、`.feedback-loop.json`の`mutation`が`false`でなく、@mizchi/mutatorが入っていなければ、@mizchi/mutatorを入れる |
| `.codex/hooks.json`の作成 | `.codex`へ書くので、承認を得て実行する |
| 外部サービスを使う`prepare`やテスト | 止まった段を未完了として報告し、利用者に`sandbox_workspace_write.network_access`等の設定を確かめる |

`check:feedback`は既定のサンドボックスの中で全段を通す。サンドボックスの外で成功しても、Codexの反復で使えることの確認にはならない。

## 実行漏れがある場合のPreToolUse hook

指示だけでは実行が漏れる場合に限り、対象repoへ`PreToolUse` hookを追加する。エージェントが`git commit`を実行する直前に`check:feedback`を実行し、失敗したらcommitを止めて診断を返す。質問に答えるだけの応答や、`git commit`以外のコマンドでは`check:feedback`を実行しない。プラグインにはhookを同梱しない。プラグインを有効にした全repoで発火するためである。hook設定から呼び出すスクリプトを`scripts/feedback-hook.sh`へ保存し、実行権限を付ける。

```sh
#!/bin/sh
input=$(cat)
case "$(printf '%s' "$input" | jq -r '.tool_input.command // ""')" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac
cd "$(printf '%s' "$input" | jq -r '.cwd')" || exit 0
# 変更がなければcheck:affectedは「変更なし」で失敗するため、実行しない。
[ -z "$(git status --porcelain)" ] && exit 0
# bun runを導入先のpackage managerに合わせる（npmならnpm run、pnpmならpnpm run）。
# package.jsonがGitのルートより下にあるrepoでは、先にそのディレクトリへcdする。
output=$(bun run check:feedback 2>&1) && exit 0
printf '%s' "$output" | jq -Rs '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: .}}'
```

失敗したときは、終了コード0で`permissionDecision`が`deny`のJSONを標準出力へ返す。このJSONは`git commit`の呼び出しを止め、`permissionDecisionReason`に入れた`check:feedback`の出力を理由としてエージェントへ渡す。`git commit`以外のコマンドと、`check:feedback`が成功したときは、何も出さずに終了0にする。Claude CodeとCodexは同じJSONで呼び出しを止めるので、1本のスクリプトを両方に登録できる。Claude Codeは、標準出力にJSON以外の行があるとJSONとして読まない。そのため、`check:feedback`の出力は変数に受け、標準出力へ流さない。

直した後にエージェントが再び`git commit`を打つと、hookがもう一度`check:feedback`を実行する。`git push`と`gh pr create`の前の検査には使わない。pushとPRは全体checkとCIが担う。変更の有無の判定は、分岐点以降のcommitを含めるか等を対象repoに合わせる。この例は`jq`を使う。スクリプトとhook設定は対象repoの変更としてレビューを受ける。

### 前提と制限

hookは実行漏れを減らすだけで、`check:feedback`を通らないcommitをすべて止めるものではない。前提が外れた場合の漏れは`AGENTS.md`の指示が担う。

| 前提 | 外れる場合 | 外れたときの動き |
| --- | --- | --- |
| commitはエージェントがBashのコマンドとして`git commit`の形で打つ | `git -C <dir> commit`、alias、スクリプトの中のcommitなど、コマンドの文字列に`git commit`の形が現れない書き方 | hookは動かず、commitは通る |
| hookは時間の上限の中で終わる | `check:feedback`がhookの`timeout`を超える | Claude CodeもCodexも、時間切れの`PreToolUse` hookではcommitを止めない。`timeout`は`check:feedback`の所要時間より長く取る。Claude Code 2.1.295以降は、hookに`"onFailure": "block"`を足すと時間切れのときも止められる |
| commitのときに作業ツリーかブランチに変更がある | 変更が無い状態の`git commit --allow-empty`など | `check:affected`は変更なしで非ゼロ終了するので、スクリプトは`git status --porcelain`が空なら`check:feedback`を実行せずにcommitを通す |
| commitはエージェントが打つ | エージェントがcommitせず、人がcommitする使い方 | hookは動かない。`AGENTS.md`の「作業を終える前に」の指示が担う |
| Codexがプロジェクトを信頼している | 信頼していないrepo（`codex exec`に`--trust`を付けない実行を含む） | Codexは`.codex/hooks.json`を読まず、hookは動かず、commitは通る。信頼した後も、hookの追加と変更のたびに`/hooks`で承認が要る |

### Claude Codeの設定

対象repoの`.claude/settings.json`へ追加する。`$CLAUDE_PROJECT_DIR`は開始時のcheckoutを指すため、worktreeで作業するセッションではhook入力の`cwd`で移動するスクリプトを使う。`.claude/settings.local.json`は個人用なので、チームで共有する接続には使わない。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
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

イベント名・入力・終了コード・JSONの`permissionDecision`と`permissionDecisionReason`の意味は、利用するClaude Codeのバージョンの[hooksの説明](https://code.claude.com/docs/en/hooks#pretooluse-input)へ照合する。

### Codexの設定

対象repoの`.codex/hooks.json`へ追加する。`$CLAUDE_PROJECT_DIR`の代わりに、`git rev-parse --show-toplevel`でrepoのルートを求める。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$(git rev-parse --show-toplevel)\"/scripts/feedback-hook.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

repoの`.codex/`は利用者がプロジェクトを信頼した場合だけ読まれる。hookは内容のhashごとに利用者の承認が要るため、追加や変更の後は`/hooks`で承認する。Codexは、hookのエラー、時間切れ、形の崩れた応答では、ツールを実行しうる。

イベント名・入力・終了コード・JSONの`permissionDecision`と`permissionDecisionReason`の意味は、利用するCodexのバージョンの[hooksの説明](https://developers.openai.com/codex/hooks)へ照合する。
