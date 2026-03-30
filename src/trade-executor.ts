/**
 * 統一交易執行包裝器
 * 所有執行路徑（手動、自動、CLI）都經過風控檢查
 */

import { checkRisk, recordTradeForRisk } from './risk-control.js';
import type { Strategy, StrategyResult } from './strategies/base.js';

export interface ExecuteOptions {
  strategy: Strategy;
  symbol: string;
  skipRiskCheck?: boolean; // 只有 backtest 可以 skip
}

export async function executeWithRisk(options: ExecuteOptions): Promise<StrategyResult | StrategyResult[]> {
  const { strategy, symbol, skipRiskCheck } = options;

  // 1. 風控前置檢查
  if (!skipRiskCheck) {
    const risk = checkRisk();
    if (!risk.allowed) {
      console.log(`⛔ 風控攔截：${risk.reason}`);
      return {
        action: 'HOLD',
        symbol,
        strategy: strategy.name,
        reason: risk.reason ?? '風控攔截',
        timestamp: Date.now(),
      };
    }
  }

  // 2. 分析
  const analysis = await strategy.analyze(symbol);

  // 3. 執行（或 HOLD）
  let result: StrategyResult | StrategyResult[];
  if (analysis.signal !== 'HOLD') {
    result = await strategy.execute(symbol, analysis);
  } else {
    result = {
      action: 'HOLD',
      symbol,
      strategy: strategy.name,
      reason: analysis.reason,
      timestamp: Date.now(),
    };
  }

  // 4. 風控後置記錄
  if (!skipRiskCheck) {
    const resultArray = Array.isArray(result) ? result : [result];
    for (const r of resultArray) {
      if (r.action !== 'HOLD') {
        recordTradeForRisk({ pnl: r.pnl ?? 0, timestamp: r.timestamp });
      }
    }
  }

  return result;
}
