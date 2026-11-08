<!-- 生成元: references/agents-md.md。直接編集せず、正本を変更して再生成してください -->

# エージェントへの指示

導入した`check:feedback`を、Claude CodeとCodexが変更のたびに実行して直す状態にする。指示は対象repoの`AGENTS.md`だけに置く。どちらも同じファイルを読むので、エージェントごとの複製を作らない。

指示だけで実行が漏れる場合は、[Claude Code](claude-code.md)か[Codex](codex.md)のhookをrepo単位で追加する。プラグインにはhookを同梱しない。同梱すると、プラグインを有効にした全repoで発火するためである。

## AGENTS.mdの節

`apply`が対象repoの`AGENTS.md`へ「変更後の確認」の節を置く。同じ見出しがあれば内容を保持する。節のコマンドはpackage managerと`--check-command`に合わせる。引数を省略したときの扱いは[ファイルの配置と接続](contract.md#ファイルの配置と接続)に従う。

既存の`AGENTS.md`に検証の指示があれば、`apply`が置いた節と統合する。全体check・CI・提出前の確認の指示は残す。

## CLAUDE.mdとの関係

Claude Codeは、作業ディレクトリかその上に`CLAUDE.md`か`CLAUDE.local.md`があると、既定では`AGENTS.md`を読まない。`~/.claude/CLAUDE.md`はこの判定に数えない。Codexは`CLAUDE.md`を読まない。そのため、`apply`の配置を確かめ、対象repoの状態に応じて指示を整える。

| 対象repoの状態 | すること |
| --- | --- |
| `CLAUDE.md`がない | `apply`が`AGENTS.md`を用意する。`CLAUDE.md`は作らない |
| `CLAUDE.md`がある | `apply`は`@AGENTS.md`の行がなければ先頭へ足す。検証の指示は導入担当が`AGENTS.md`へ移し、`CLAUDE.md`に残さない |
| 共有しない`CLAUDE.local.md`だけがある | `apply`は変更せずに案内を表示する。導入担当は利用者に`@AGENTS.md`の追加を伝える |

読込みの条件は、利用するClaude Codeの版の[AGENTS.mdの説明](https://code.claude.com/docs/en/memory#agents-md)へ照合する。

## 接続後に確認する

- 小さな既知の違反を入れた変更で、エージェントが`check:feedback`の失敗を読み、修正して再実行することを確かめる。
- 違反を除いた後、`check:feedback`と全体checkが成功することを確かめる。
- 接続の確認と、実際の作業でエージェントがコマンドを選んだ観測を区別して報告する。
