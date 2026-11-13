# feedback-loop

## 変更後の確認

コードやテストを変更したら、作業を終える前に`bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assurance のテストや、影響を判断できない変更では`bun run check`も実行する。`check:feedback`の成功を全体 check の成功として報告しない。

テストファイルを個別に実行するときは、`bun run test:file ./tests/<ファイル名>`を使う。`bun test`を直接呼ぶと、Bun の既定の 5 秒で動く。テストは`apply`や`check:affected`を子プロセスで起動する。ほかの処理と並行して走ると、1 つのテストが 5 秒を超えて失敗する。パスは`./tests/`から書く。ファイル名だけを渡すと部分一致になり、`interruption.test.ts`は 4 ファイルを実行する。個別の実行は`check:feedback`の代わりにしない。

テストのタイムアウトの値は、`package.json`の`test:file`と`.feedback-loop.json`の`testArgs`の 2 か所にある。変えるときは両方を変える。

`scripts/feedback-loop/`は、プラグインの`apply`がこの repo へ配置した導入版であり、直接編集しない。`src/`の正本を変更したら`bun run build:feedback-loop`で再生成し、表示された`apply --update`のコマンドで導入版を更新する。生成物は先頭にプラグインのバージョンを持つので、`plugin.json`の`version`を変えたときも同じ手順を踏む。導入版が生成物と食い違うと`check:generated`が失敗する。
