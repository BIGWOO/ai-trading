/**
 * 交易記錄模組
 * 用本地 JSON 檔存交易記錄，並提供績效分析
 * 績效計算使用 FIFO 按數量撮合
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const TRADES_FILE = join(DATA_DIR, 'trades.json');

// ===== 型別定義 =====

export interface TradeRecord {
  /** 時間戳（毫秒） */
  timestamp: number;
  /** 交易對 */
  symbol: string;
  /** 買賣方向 */
  side: 'BUY' | 'SELL';
  /** 成交價格 */
  price: string;
  /** 成交數量 */
  quantity: string;
  /** 使用的策略 */
  strategy: string;
  /** 訂單 ID */
  orderId: number;
  /** 交易原因 */
  reason: string;
}

export interface TradeFilter {
  symbol?: string;
  side?: 'BUY' | 'SELL';
  strategy?: string;
  startTime?: number;
  endTime?: number;
}

export interface Performance {
  /** 總交易次數 */
  totalTrades: number;
  /** 買入次數 */
  buyCount: number;
  /** 賣出次數 */
  sellCount: number;
  /** 總損益（USDT） */
  totalPnL: string;
  /** 勝率 */
  winRate: string;
  /** 獲利交易次數 */
  winCount: number;
  /** 虧損交易次數 */
  lossCount: number;
  /** 最大單筆獲利 */
  maxWin: string;
  /** 最大單筆虧損 */
  maxLoss: string;
  /** 最大回撤 */
  maxDrawdown: string;
}

// ===== 初始化 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(TRADES_FILE)) {
    writeFileSync(TRADES_FILE, '[]', 'utf-8');
  }
}

function readTrades(): TradeRecord[] {
  ensureDataDir();
  const raw = readFileSync(TRADES_FILE, 'utf-8');
  return JSON.parse(raw) as TradeRecord[];
}

function writeTrades(trades: TradeRecord[]): void {
  ensureDataDir();
  writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2), 'utf-8');
}

// ===== 公開函式 =====

/** 記錄一筆交易 */
export async function recordTrade(trade: TradeRecord): Promise<void> {
  const trades = readTrades();
  trades.push(trade);
  writeTrades(trades);
  console.log(`💾 交易已記錄：${trade.side} ${trade.quantity} ${trade.symbol} @ ${trade.price}`);
}

/** 查詢交易記錄 */
export async function getTrades(filter?: TradeFilter): Promise<TradeRecord[]> {
  let trades = readTrades();

  if (filter) {
    const filterSymbol = filter.symbol;
    const filterSide = filter.side;
    const filterStrategy = filter.strategy;
    const filterStartTime = filter.startTime;
    const filterEndTime = filter.endTime;

    if (filterSymbol) {
      trades = trades.filter((t) => t.symbol === filterSymbol.toUpperCase());
    }
    if (filterSide) {
      trades = trades.filter((t) => t.side === filterSide);
    }
    if (filterStrategy) {
      trades = trades.filter((t) => t.strategy === filterStrategy);
    }
    if (filterStartTime !== undefined) {
      trades = trades.filter((t) => t.timestamp >= filterStartTime);
    }
    if (filterEndTime !== undefined) {
      trades = trades.filter((t) => t.timestamp <= filterEndTime);
    }
  }

  return trades;
}

/** 計算績效（FIFO 按數量撮合） */
export async function getPerformance(filter?: TradeFilter): Promise<Performance> {
  const trades = await getTrades(filter);

  if (trades.length === 0) {
    return {
      totalTrades: 0,
      buyCount: 0,
      sellCount: 0,
      totalPnL: '0',
      winRate: '0',
      winCount: 0,
      lossCount: 0,
      maxWin: '0',
      maxLoss: '0',
      maxDrawdown: '0',
    };
  }

  const buyCount = trades.filter((t) => t.side === 'BUY').length;
  const sellCount = trades.filter((t) => t.side === 'SELL').length;

  // FIFO 按數量撮合（按幣對分桶，避免跨幣種錯配）
  interface BuyEntry {
    price: number;
    remainingQty: number;
  }

  const buyStacks = new Map<string, BuyEntry[]>();
  const pnlList: number[] = [];

  for (const trade of trades) {
    const qty = parseFloat(trade.quantity);
    const price = parseFloat(trade.price);
    const sym = trade.symbol;

    if (trade.side === 'BUY') {
      if (!buyStacks.has(sym)) buyStacks.set(sym, []);
      buyStacks.get(sym)!.push({ price, remainingQty: qty });
    } else if (trade.side === 'SELL') {
      const stack = buyStacks.get(sym) ?? [];
      // 從該幣對的 FIFO 堆疊消耗數量
      let remainingSellQty = qty;
      let sellPnL = 0;

      while (remainingSellQty > 0 && stack.length > 0) {
        const buyEntry = stack[0];
        const matchQty = Math.min(remainingSellQty, buyEntry.remainingQty);

        sellPnL += matchQty * (price - buyEntry.price);
        buyEntry.remainingQty -= matchQty;
        remainingSellQty -= matchQty;

        // 如果這筆買入已消耗完，移除
        if (buyEntry.remainingQty <= 1e-10) {
          stack.shift();
        }
      }

      // 未配對的賣出部分忽略（可能是外部轉入的幣）
      pnlList.push(sellPnL);
    }
  }

  const winTrades = pnlList.filter((p) => p > 0);
  const lossTrades = pnlList.filter((p) => p <= 0);
  const totalPnL = pnlList.reduce((sum, p) => sum + p, 0);

  // 計算最大回撤
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  for (const pnl of pnlList) {
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    totalTrades: trades.length,
    buyCount,
    sellCount,
    totalPnL: totalPnL.toFixed(4),
    winRate: pnlList.length > 0 ? (winTrades.length / pnlList.length * 100).toFixed(2) : '0',
    winCount: winTrades.length,
    lossCount: lossTrades.length,
    maxWin: winTrades.length > 0 ? Math.max(...winTrades).toFixed(4) : '0',
    maxLoss: lossTrades.length > 0 ? Math.min(...lossTrades).toFixed(4) : '0',
    maxDrawdown: maxDrawdown.toFixed(4),
  };
}
