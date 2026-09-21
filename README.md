# Personal Ledger

Personal Ledger 是以 Telegram 為主要介面的個人記帳服務。M2 支援收入、現金與信用卡支出、帳戶間轉帳、卡費、手續費、退款、軟刪除、稽核軌跡，以及今日／本月雙口徑摘要。

## 環境需求

- Node.js 24 LTS
- pnpm 10.x；本機工具亦相容 pnpm 11
- Docker 28 或更新版本

## 設定

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

在本機填寫 `.env`。不得提交真實 Telegram token 或使用者 ID。

## 開發與檢查

```bash
pnpm dev
pnpm check
```

Bot 使用 long polling，只有 `LEDGER_OWNER_ID` 指定的 Telegram 私人對話可使用；群組與其他使用者的更新會被忽略。以 `SIGINT` 或 `SIGTERM` 結束，讓 Bot 與 SQLite 正常關閉。

## 支援輸入

確定性 parser 支援下列形式：

```text
午餐 120
薪水 +85000
昨天 Uber 245 國泰卡
台新轉國泰 5000
國泰卡刷 1200
繳國泰卡 18000 從台新
台新轉國泰 1000 手續費 15
```

帳戶與商家名稱必須已存在。未知或同名參照不會猜測，也不會建立草稿。每筆草稿仍須按「確認」才會正式入帳。

一則訊息可以同時記錄多筆。以逗號、頓號或換行分隔，一次最多 10 筆；超過會要求分次輸入：

```text
午餐 120，Uber 245
午餐 120
Uber 245
```

不含金額的片段會併回前一段，因此 `聚餐 1260，我先付` 仍是一筆交易。

解析不完整的項目不會被丟棄，而是留下待補草稿並立即追問：分類與帳戶以候選按鈕選擇，金額請回覆該則追問訊息並輸入數字。完全無法解析的輸入只會得到範例提示，不會留下待辦。

可用指令：

- `/recent`：最近 50 筆未刪除交易。
- `/today`：今日實際資金流與個人財務摘要。
- `/month`：本月第一日至今日的摘要與分類排名。
- `/pending`：待補充與待確認的草稿，可重新預覽或封存。

草稿不會自動刪除。建立日期不是今天的草稿，按下舊訊息裡的「確認」不會直接入帳，而是重新顯示完整預覽並要求再確認一次，避免誤觸幾天前的按鈕。

交易可透過明確 callback 軟刪除；M3a 不支援自由文字修改追問。所有正式異動均需來源事件並留下不可變 audit。退款必須關聯同一擁有者的未刪除支出交易。

## Docker 與升級

升級前請自行備份 SQLite 檔案或 `ledger-data` volume，再執行：

```bash
docker compose build
docker compose up -d
```

啟動時會自動依序執行 migration 與參照資料 bootstrap。任何 migration 或完整性檢查失敗都會停止啟動，不會開始 Telegram polling。`ledger-data` volume 保存 `/app/data/personal-ledger.sqlite`；憑證只由本機 `.env` 注入，不會複製進 image。

## 驗收

- [M1 驗收證據](docs/quality/m1-acceptance.md)
- [M2 驗收證據](docs/quality/m2-acceptance.md)

M2 只有在自動檢查與人工 Telegram 驗收都完成後才算結案。
