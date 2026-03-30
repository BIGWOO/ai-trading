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

[快速開始](#-快速開始) · [交易策略](#-交易策略) · [自動交易](#-自動交易) · [風控系統](#-風控系統) · [回測](#-歷史回測) · [架構](#-專案架構)

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

---

## 🏗️ 專案架構

```
ai-trading/
├── src/
│   ├── binance.ts          # Binance API 封裝（HMAC 簽名、延遲載入、URL 白名單）
│   ├── index.ts            # CLI 統一入口
│   ├── trade-executor.ts   # 統一交易執行包裝器（風控 → 分析 → 執行 → 記錄）
│   ├── risk-control.ts     # 四層風控引擎
│   ├── position.ts         # 持倉管理（FIFO by symbol）
│   ├── storage.ts          # 交易紀錄持久化
│   ├── scheduler.ts        # 自動交易排程管理
│   ├── strategies/
│   │   ├── base.ts         # 策略介面定義
│   │   ├── ma-cross.ts     # MA7/MA25 交叉策略
│   │   ├── rsi.ts          # RSI(14) 超買超賣策略
│   │   └── grid.ts         # 網格交易策略
│   └── utils/
│       └── atomic-write.ts # 原子 JSON 寫入工具
├── scripts/
│   ├── check-balance.ts    # 查餘額
│   ├── check-price.ts      # 查價格
│   ├── run-strategy.ts     # 單次策略執行
│   ├── backtest.ts         # 歷史回測
│   └── auto-trade.ts       # 自動交易入口（含 lock file）
├── data/                   # 執行時狀態資料（git ignored）
├── .env.example            # 環境變數範例
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

## 🤖 AI 代理整合（OpenClaw 一鍵安裝）

本專案內建 [OpenClaw](https://github.com/openclaw/openclaw) Skill，安裝後你可以在 Discord 中用自然語言操作交易系統。

### 一鍵安裝

把下面這段 prompt 貼給你的 OpenClaw agent，它會自動完成所有設定：

> **📋 複製貼上這段 prompt：**

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

Agent 會一步步執行，中間只會停下來問你要 API Key。

### 安裝完成後你可以

- 「查一下 BTC 價格」→ 即時行情
- 「用 RSI 策略分析 ETHUSDT」→ 執行策略
- 「回測 MA Cross 4 小時 200 根」→ 歷史回測
- 「啟用自動交易 ma-cross BTCUSDT 每小時」→ 定時策略
- 「看風控狀態」→ 四層風控儀表板
- 「看績效」→ 交易績效統計

---

## ⚠️ 風險聲明

> **加密貨幣交易具有高度風險。** 本專案僅供教育與研究用途。
> 在使用真實資金之前，請確保你充分了解交易風險，並在測試網上進行充分驗證。
> 作者不對任何交易損失負責。

---

## 📄 License

[MIT](LICENSE)
