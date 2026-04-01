/**
 * Backtest Engine — 獨立回測引擎
 *
 * 與 scripts/backtest.ts 不同：
 * - 接受 closePrices + strategy + overrides，不需要 API 呼叫
 * - 回傳結構化 BacktestResult（含 Sharpe Ratio、Profit Factor）
 * - 使用 10% 倉位（TRADE_RATIO = 0.1），與實盤一致
 *
 * Phase A-1: Self-Evolution Plan v7
 */

import type { BacktestableStrategy, AnalysisResult } from './strategies/base.js';

// ===== 型別定義 =====

export interface BacktestTrade {
  /** 買入 K 線 index */
  buyIndex: number;
  /** 買入價格 */
  buyPrice: number;
  /** 賣出 K 線 index */
  sellIndex: number;
  /** 賣出價格 */
  sellPrice: number;
  /** 買入數量 */
  quantity: number;
  /** 損益（USDT） */
  pnl: number;
  /** 報酬率（百分比） */
  returnPct: number;
}

export interface BacktestResult {
  /** 總報酬率（百分比） */
  totalReturn: number;
  /** 交易次數（完整 buy+sell 循環） */
  tradeCount: number;
  /** 勝率（百分比） */
  winRate: number;
  /** 最大回撤（百分比，正數表示） */
  maxDrawdown: number;
  /** Sharpe Ratio（年化，假設無風險利率 0） */
  sharpeRatio: number;
  /** Profit Factor（grossProfit / grossLoss） */
  profitFactor: number;
  /** 交易明細 */
  trades: BacktestTrade[];
  /** Buy & Hold 報酬率（百分比） */
  buyHoldReturn: number;
}

// ===== 常數 =====

/** 預設倉位比例（與實盤一致） */
const DEFAULT_TRADE_RATIO = 0.1;

/** 年化 Sharpe 的倍數對照表（K 線間隔 → 年化因子） */
const ANNUALIZATION_FACTORS: Record<string, number> = {
  '1m': Math.sqrt(525600),   // 1 年 ≈ 525600 分鐘
  '5m': Math.sqrt(105120),
  '15m': Math.sqrt(35040),
  '30m': Math.sqrt(17520),
  '1h': Math.sqrt(8760),     // 1 年 ≈ 8760 小時
  '2h': Math.sqrt(4380),
  '4h': Math.sqrt(2190),
  '1d': Math.sqrt(365),
  '1w': Math.sqrt(52),
};

// ===== 回測引擎 =====

/**
 * 執行回測
 *
 * @param closePrices - 收盤價陣列（string[]）
 * @param strategy - 可回測的策略
 * @param overrides - 覆蓋策略參數
 * @param options - 額外選項
 * @returns BacktestResult
 */
