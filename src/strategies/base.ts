/**
 * 策略基類定義
 * 所有交易策略都必須實作此介面
 */

import type { ExecutionContext } from '../execution-context.js';

export type Signal = 'BUY' | 'SELL' | 'HOLD';

export interface AnalysisResult {
  /** 交易訊號 */
  signal: Signal;
  /** 訊號強度 0~1 */
  strength: number;
  /** 訊號原因說明 */
  reason: string;
  /** 建議價格（選填） */
  price?: string;
  /** 建議數量（選填） */
  quantity?: string;
  /**
   * 指標快照（選填）
   * Convention: ma-cross → { shortMA, longMA }; rsi → { rsiValue }; grid → {}
   */
  indicators?: Record<string, number>;
}

/** 策略執行結果（結構化輸出） */
export interface StrategyResult {
  /** 執行動作 */
  action: 'BUY' | 'SELL' | 'HOLD';
  /** 事件類型 */
  eventType?: 'fill' | 'order_submitted' | 'signal' | 'position_closed';
  /** 交易對 */
  symbol: string;
  /** 策略名稱（顯示用中文名） */
  strategy: string;
  /** 策略 ID（系統操作用） */
  strategyId?: string;
  /** 實際成交價（BUY/SELL 時） */
  price?: string;
  /** 實際成交量 */
  quantity?: string;
  /** 訂單 ID */
  orderId?: number;
  /** 執行原因 */
  reason: string;
  /** 時間戳（毫秒） */
  timestamp: number;
  /** 損益（SELL 時計算） */
  pnl?: number;
  /** 是否被風控攔截 */
  riskBlocked?: boolean;
  /** 設定版本號 */
  configVersion?: number;
}

export interface Strategy {
  /** 策略 ID（機器識別用） */
  id: 'ma-cross' | 'rsi' | 'grid';
  /** 策略名稱（顯示用） */
  name: string;
  /** 策略說明 */
  description: string;
  /** 分析行情並產生訊號 */
  analyze(symbol: string, ctx?: ExecutionContext): Promise<AnalysisResult>;
  /** 根據分析結果執行交易，回傳結構化結果 */
  execute(symbol: string, result: AnalysisResult, ctx?: ExecutionContext): Promise<StrategyResult | StrategyResult[]>;
}

/** 回測用的 K 線分析（不需要即時 API） */
export interface BacktestableStrategy {
  /** 策略 ID */
  id: string;
  /** 策略名稱 */
  name: string;
  /** 用歷史 K 線資料分析，overrides 可覆蓋設定參數 */
  analyzeKlines(closePrices: string[], index: number, overrides?: Record<string, number>): AnalysisResult;
}
