---
name: improve-tests
description: 既存のテストがすり抜ける壊し方を導入先のmutationで見つけ、それを拾うテストを足す依頼に使う。setup-feedback-loopの導入や更新、通常の修正には使わない。
---

# テストを改善する

手順は導入先の`scripts/feedback-loop/improve-tests.md`にある。この手順は、導入先に入っている`mutation`の版に合わせて書かれているため、このスキルは手順を持たず、導入先の手順に従わせる。

1. `package.json`のディレクトリに`scripts/feedback-loop/improve-tests.md`があるかを確かめる。無ければ、`setup-feedback-loop`スキルの`apply`で`mutation`を接続するよう利用者に案内して止まる。手順に従わず、ファイルも変えない。
2. スキルの引数を改善するモジュールの一覧として、`scripts/feedback-loop/improve-tests.md`の手順に従う。
3. 引数が無ければ、改善するモジュールを利用者に尋ねる。利用者に尋ねられない実行（`claude -p`など）では、手順の「始める前の確認」のとおり、何も変えずに非ゼロで終わる。
