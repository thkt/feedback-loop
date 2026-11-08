<!-- 生成元: references/typecheck.md。直接編集せず、正本を変更して再生成してください -->

# Bun内蔵の型検査を接続する

Bunを日常実行に使うrepoでは、固定したBunの`bun check --no-script`を反復中の型検査の候補にする。追加の型検査パッケージは導入しない。npm・Nodeだけで動くrepoにはBunを追加せず、既存の型検査を保つ。

## 既存の検査範囲を保つ

既存package scriptsと実際の準備処理・CIを読み、型検査が使うtsconfig、CLIの上書きオプション、生成物、project references、型テスト、補助スクリプトの検査を確認する。`files`・`include`・`exclude`・`extends`と参照先を維持し、テストからimportされないソースやassuranceも型検査から落とさない。関連テストの選択集合や変更ファイルの一覧を、型検査の対象に流用しない。

内蔵型検査には`--no-script`を付け、同名のpackage scriptや全体checkの再帰起動を避ける。`-p`で既存のtsconfigを指定し、既存が参照先も検査する`tsc -b`なら`-b`を使う。複数の独立したtsconfigは、それぞれ実行する。型検査では生成物が出ないため、既存の型生成・build・codegen・framework専用検査は保つ。

固定Bunの機能と既存TypeScriptの設定・型定義・診断を照合し、差が未解決なら既存の型検査を使う。検査を通す目的でstrictnessを下げたり、対象や診断を除外したりしない。既存の全体check・CIの型検査は保ち、その置換は別の合意と検証で扱う。

## 準備処理か反復コマンドへ接続する

型検査は[CLIと設定](contract.md#ファイルの配置と接続)の置き分けに従い、`prepare`か`check:feedback`のどちらか一方に置く。必要なcodegen等があるrepoでは、生成後に型検査が走る順序を保つ。依存の照合や環境変数等の既存処理も保ち、通常check・CIの検査範囲を狭めない。

記録器`record-modules.ts`はBunの型定義を使う。対象repoに`@types/bun`がない場合、記録器を型検査の対象へ入れると型エラーになる。記録器を型検査から外す場合は、生成元で型検査済みであることを確認する。記録器も型検査する場合は、`@types/bun`を固定Bunと同じ版で導入し、その追加を依存の変更として扱う。
