<div align="center">

# 🤖 AI Trading

**用 AI 代理人自動交易加密貨幣**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Binance](https://img.shields.io/badge/Binance-API-F0B90B?logo=binance&logoColor=black)](https://www.binance.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一套完整的加密貨幣自動交易系統。<br>
內建多種交易策略、四層風控保護、歷史回測，以及 AI 代理人整合能力。<br>
**從零到自動交易，只需要 5 分鐘。**

[AI 一鍵安裝](#-用-ai-幫你裝好一切推薦) · [手動安裝](#-快速開始) · [交易策略](#-交易策略) · [自動交易](#-自動交易) · [風控系統](#-風控系統) · [回測](#-歷史回測)

</div>

---

## ✨ 特色

- 🔐 **安全至上** — Testnet/Mainnet 交叉驗證、主網安全鎖、多層環境保護
- 📊 **三大策略** — MA 交叉、RSI 超買超賣、網格交易，涵蓋趨勢與震盪行情
- 🛡️ **四層風控** — 單日虧損上限、最大交易次數、連續虧損熔斷、淨值回撤保護
- ⚡ **原子操作** — 所有狀態檔案使用 temp-file + rename 原子寫入，crash-safe
- 🤖 **AI 代理整合** — 搭配 [OpenClaw](https://github.com/openclaw/openclaw) 實現 Discord 指令操作
- 📈 **歷史回測** — 用真實 K 線數據驗證策略績效
- 🏗️ **零依賴架構** — 僅使用 Node.js 原生 `crypto`、`fetch`，無第三方 HTTP 庫
- 📐 **Walk-Forward 優化** — 多折 out-of-sample 測試 + Holdout 閘門，自動找出最佳參數
- 🧬 **自我進化系統** — 10 步驟全自動策略進化，含 Probation 保護期與 Mode B 回滾
- 🌍 **市場狀態偵測** — ADX/DI/ATR 四態分類（上升/下降/橫盤/高波動）
- 📓 **交易日誌與覆盤** — JSONL 格式永久記錄，自動分析勝率與調參建議
- 📋 **日報 / 週報** — 每日 PnL 統計 + 七天走勢 emoji 圖表，自動推送 Discord

---

## 🤖 用 AI 幫你裝好一切（推薦）

> 有 [OpenClaw](https://github.com/openclaw/openclaw)？把下面這段貼給你的 AI agent，它會自動搞定所有設定。
> 你只需要提供一組 [Binance Testnet](https://testnet.binance.vision/) API Key。

**📋 複製這段 prompt 貼給 Agent：**

```
幫我安裝 ai-trading skill。步驟：

1. Clone 專案：git clone https://github.com/BIGWOO/ai-trading.git ~/repos/ai-trading
2. 安裝依賴：cd ~/repos/ai-trading && npm install
3. 建立 .env：cp .env.example .env
4. 建立 skill symlink：ln -sf ~/repos/ai-trading ~/.openclaw/workspace/skills/ai-trading
5. 請我提供 Binance Testnet API Key（從 https://testnet.binance.vision/ 取得）
6. 把我提供的 API Key 填入 .env 的 BINANCE_API_KEY 和 BINANCE_SECRET_KEY
7. 驗證連線：執行 npx tsx scripts/check-balance.ts 確認能看到餘額
8. 驗證策略：執行 npx tsx scripts/run-strategy.ts ma-cross BTCUSDT 確認策略正常
9. 完成後告訴我怎麼用（查價格、跑策略、回測、自動交易）
```

安裝完成後直接用自然語言操作：

- 「查一下 BTC 價格」→ 即時行情
- 「用 RSI 策略分析 ETHUSDT」→ 執行策略
- 「回測 MA Cross 4 小時 200 根」→ 歷史回測
- 「啟用自動交易 ma-cross BTCUSDT 每小時」→ 定時策略
- 「看風控狀態」→ 四層風控儀表板

> 💡 沒有 OpenClaw？往下看[手動安裝](#-快速開始)。

---

## 📦 環境需求

- [Node.js](https://nodejs.org/) 18 以上（使用原生 `fetch`）
- npm 或 pnpm
- [Binance Testnet](https://testnet.binance.vision/) 帳號（免費）

## 🚀 快速開始

### 1. Clone & 安裝

```bash
git clone https://github.com/BIGWOO/ai-trading.git
cd ai-trading
npm install
```

### 2. 設定 API Key

前往 [Binance Testnet](https://testnet.binance.vision/)，用 GitHub 登入後產生 API Key。

```bash
cp .env.example .env
```

編輯 `.env`，填入你的 API Key：

```env
BINANCE_API_KEY=your_api_key_here
BINANCE_SECRET_KEY=your_secret_key_here
BINANCE_TESTNET=true
BINANCE_BASE_URL=https://testnet.binance.vision
```

### 3. 驗證連線

```bash
# 查看帳戶餘額
npx tsx scripts/check-balance.ts

# 查看即時價格
npx tsx scripts/check-price.ts BTCUSDT
```

看到餘額和價格就表示連線成功 🎉

---

## 📊 交易策略

### MA Cross（均線交叉）

利用短期均線（MA7）與長期均線（MA25）的交叉關係判斷趨勢方向。

| 訊號 | 條件 | 說明 |
|------|------|------|
| 🟢 買入 | MA7 由下往上穿越 MA25 | 短期動能轉強，趨勢向上 |
| 🔴 賣出 | MA7 由上往下穿越 MA25 | 短期動能轉弱，趨勢向下 |

```bash
npx tsx scripts/run-strategy.ts ma-cross BTCUSDT
```

### RSI（相對強弱指標）

RSI(14) 衡量價格變動的速度與幅度，識別超買超賣區間。

| 訊號 | 條件 | 說明 |
|------|------|------|
| 🟢 買入 | RSI < 30 並回升 | 超賣區反轉，可能觸底反彈 |
| 🔴 賣出 | RSI > 70 並回落 | 超買區反轉，可能見頂回落 |

```bash
npx tsx scripts/run-strategy.ts rsi ETHUSDT
```

### Grid（網格交易）

在設定的價格區間內等距掛買賣限價單，適合震盪盤整行情。自動偵測缺口並補單。

```bash
npx tsx scripts/run-strategy.ts grid BTCUSDT
```

---

## 📐 Walk-Forward 優化

用真實歷史數據做 **out-of-sample** 參數優化，避免過度擬合：

```bash
# 優化 MA Cross 策略（BTCUSDT 1h，500 根 K 線）
npx tsx scripts/optimize.ts ma-cross BTCUSDT 1h 500

# 優化 RSI 策略（ETHUSDT 4h）
npx tsx scripts/optimize.ts rsi ETHUSDT 4h 300
```

### 優化流程

```
全部 K 線（N 根）
├── 可用集（85%）
│   ├── Fold 1: Train [0→A) → Test [A→B)
│   ├── Fold 2: Train [0→B) → Test [B→C)  ← Anchored Expanding
│   └── Fold 3: Train [0→C) → Test [C→D)
└── Holdout（最後 15%，最終驗證，不參與訓練/測試）
```

### 閘門條件（全部通過才採用參數）

| 閘門 | 條件 |
|------|------|
| ① 交易次數 | 每折 ≥ 3 筆 |
| ② 平均 Sharpe | > 0 |
| ③ Holdout Sharpe | > 0 |
| ④ 各折最大回撤 | < 15% |

### 輸出範例

```
🔬 Walk-Forward 參數優化
═══════════════════════════════════════
  策略：ma-cross  幣對：BTCUSDT  間隔：1h  K線數：500

📐 Fold 配置：
  Fold 1: Train [0-212) → Test [212-283)
  Fold 2: Train [0-283) → Test [283-354)
  Fold 3: Train [0-354) → Test [354-424)
  Holdout: [424-499)

🏆 最佳參數組合：
  shortPeriod: 7
  longPeriod: 25
  平均 Sharpe: 0.8523

📊 各折結果：
  Fold 1: Return=3.21% | Sharpe=0.9102 | Trades=8 | DD=4.12% | WR=62.5%
  Fold 2: Return=1.87% | Sharpe=0.7241 | Trades=6 | DD=3.55% | WR=50.0%
  Fold 3: Return=2.54% | Sharpe=0.9227 | Trades=7 | DD=5.01% | WR=57.1%

🔒 Holdout 結果：
  Return=1.95% | Sharpe=0.8100 | Trades=5 | DD=2.88% | WR=60.0%

✅ 通過所有閘門！
```

> **注意：** Grid 策略不參與 Walk-Forward 優化（網格策略靠人工設定區間）。

---

## 🧬 自我進化系統

每天自動執行 10 步驟進化，讓策略參數跟上市場變化：

```bash
# 手動觸發一次進化
npx tsx scripts/evolve.ts

# 或透過 CLI
npx tsx src/index.ts evolve

# JSON 模式（供 cron 解析）
npx tsx scripts/evolve.ts --json
```

### 進化流程（v7 Self-Evolution Plan）

```
Step 1  讀取 config-envelope → 確認 evolution.enabled = true
Step 2  acquireLock('evolve')  ← 防止併發進化
Step 3  Probation 檢查
        ├─ 到期 → 🎓 畢業，解除 close-only 限制
        ├─ Drawdown < 閾值 → 🔙 Mode A 回滾到前版本
        └─ 進行中 → ⏭️ 跳過優化，等待
Step 4  偵測市場狀態（ADX/DI/ATR）
Step 5  覆盤最近 7 天交易（勝率、PnL、建議）
Step 6  Walk-Forward 優化（排除 Grid）
Step 7  通過閘門 → CAS 更新 config-envelope + 啟動 Probation
        ├─ 參數變化超過 ±30% → 跳過，避免激進調整
        └─ Probation 期間：以 Drawdown 監控新參數表現
Step 8  策略切換評估（需先確認平倉）
Step 9  Mode B 回滾檢查
        └─ 連續 3 次優化績效衰退 + 確認無持倉 → 回滾到 lastStableVersion
Step 10 輸出進化摘要
```

### 啟用自動進化

在 `data/config-envelope.json` 中開啟：

```json
{
  "evolutionConfig": {
    "enabled": true,
    "intervalHours": 24,
    "probationHours": 48,
    "rollbackThresholdPercent": -5,
    "adjustmentLimit": 0.3
  }
}
```

> ⚠️ **Probation 保護期**：每次參數更新後，系統進入 `probationHours` 的觀察期。若 Drawdown 超過 `rollbackThresholdPercent`（預設 -5%），自動回滾到前版本並加入 close-only 清單，等待平倉後才解除。

---

## 🌍 市場狀態偵測

用 ADX（平均方向指標）和 ATR（真實波幅）自動分類當前市場狀態：

```bash
# 偵測 BTCUSDT 當前市場狀態
npx tsx src/index.ts regime

# 指定幣對
npx tsx src/index.ts regime ETHUSDT
```

### 四種市場狀態

| 狀態 | 判斷條件 | 說明 |
|------|----------|------|
| 📈 上升趨勢 | ADX > 25 且 +DI > -DI | 趨勢明確向上，適合趨勢跟隨策略 |
| 📉 下降趨勢 | ADX > 25 且 -DI > +DI | 趨勢明確向下，謹慎操作 |
| ↔️ 橫盤整理 | ADX < 20 | 無明顯趨勢，適合網格或 RSI 策略 |
| 🌊 高波動 | ATR/Price > 3% | 波動劇烈，風控優先 |

```
🌍 BTCUSDT 市場狀態：
═══════════════════════════════════════
  📈 上升趨勢（ADX = 31.4，+DI = 28.7 > -DI = 15.2）
  ADX: 31.4 | +DI: 28.7 | -DI: 15.2
  ATR/Price: 1.23%
```

---

## 📓 交易日誌與覆盤

每筆交易自動寫入 `data/trade-journal.jsonl`，包含指標快照和市場狀態。

```bash
# 查看最近 10 筆交易日誌
npx tsx src/index.ts journal

# 查看最近 20 筆
npx tsx src/index.ts journal 20

# 覆盤最近 7 天
npx tsx src/index.ts review

# 覆盤最近 14 天
npx tsx src/index.ts review 14
```

### 覆盤輸出

```
📋 交易覆盤（過去 7 天）
═══════════════════════════════════════
  📊 總交易次數：12
  🟢 買入：6  🔴 賣出：6  ⏸️ 觀望：24
  💰 總損益：+8.42 USDT
  🎯 勝率：66.7%
  📈 平均損益：+1.40 USDT

💡 建議：
  ✅ 勝率優秀（> 70%），當前參數表現良好
```

---

## 📋 日報 / 週報

自動彙整交易數據，生成人類友善的 Discord 格式報告。

```bash
# 日報（過去 24 小時）
npx tsx scripts/daily-report.ts
npx tsx src/index.ts report daily

# 週報（過去 7 天）
npx tsx scripts/weekly-report.ts
npx tsx src/index.ts report weekly

# JSON 模式（供自動化解析）
npx tsx scripts/daily-report.ts --json
npx tsx scripts/weekly-report.ts --json
```

### 日報範例

```
📊 日報 — 2026/04/01

🌍 市場狀態：📈 上升趨勢
⚙️ Config Version: v7

📈 交易摘要
• 交易次數：4（🟢 2 買 / 🔴 2 賣）
• 總損益：📈 +5.32 USDT
• 勝率：100.0%（✅ 2 勝 / ❌ 0 敗）
• 最大回撤：0.00 USDT
```

### 週報範例（含每日 PnL 圖表）

```
📊 週報 — 2026/03/26 ~ 2026/04/01

📈 一週概覽
• 總交易次數：28
• 總損益：📈 +32.18 USDT
• 勝率：64.3%

📅 每日 PnL
• 03/26 🟩🟩🟩 +8.20 (4 筆)
• 03/27 🟥🟥 -3.10 (2 筆)
• 03/28 🟩🟩🟩🟩 +12.50 (6 筆)
• 03/29 ── 0.00 (0 筆)
• 03/30 🟩🟩 +5.80 (3 筆)
• 03/31 🟥 -1.42 (2 筆)
• 04/01 🟩🟩🟩 +10.20 (4 筆)

🧬 進化事件
• 🔬 03/29 [optimization] ma-cross: Walk-Forward 優化通過 (Sharpe: 0.8523)
• 🎓 03/31 [graduation] ma-cross: Probation 到期，參數畢業
```

---

## 🔄 自動交易

啟用自動交易後，系統會按照設定的間隔自動執行策略。所有交易都經過風控檢查。

```bash
# 啟用：每小時用 MA Cross 策略交易 BTCUSDT
npx tsx src/index.ts auto enable ma-cross BTCUSDT 1h

# 查看狀態
npx tsx src/index.ts auto

# 停用
npx tsx src/index.ts auto disable ma-cross BTCUSDT
```

### 排程執行

自動交易透過外部排程（cron 或 AI 代理人）定時呼叫：

```bash
# crontab 範例：每 5 分鐘執行一次
*/5 * * * * cd /path/to/ai-trading && npx tsx scripts/auto-trade.ts --json >> logs/auto-trade.log 2>&1
```

自動交易內建防重疊機制（atomic lock file），即使排程間隔小於執行時間也不會重複執行。

---

## 🛡️ 風控系統

四道防線，確保你的資金安全：

```
┌─────────────────────────────────────────────┐
│              交易請求進入                      │
├─────────────────────────────────────────────┤
│  🔒 第一層：單日最大虧損（預設 -500 USDT）      │
│  🔒 第二層：單日最大交易次數（預設 20 次）       │
│  🔒 第三層：連續虧損熔斷（預設 3 次）            │
│  🔒 第四層：淨值回撤保護（預設 10%）             │
├─────────────────────────────────────────────┤
│  ✅ 通過 → 執行交易    ⛔ 攔截 → 拒絕交易      │
└─────────────────────────────────────────────┘
```

```bash
# 查看風控狀態
npx tsx src/index.ts risk

# 重置當日風控（開新的一天）
npx tsx src/index.ts risk reset
```

### 風控特性

- **統一入口** — 所有執行路徑（手動、自動、CLI）都經過同一個風控檢查
- **Fail Closed** — 風控設定檔損壞時拒絕交易，不會退化到無保護狀態
- **原子寫入** — 風控狀態用 temp-file + rename 更新，crash 不會造成資料損壞
- **手續費感知** — PnL 計算包含 Binance 實際手續費，持倉量扣除 BUY 側佣金

---

## 📈 歷史回測

用真實歷史 K 線數據驗證策略表現：

```bash
# 用 500 根 1 小時 K 線回測 MA Cross
npx tsx scripts/backtest.ts ma-cross BTCUSDT 1h 500

# 用 200 根 4 小時 K 線回測 RSI
npx tsx scripts/backtest.ts rsi ETHUSDT 4h 200
```

回測輸出包含：
- 每筆交易的買入/賣出價格與損益
- 總報酬率、勝率、最大回撤
- 與「買入持有」策略的對照比較

---

## 🔐 安全機制

### Testnet 保護

系統啟動時會交叉驗證 `BINANCE_TESTNET` flag 與 `BINANCE_BASE_URL`，任何不一致都會直接拒絕啟動：

```
✅ TESTNET=true  + URL=testnet.binance.vision  → 正常
✅ TESTNET=false + URL=api.binance.com          → 正常（需額外安全確認）
❌ TESTNET=true  + URL=api.binance.com          → 拒絕啟動
❌ TESTNET=false + URL=testnet.binance.vision   → 拒絕啟動
```

### 主網安全鎖

切換到主網需要額外設定，防止誤操作：

```env
# 必須明確設定才能在主網下單
LIVE_TRADING_CONFIRM=yes-i-know-what-i-am-doing

# 單筆下單金額上限
MAX_ORDER_USDT=100
```

---

## 📋 完整指令

### 獨立腳本

| 指令 | 說明 |
|------|------|
| `npx tsx scripts/check-balance.ts` | 查看帳戶餘額 |
| `npx tsx scripts/check-price.ts [幣對]` | 查看即時行情 |
| `npx tsx scripts/run-strategy.ts <策略> [幣對] [--json]` | 執行單次策略 |
| `npx tsx scripts/backtest.ts <策略> [幣對] [間隔] [數量]` | 歷史回測 |
| `npx tsx scripts/auto-trade.ts [--json]` | 自動交易（排程呼叫） |
| `npx tsx scripts/optimize.ts <策略> [幣對] [間隔] [K線數]` | Walk-Forward 參數優化 |
| `npx tsx scripts/evolve.ts [--json]` | 手動觸發自我進化 |
| `npx tsx scripts/daily-report.ts [--json]` | 生成日報 |
| `npx tsx scripts/weekly-report.ts [--json]` | 生成週報 |

### CLI 統一入口

```bash
npx tsx src/index.ts <命令>
```

| 命令 | 說明 |
|------|------|
| `balance` | 查看帳戶餘額 |
| `price [幣對]` | 查看即時行情（預設 BTCUSDT） |
| `strategy <名稱> [幣對]` | 執行策略 |
| `backtest <名稱> [幣對]` | 回測策略 |
| `orders [幣對]` | 查看未成交訂單 |
| `history <幣對>` | 查看成交歷史 |
| `trades` | 查看本地交易紀錄 |
| `performance` | 查看績效統計 |
| `auto` | 查看自動交易狀態 |
| `auto enable <策略> <幣對> <間隔>` | 啟用自動交易 |
| `auto disable <策略> <幣對>` | 停用自動交易 |
| `risk` | 查看風控狀態 |
| `risk reset` | 重置當日風控 |
| `evolve` | 手動觸發自動進化 |
| `regime [幣對]` | 查看市場狀態（ADX/DI/ATR）|
| `journal [N]` | 查看最近 N 筆交易日誌（預設 10）|
| `review [天數]` | 覆盤最近 N 天交易（預設 7）|
| `report daily` | 日報（過去 24 小時）|
| `report weekly` | 週報（過去 7 天）|

---

## 🏗️ 專案架構

```
ai-trading/
├── src/
│   ├── binance.ts            # Binance API 封裝（HMAC 簽名、延遲載入、URL 白名單）
│   ├── index.ts              # CLI 統一入口
│   ├── trade-executor.ts     # 統一交易執行包裝器（風控 → 分析 → 執行 → 記錄）
│   ├── risk-control.ts       # 四層風控引擎
│   ├── position.ts           # 持倉管理（FIFO by symbol）
│   ├── storage.ts            # 交易紀錄持久化
│   ├── scheduler.ts          # 自動交易排程管理
│   ├── market-regime.ts      # 市場狀態偵測（ADX/DI/ATR，四態分類）
│   ├── trade-journal.ts      # 交易日誌（JSONL 格式持久化）
│   ├── trade-review.ts       # 交易覆盤分析與建議
│   ├── execution-context.ts  # 執行上下文 + 參數驗證（validateStrategyParams）
│   ├── backtest-engine.ts    # 回測引擎（供優化使用）
│   ├── strategy-config.ts    # 策略參數定義與預設值
│   ├── strategies/
│   │   ├── base.ts           # 策略介面定義
│   │   ├── ma-cross.ts       # MA7/MA25 交叉策略
│   │   ├── rsi.ts            # RSI(14) 超買超賣策略
│   │   └── grid.ts           # 網格交易策略
│   └── utils/
│       ├── atomic-write.ts   # 原子 JSON 寫入工具
│       ├── config-envelope.ts # ConfigEnvelope 讀寫（CAS 保護）
│       ├── config-ops.ts     # mutateEnvelope helper
│       ├── config-history.ts # 版本快照管理（rollback 來源）
│       ├── global-lock.ts    # 全域 fencing lock
│       ├── evolution-log.ts  # 進化事件日誌
│       ├── probation-runtime.ts # Probation 執行時狀態
│       └── flat-check.ts     # 平倉狀態檢查（Mode B 回滾用）
├── scripts/
│   ├── check-balance.ts      # 查餘額
│   ├── check-price.ts        # 查價格
│   ├── run-strategy.ts       # 單次策略執行
│   ├── backtest.ts           # 歷史回測
│   ├── auto-trade.ts         # 自動交易入口（含 lock file）
│   ├── optimize.ts           # Walk-Forward 參數優化
│   ├── evolve.ts             # 自我進化主程式（10 步驟）
│   ├── daily-report.ts       # 日報生成
│   └── weekly-report.ts      # 週報生成
├── data/                     # 執行時狀態資料（git ignored）
│   ├── config-envelope.json  # 策略設定控制平面（含 probation、evolutionConfig）
│   ├── trade-journal.jsonl   # 交易日誌（JSONL）
│   ├── evolution-log.jsonl   # 進化事件紀錄
│   └── _backup/              # 自動備份（遷移時產生）
├── .env.example              # 環境變數範例
├── tsconfig.json
└── package.json
```

### 交易流程

```
使用者指令 / 排程 / AI 代理
         │
         ▼
  ┌─────────────┐
  │ trade-executor │ ← 統一入口
  ├─────────────┤
  │ 1. 風控檢查   │ ← checkRisk()
  │ 2. 策略分析   │ ← strategy.analyze()
  │ 3. 執行交易   │ ← strategy.execute()
  │ 4. 風控記錄   │ ← recordTradeForRisk()
  └─────────────┘
         │
         ▼
  Binance API（HMAC 簽名）
```

---

## ⚠️ 風險聲明

> **加密貨幣交易具有高度風險。** 本專案僅供教育與研究用途。
> 在使用真實資金之前，請確保你充分了解交易風險，並在測試網上進行充分驗證。
> 作者不對任何交易損失負責。

---

## 📄 License

[MIT](LICENSE)
