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

export interface Strategy {
  /** 策略名稱 */
  name: string;
  /** 策略說明 */
  description: string;
  /** 分析行情並產生訊號 */
  analyze(symbol: string): Promise<AnalysisResult>;
  /** 根據分析結果執行交易 */
  execute(symbol: string, result: AnalysisResult): Promise<void>;
}

/** 回測用的 K 線分析（不需要即時 API） */
export interface BacktestableStrategy {
  /** 策略名稱 */
  name: string;
  /** 用歷史 K 線資料分析 */
  analyzeKlines(closePrices: string[], index: number): AnalysisResult;
}
