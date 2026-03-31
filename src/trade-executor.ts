/**
 * 統一交易執行包裝器
 * 所有執行路徑（手動、自動、CLI）都經過風控檢查
 */

import { checkRisk, recordTradeForRisk } from './risk-control.js';
import type { Strategy, StrategyResult } from './strategies/base.js';
import { createExecutionContext, type ExecutionContext } from './execution-context.js';

export interface ExecuteOptions {
  strategy: Strategy;
  symbol: string;
  skipRiskCheck?: boolean; // 只有 backtest 可以 skip
  ctx?: ExecutionContext;
}

export async function executeWithRisk(options: ExecuteOptions): Promise<StrategyResult | StrategyResult[]> {
  const { strategy, symbol, skipRiskCheck } = options;
  const ctx = options.ctx ?? createExecutionContext(strategy.id, symbol);

  // Fix R5-3: envelope 損壞時拒絕所有交易（fail closed）
  if (ctx.corruptedEnvelope) {
    console.log('⛔ Envelope 損壞，拒絕交易（fail-closed 模式）');
    return {
      action: 'HOLD',
      symbol,
      strategy: strategy.name,
      strategyId: strategy.id,
      reason: '⛔ Envelope 損壞，拒絕交易（需手動修復 config-envelope.json）',
      timestamp: Date.now(),
      configVersion: ctx.configVersion,
    };
  }

  // 1. 風控前置檢查
  if (!skipRiskCheck) {
    const risk = checkRisk();
    if (!risk.allowed) {
      console.log(`⛔ 風控攔截：${risk.reason}`);
      return {
        action: 'HOLD',
        symbol,
        strategy: strategy.name,
        strategyId: strategy.id,
        reason: risk.reason ?? '風控攔截',
        timestamp: Date.now(),
        riskBlocked: true,
        configVersion: ctx.configVersion,
      };
    }
  }

  // 2. 分析
  const analysis = await strategy.analyze(symbol, ctx);

  // 3. Close-only 模式攔截（回滾後禁止開倉）
  if (ctx.closeOnly && analysis.signal === 'BUY') {
    return {
      action: 'HOLD',
      symbol,
      strategy: strategy.name,
      strategyId: strategy.id,
      reason: '⛔ Close-only 模式：回滾後禁止開倉',
      timestamp: Date.now(),
      configVersion: ctx.configVersion,
    };
  }

  // 4. 執行（或 HOLD）
  let result: StrategyResult | StrategyResult[];
  if (analysis.signal !== 'HOLD') {
    result = await strategy.execute(symbol, analysis, ctx);
  } else {
    result = {
      action: 'HOLD',
      symbol,
      strategy: strategy.name,
      strategyId: strategy.id,
      reason: analysis.reason,
      timestamp: Date.now(),
      configVersion: ctx.configVersion,
    };
  }

  // 5. 補充 strategyId / configVersion（若策略本身未設定）
  const resultArray = Array.isArray(result) ? result : [result];
  for (const r of resultArray) {
    if (!r.strategyId) r.strategyId = strategy.id;
    if (r.configVersion === undefined) r.configVersion = ctx.configVersion;
  }

  // 6. 風控後置記錄
  // Fix #5 (R1-8): 只在實際成交（非 order_submitted）時才記錄風控
  if (!skipRiskCheck) {
    for (const r of resultArray) {
      if (r.action !== 'HOLD' && r.eventType !== 'order_submitted') {
        recordTradeForRisk({ pnl: r.pnl ?? 0, timestamp: r.timestamp });
      }
    }
  }

  return result;
}