export function runBacktest(
  closePrices: string[],
  strategy: BacktestableStrategy,
  overrides?: Record<string, number>,
  options?: {
    /** 初始資金（預設 10000 USDT） */
    initialCapital?: number;
    /** 倉位比例（預設 0.1） */
    tradeRatio?: number;
    /** K 線間隔（用於年化 Sharpe，預設 '1h'） */
    interval?: string;
    /** 回測起始 index（預設從最小需求 index 開始） */
    startIndex?: number;
    /** 回測結束 index（預設到最後一根） */
    endIndex?: number;
    /** 手續費率（預設 0.001，即 0.1%，Binance Spot 標準費率）。買賣各扣一次。 */
    commissionRate?: number;
  },
): BacktestResult {
  const initialCapital = options?.initialCapital ?? 10000;
  const tradeRatio = options?.tradeRatio ?? DEFAULT_TRADE_RATIO;
  const interval = options?.interval ?? '1h';
  const startIndex = options?.startIndex ?? 0;
  const endIndex = options?.endIndex ?? closePrices.length;
  const commissionRate = options?.commissionRate ?? 0.001; // Binance 預設 0.1% 手續費

  if (closePrices.length < 2) {
    return emptyResult(closePrices);
  }

  // 狀態
  let capital = initialCapital;
  let position: { buyIndex: number; buyPrice: number; quantity: number } | null = null;
  const trades: BacktestTrade[] = [];
  const equityCurve: number[] = [];

  // 逐根 K 線跑策略
  for (let i = startIndex; i < endIndex; i++) {
    const analysis: AnalysisResult = strategy.analyzeKlines(closePrices, i, overrides);
    const currentPrice = parseFloat(closePrices[i]);

    if (analysis.signal === 'BUY' && !position) {
      // 開倉：使用 tradeRatio 比例的資金
      const tradeAmount = capital * tradeRatio;
      // 扣除買入手續費：實際得到的幣量 = tradeAmount / price * (1 - commission)
      const quantity = (tradeAmount / currentPrice) * (1 - commissionRate);

      if (quantity > 0) {
        position = {
          buyIndex: i,
          buyPrice: currentPrice,
          quantity,
        };
        capital -= tradeAmount;
      }
    } else if (analysis.signal === 'SELL' && position) {
      // 平倉：扣除賣出手續費
      const grossSellValue = position.quantity * currentPrice;
      const sellCommission = grossSellValue * commissionRate;
      const netSellValue = grossSellValue - sellCommission;
      // 真正的成本 = 買入時實際花的 USDT = quantity * buyPrice / (1 - commissionRate)
      const actualCost = position.quantity * position.buyPrice / (1 - commissionRate);
      const pnl = netSellValue - actualCost;
      const returnPct = actualCost > 0 ? (pnl / actualCost) * 100 : 0;

      trades.push({
        buyIndex: position.buyIndex,
        buyPrice: position.buyPrice,
        sellIndex: i,
        sellPrice: currentPrice,
        quantity: position.quantity,
        pnl,
        returnPct,
      });

      capital += netSellValue;
      position = null;
    }

    // 計算當前權益（含未平倉部位）
    const unrealizedValue = position ? position.quantity * currentPrice : 0;
    equityCurve.push(capital + unrealizedValue);
  }

  // 若結束時仍有未平倉部位，按最後價格計算（但不算一筆交易）
  const finalEquity = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1]
    : initialCapital;

  // ===== 統計計算 =====

  const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;
  const tradeCount = trades.length;

  // 勝率
  const winTrades = trades.filter((t) => t.pnl > 0);
  const winRate = tradeCount > 0 ? (winTrades.length / tradeCount) * 100 : 0;

  // 最大回撤
  const maxDrawdown = calculateMaxDrawdown(equityCurve);

  // Sharpe Ratio（年化）
  const sharpeRatio = calculateSharpeRatio(equityCurve, interval);

  // Profit Factor
  const profitFactor = calculateProfitFactor(trades);

  // Buy & Hold 報酬率
  const firstPrice = parseFloat(closePrices[startIndex] || closePrices[0]);
  const lastPrice = parseFloat(closePrices[endIndex - 1] || closePrices[closePrices.length - 1]);
  const buyHoldReturn = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

  return {
    totalReturn,
    tradeCount,
    winRate,
    maxDrawdown,
    sharpeRatio,
    profitFactor,
    trades,
    buyHoldReturn,
  };
}

// ===== 統計工具函式 =====

/**
 * 計算最大回撤（百分比，正數表示）
 */
function calculateMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;

  let peak = equityCurve[0];
  let maxDD = 0;

  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return maxDD * 100; // 轉百分比
}

/**
 * 計算年化 Sharpe Ratio（假設無風險利率 = 0）
 *
 * Sharpe = mean(returns) / std(returns) × sqrt(N)
 * 其中 N 為每年的交易頻率（由 K 線間隔決定）
 */
function calculateSharpeRatio(equityCurve: number[], interval: string): number {
  if (equityCurve.length < 2) return 0;

  // 計算逐期報酬率
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i - 1] > 0) {
      returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
    }
  }

  if (returns.length === 0) return 0;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);

  if (std === 0) return mean > 0 ? Infinity : mean < 0 ? -Infinity : 0;

  const annualizationFactor = ANNUALIZATION_FACTORS[interval] ?? Math.sqrt(8760);
  return (mean / std) * annualizationFactor;
}

/**
 * 計算 Profit Factor（grossProfit / grossLoss）
 */
function calculateProfitFactor(trades: BacktestTrade[]): number {
  let grossProfit = 0;
  let grossLoss = 0;

  for (const t of trades) {
    if (t.pnl > 0) grossProfit += t.pnl;
    else if (t.pnl < 0) grossLoss += Math.abs(t.pnl);
  }

  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
  return grossProfit / grossLoss;
}

/**
 * 回傳空結果（K 線不足時）
 */
function emptyResult(closePrices: string[]): BacktestResult {
  const firstPrice = closePrices.length > 0 ? parseFloat(closePrices[0]) : 0;
  const lastPrice = closePrices.length > 0 ? parseFloat(closePrices[closePrices.length - 1]) : 0;
  return {
    totalReturn: 0,
    tradeCount: 0,
    winRate: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    profitFactor: 0,
    trades: [],
    buyHoldReturn: firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0,
  };
}
