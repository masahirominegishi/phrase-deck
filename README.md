# フレーズデッキ

自分の実話フレーズで覚える英語単語帳。**登録も学習も iPhone だけ**で完結する PWA。
データは端末内 (localStorage) のみに保存され、どこにも公開されません（酒量メモと同じ方式）。

記憶が苦手でも続くよう、3本柱で設計:

1. **エピソードでまとめる** — フレーズを「裁判員の話」「魚市場・仕事」等の自分の体験テーマで束ねる。
2. **間隔反復(SRS)** — Leitner 箱方式。覚えてない物ほど頻繁に、覚えた物は間隔を空けて出題。1日8枚まで新規投入。
3. **シチュエーション起点の能動再生** — まず「場面」を提示 → 英語を口に出す → めくって答え合わせ。

## 構成

```
phrase-deck/
├── index.html / app.js / styles.css   # アプリ本体 (素のPWA・ビルド不要)
├── manifest.webmanifest / sw.js / icon.svg
└── data/phrases.json                  # 初期シード28件 (以降の追加は端末内に保存)
```

- **初期データ**: `data/phrases.json`（28件）。初回読み込み時にシードとして表示。
- **追加データ**: ホーム →「＋ 新しいフレーズを登録」で追加 → 端末内 localStorage に保存。
- **学習進捗 / 音声設定 / APIキー**: すべて端末内 localStorage。

## 使い方（iPhone）

GitHub Pages 等で配信 → iPhone Safari で開く → 共有 →「ホーム画面に追加」でアプリ化（オフライン可）。

- 上部で **自己採点 / 入力 / 発話** の3モードを切替。🔊で読み上げ（端末のTTS、声と速さはホームで調整）。
- 「もう一度 / あやふや / 覚えた」で採点 → 次回の出題間隔が決まる。

### フレーズの登録（自動エンリッチ）
1. ホーム →「設定」に **Anthropic APIキー** を一度だけ入力（端末内のみに保存）。
2. ホーム →「＋ 新しいフレーズを登録」→ `｜` 区切りで単語・フレーズを貼り付け。
3. 「取り込んで自動エンリッチ」→ iPhone から直接 Claude を呼び、翻訳・場面・テーマ・難易度・アドバイス・関連付けを生成。
4. プレビューを確認 →「この内容で保存」で端末に追加。

エンリッチに使うモデルは `app.js` の `MODEL`（既定 `claude-sonnet-4-6`）。料金は追加した数フレーズ分のみ（ごく僅少）。

## GitHub Pages 公開手順
1. GitHub に空リポジトリを作る。
2. このフォルダで:
   - `git remote add origin <repoのURL>`
   - `git push -u origin main`
3. リポジトリ Settings → Pages → Source を `main` / `(root)` に設定。
4. 発行された `https://<user>.github.io/phrase-deck/` を iPhone で開く。

> コード（HTML/JS）は公開されますが、登録したフレーズと進捗・APIキーは端末内だけにあり、リポジトリには含まれません。

## データ形式 (phrases.json / 端末内 deck)

```json
{
  "id": "p-court",
  "type": "phrase",
  "en": ["I had to go to a court", "I had to go to court"],
  "ja": "裁判所に行かなければならなかった",
  "situation_ja": "裁判員に呼ばれて裁判所へ行った体験を話す場面",
  "theme": "裁判員の話",
  "difficulty": 2,
  "advice_ja": "go to court(無冠詞)が自然なことが多い。",
  "related": ["w-jury-service", "p-jury-not-selected"],
  "added": "2026-06-20"
}
```
