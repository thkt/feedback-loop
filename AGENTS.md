# feedback-loop

## 変更後の確認

コードやテストを変更したら、作業を終える前に`bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assurance のテストや、影響を判断できない変更では`bun run check`も実行する。`check:feedback`の成功を全体 check の成功として報告しない。

テストファイルを個別に実行するときは、`bun test <パス> --timeout 60000`を使う。`--timeout`を省くと Bun の既定の 5 秒で動く。テストは`apply`や`check:affected`を子プロセスで起動するため、負荷の高い環境では 5 秒を超え、時間切れで失敗する。

`scripts/feedback-loop/`は、プラグインの`apply`がこの repo へ配置した導入版であり、直接編集しない。`src/`の正本を変更したら`bun run build:feedback-loop`で再生成し、表示された`apply --update`のコマンドで導入版を更新する。導入版が生成物と食い違うと`check:generated`が失敗する。
