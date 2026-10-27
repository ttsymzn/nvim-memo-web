# nvim-memo-web

`nb` で管理しているメモリポジトリ（`ttsymzn/nvim-memo`）を、ブラウザから Neovim（LazyVim）風に編集する Web アプリ。
サーバーなしの静的サイトで、GitHub API を直接使って読み書きする。

## 開発

```bash
npm install
npm run dev      # http://localhost:5173/?mock でモックリポジトリを使って動かせる
npm test
npm run build
```

`?mock` を付けると GitHub に接続せず、メモリ上のリポジトリで動く。devtools から
`__mock.externalWrite('example.md', 'text')` でターミナル側からの push を再現できる。
クリップボードもメモリ上の偽物になり、`__clipboard.text = '…'` で他アプリでのコピーを再現できる。
`?mock&latency=300` で GitHub への1リクエストごとに 300ms の遅延を入れられる（保存速度の確認用）。

## 接続

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
2. Repository access: Only select repositories → `nvim-memo`
3. Permissions → Repository permissions → Contents: **Read and write**
4. アプリのログイン画面に token を貼る（ブラウザの IndexedDB にだけ保存。`:Logout` で削除）

## デプロイ

`main` に push すると GitHub Actions で GitHub Pages に公開される。
初回だけ、リポジトリの Settings → Pages → Source を **GitHub Actions** にする。

## 操作（M1 時点）

| キー / コマンド | 動作 |
|---|---|
| `:w` / `<C-s>` | 保存（`[nb] Edit:` / `[nb] Add:` で 1 コミット。新規なら `.index` にも追記） |
| `:q` `:q!` `:wq` `:x` `:qa` `:wa` | 閉じる・保存 |
| `:e <name>` | 開く / 新規（拡張子省略時は `.md`）。引数なしで再読み込み、`:e!` で変更を破棄 |
| `:new` / `<Space>fn` | タイムスタンプ名の新規メモ |
| `:bn` `:bp` `:bd` `:ls` / `H` `L` `<Space>bd` | バッファ操作 |
| `jj` | insert → normal |
| `y` `d` `c` `x` / `p` `P` | OS のクリップボードと連携（Neovim の `clipboard=unnamedplus` 相当）。`"a` などのレジスタ指定時は従来どおり |
| `<Space><Space>` / `<Space>ff` / `:Dashboard` | メモ一覧（M2 で fuzzy picker に置き換え予定） |
| `:Sync` | リモートを取り込み |
| `:Logout` | token を削除 |

ダッシュボード: `j`/`k` 移動、`Enter` 開く、`/` 全メモを検索、`n` 新規、`r` 同期、`:` コマンド、`q` 戻る。

`/` の検索はファイル名（拡張子を除く）と本文が対象で、大文字小文字を区別しない。スペース区切りで AND 検索。
入力中は `↑`/`↓`（`Ctrl+P`/`Ctrl+N`）で選択、`Enter` で一致箇所にカーソルを置いて開く、`Esc` で解除。

保存は「後勝ち」。リモートが先に進んでいたら、その上に自分の内容を載せ直して push する。
既存メモの編集は Contents API で1リクエスト、新規メモ（`.index` 更新込み）は Git Data API で3リクエスト。
手元のスナップショットが古くて失敗したときだけ、ブランチを取り直して再試行する。

## 構成

| ファイル | 役割 |
|---|---|
| `src/transport.ts` | git 操作のインターフェース |
| `src/github.ts` | GitHub REST（Git Data API）+ GraphQL（blob 一括取得） |
| `src/mock.ts` | メモリ上のリポジトリ（`?mock` とテスト用） |
| `src/repo.ts` | スナップショットのキャッシュ、保存とリトライ |
| `src/nb.ts` | nb の流儀（ファイル名、`.index`） |
| `src/app.ts` | バッファ、Ex コマンド、ダッシュボード、ステータスライン |
| `src/editor.ts` `src/theme.ts` | CodeMirror + vim、tokyonight |
