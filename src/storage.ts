/**
 * 交易記錄模組
 * 用本地 JSON 檔存交易記錄，並提供績效分析
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
    if (filter.symbol) {
      trades = trades.filter((t) => t.symbol === filter.symbol.toUpperCase());
    }
    if (filter.side) {
      trades = trades.filter((t) => t.side === filter.side);
    }
    if (filter.strategy) {
      trades = trades.filter((t) => t.strategy === filter.strategy);
    }
    if (filter.startTime) {
      trades = trades.filter((t) => t.timestamp >= filter.startTime!);
    }
    if (filter.endTime) {
      trades = trades.filter((t) => t.timestamp <= filter.endTime!);
    }
  }

  return trades;
}

/** 計算績效 */
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

  // 計算損益：配對買賣交易
  // 簡單方法：按時間順序，每個 SELL 匹配最近的 BUY
  const pnlList: number[] = [];
  const buyStack: TradeRecord[] = [];

  for (const trade of trades) {
    if (trade.side === 'BUY') {
      buyStack.push(trade);
    } else if (trade.side === 'SELL' && buyStack.length > 0) {
      const buyTrade = buyStack.shift()!;
      const buyValue = parseFloat(buyTrade.price) * parseFloat(buyTrade.quantity);
      const sellValue = parseFloat(trade.price) * parseFloat(trade.quantity);
      pnlList.push(sellValue - buyValue);
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
