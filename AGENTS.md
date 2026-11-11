# feedback-loop

## 変更後の確認

コードやテストを変更したら、作業を終える前に`bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assurance のテストや、影響を判断できない変更では`bun run check`も実行する。`check:feedback`の成功を全体 check の成功として報告しない。

テストファイルを個別に実行するときは、`bun run test:file ./tests/<ファイル名>`を使う。`bun test`を直接呼ぶと、Bun の既定の 5 秒でテストが時間切れになる。テストは`apply`や`check:affected`を子プロセスで起動する。load average が 20 を超えた状態では、1 つのテストが 5 秒を超えた。パスは`./`から書く。`./`を省くと部分一致になり、別の場所にある同じ名前のファイルも実行する。個別の実行は`check:feedback`の代わりにしない。

`scripts/feedback-loop/`は、プラグインの`apply`がこの repo へ配置した導入版であり、直接編集しない。`src/`の正本を変更したら`bun run build:feedback-loop`で再生成し、表示された`apply --update`のコマンドで導入版を更新する。導入版が生成物と食い違うと`check:generated`が失敗する。
