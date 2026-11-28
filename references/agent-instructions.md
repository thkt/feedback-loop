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
| 外部サービスを使う`prepare`やテスト | 止まった段を未完了として報告し、利用者に`sandbox_workspace_write.network_access`等の設定を確かめる |

`check:feedback`は既定のサンドボックスの中で全段を通す。サンドボックスの外で成功しても、Codexの反復で使えることの確認にはならない。

## commitの前のPreToolUse hook

プラグインは、エージェントが`git commit`を実行する直前に`check:feedback`を実行する`PreToolUse` hookを同梱する。`check:feedback`が失敗すると、hookはcommitを止め、`check:feedback`の出力を理由としてエージェントへ返す。出力が1万文字を超えると、hookはディレクトリごとに先頭の2,000文字と末尾の8,000文字を残し、省いた文字数と、全体を見るコマンドを1行で示す。直した後にエージェントが再び`git commit`を打つと、hookがもう一度`check:feedback`を実行する。`git push`と`gh pr create`の前の検査はhookが行わず、全体checkとCIが担う。

hookは、プラグインが有効で、repoに`.feedback-loop.json`があるときに動く。対象は、Gitのルートと、その下で追跡されているか無視されていない`.feedback-loop.json`のうち、同じディレクトリの`package.json`が`check:feedback`のscriptを持つものである。対象のディレクトリに変更があれば、そのディレクトリのpackage managerで`check:feedback`を実行する。

| 操作 | すること |
| --- | --- |
| hookを切る | `.feedback-loop.json`に`"commitHook": false`を書く。repoにcommitされるので、チームの全員で揃う。古い導入版は`commitHook`を未知のキーとして拒否するので、先に`apply --update`で`scripts/feedback-loop/`を更新してから書く |
| 手で置いたhookを外す | 0.5.4までの手順書に従って`scripts/feedback-hook.sh`と、`.claude/settings.json`・`.codex/hooks.json`のその項目を置いたrepoでは、それらを外す。残すと`check:feedback`が2回走る |
| Codexで使う | `/hooks`でプラグインのhookを承認する。hookのスクリプトが変わったリリースでは、承認し直す |

### 前提と、前提が外れたときの動き

hookは実行漏れを減らすだけで、`check:feedback`を通らないcommitをすべて止めるものではない。

| 前提 | 外れる場合 | 動き |
| --- | --- | --- |
| commitはエージェントがBashのコマンドとして、`git commit`で始まるコマンドを打つ | `git -C <dir> commit`、`bash -c 'git commit …'`、alias、スクリプトの中のcommit、人が打つcommit | hookは動かず、commitは通る。漏れは`AGENTS.md`の指示が担う |
| hookは600秒の中で終わる | `check:feedback`が600秒を超える | Claude CodeもCodexもcommitを止めない。ホストがhookと、hookが起動した`check:feedback`のテストを止める |
| commitのときに、対象のディレクトリに変更がある | 変更が無い状態の`git commit --allow-empty`や、ほかのpackageだけの変更 | そのディレクトリの`check:feedback`を実行せずに通す |
| hookを動かす`node`か`bun`がある | どちらも無い機械 | 何もせずに通す |
| package managerを決められる | lockfileが無い、または競合する | そのディレクトリは`check:feedback`を実行せず、理由をエージェントへの文脈（`additionalContext`）と利用者への警告（`systemMessage`）に出して通す |
| package managerの実行ファイルが、hookを起動したホストのPATHにある | PATHに無い | そのディレクトリは`check:feedback`を実行せず、理由をエージェントへの文脈（`additionalContext`）と利用者への警告（`systemMessage`）に出して通す |
| Codexがプラグインのhookを承認している | 承認していないか、hookのスクリプトが変わった後に承認し直していない | Codexはhookを飛ばし、commitは通る |
| 導入版`scripts/feedback-loop/`が`commitHook`を知る版である | `"commitHook": false`を書いたのに、導入版が古い | `check:feedback`が`.feedback-loop.json`の未知のキーとして止まる。`apply --update`で導入版を上げてからキーを書く |

イベント名・入力・JSONの`permissionDecision`・`permissionDecisionReason`・`systemMessage`・`additionalContext`の意味は、利用するClaude Codeのバージョンの[hooksの説明](https://code.claude.com/docs/en/hooks#pretooluse-input)と、Codexのバージョンの[hooksの説明](https://developers.openai.com/codex/hooks)へ照合する。
