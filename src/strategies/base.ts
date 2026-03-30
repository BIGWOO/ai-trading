/**
 * 策略基類定義
 * 所有交易策略都必須實作此介面
 */

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
}

/** 策略執行結果（結構化輸出） */
export interface StrategyResult {
  /** 執行動作 */
  action: 'BUY' | 'SELL' | 'HOLD';
  /** 交易對 */
  symbol: string;
  /** 策略名稱 */
  strategy: string;
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
}

export interface Strategy {
  /** 策略名稱 */
  name: string;
  /** 策略說明 */
  description: string;
  /** 分析行情並產生訊號 */
  analyze(symbol: string): Promise<AnalysisResult>;
  /** 根據分析結果執行交易，回傳結構化結果 */
  execute(symbol: string, result: AnalysisResult): Promise<StrategyResult | StrategyResult[]>;
}

/** 回測用的 K 線分析（不需要即時 API） */
export interface BacktestableStrategy {
  /** 策略名稱 */
  name: string;
  /** 用歷史 K 線資料分析 */
  analyzeKlines(closePrices: string[], index: number): AnalysisResult;
}
