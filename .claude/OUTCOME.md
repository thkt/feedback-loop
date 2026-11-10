# OUTCOME

## Outcome state

### Behavior

- npm、pnpm、Bun のいずれかと、Vitest または Bun テストを使う repo の利用者が、Claude Code または Codex のプラグインから静的検査と関連テストの反復コマンドを導入し、導入した環境でそのコマンドを全段通している。
- 導入先の AI エージェントが、変更のたびに反復コマンドの診断を読んで修正し、再検査している。検査の失敗は非ゼロ終了で返り、成功と区別できる。
- 反復コマンドが、変更の影響を受ける quality テストを実行している。影響が不明な変更では全 quality を実行し、全体 check と CI は quality と assurance の全件を実行している。

## Non-goals

- 自律修正の実行基盤と常駐監視を作ること。

## Constraints

- 導入の CLI は Bun 1.4.4 以上で動く。対象は npm、pnpm、Bun のいずれかと、Vitest または Bun テストの repo である。
- 導入先の日常実行は、スキルのパス、グローバルツール、毎回取得する最新版に依存しない。
- 反復コマンドは Codex の既定のサンドボックス（`workspace-write`）の中で動く。Git のディレクトリへ書かない。
- この repo は公開されているため、非公開の導入先の名前、コード、内部ログを書かない。
