# feedback-loop

## 変更後の確認

コードやテストを変更したら、作業を終える前に`bun run check:feedback`を実行する。失敗したら診断を読んで直し、成功するまで再実行する。assurance のテストや、影響を判断できない変更では`bun run check`も実行する。`check:feedback`の成功を全体 check の成功として報告しない。

`check:classification`が「分類の確認記録が未完了です」と表示したら、該当するテストを読み直し、`bun run check:classification`が出力する`sha256`で`.feedback-loop-review.json`を更新する。

`scripts/feedback-loop/`の`runtime.mjs`、`record-modules.ts`は、この repo へ導入した配置物である。正本を変更しても自動では更新されない。プラグイン版を再生成した後、その`setup.mjs`の`apply --update`で更新する。
