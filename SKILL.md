---
name: ai-trading
description: >
  AI 加密貨幣自動交易系統 — Binance Testnet/Mainnet。
  提供 Discord 指令操控：查價格、查餘額、執行策略、回測、自動交易管理、風控監控。
  觸發詞：交易、trading、查價、balance、策略、strategy、回測、backtest、auto trade、風控、risk、績效、performance。
  也適用於排程自動交易（cron 定時呼叫）。
---

# AI Trading Skill

加密貨幣自動交易系統的 OpenClaw Skill。讓使用者在 Discord 中操控交易系統。

## 專案位置

本 SKILL.md 位於專案根目錄。所有指令在此目錄下執行（即 SKILL.md 所在目錄）。

## 指令對照

使用者說的話 → 執行的指令：

| 使用者意圖 | 指令 |
|-----------|------|
| 查價格 / price | `npx tsx scripts/check-price.ts <幣對>` |
| 查餘額 / balance | `npx tsx scripts/check-balance.ts` |
| 跑策略 / strategy | `npx tsx scripts/run-strategy.ts <策略> <幣對> --json` |
| 回測 / backtest | `npx tsx scripts/backtest.ts <策略> <幣對> <間隔> <數量>` |
| 自動交易狀態 | `npx tsx src/index.ts auto` |
| 啟用自動交易 | `npx tsx src/index.ts auto enable <策略> <幣對> <間隔>` |
| 停用自動交易 | `npx tsx src/index.ts auto disable <策略> <幣對>` |
| 風控狀態 / risk | `npx tsx src/index.ts risk` |
| 績效 / performance | `npx tsx src/index.ts performance` |
| 交易紀錄 / trades | `npx tsx src/index.ts trades` |
| 未成交訂單 | `npx tsx src/index.ts orders <幣對>` |

## 預設值

- 幣對預設 `BTCUSDT`
- 回測間隔預設 `1h`，數量預設 `500`
- 可用策略：`ma-cross`、`rsi`、`grid`

## 執行規則

1. 所有指令加 `--json` flag（如有支援），方便解析結果
2. 執行前先 `cd` 到 SKILL.md 所在目錄（專案根目錄）
3. 使用 `exec` 工具執行，設 `timeout: 30`（回測可設 60）
4. 解析 JSON 輸出，轉換為人類友善的 Discord 訊息格式
5. 價格和金額顯示千位分隔符號
6. 回測結果摘要重點：報酬率、勝率、最大回撤、vs 買入持有

## 自動交易排程

用 OpenClaw cron 設定定時執行：

```
排程指令：npx tsx scripts/auto-trade.ts --json
工作目錄：SKILL.md 所在目錄（專案根目錄）
建議間隔：5 分鐘
```

auto-trade.ts 內建防重疊（lock file），安全重複呼叫。

解析 `--json` 輸出的 `results` 陣列：
- `status: "executed"` → 回報交易結果（BUY/SELL/HOLD）
- `status: "risk-blocked"` → 回報風控攔截原因
- `status: "skipped"` → 靜默（尚未到期）
- `status: "error"` → 回報錯誤

只有 executed 含 BUY/SELL 和 risk-blocked 時需要主動通知使用者。

## 輸出格式（Discord）

價格查詢：
```
📈 BTCUSDT: 66,879.38 USDT【測試網】
```

策略執行：
```
🟢 MA Cross 買入 BTCUSDT
💰 成交價：66,879.38 USDT
📦 數量：0.001500 BTC
🆔 訂單：#12345678
```

風控攔截：
```
⛔ 風控攔截：單日虧損已達上限 (-500.00 USDT)
```

回測摘要：
```
📊 MA Cross 回測結果（BTCUSDT 1h × 500）
💰 報酬率：+2.35%
🎯 勝率：60.0%（6/10）
⚠️ 最大回撤：1.82%
📋 買入持有：-1.27% → 🏆 策略勝出！
```

## 安全提醒

- 目前連接 **Binance Testnet**，使用測試資金
- 切換主網需要修改 `.env` 並設定安全鎖
- 不要在公開頻道顯示 API Key 相關資訊
