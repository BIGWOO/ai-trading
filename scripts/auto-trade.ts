/**
 * 自動交易單次執行入口
 * 被 OpenClaw cron 呼叫：npx tsx scripts/auto-trade.ts [--json]
 *
 * 流程：
 * 1. 讀取 auto-trading.json 中 enabled=true 的項目
 * 2. 檢查各項目距離上次執行是否已過 interval
 * 3. 對到期的項目：先 checkRisk() → 通過才 execute()
 * 4. 更新 auto-trading.json 和 risk-state
 * 5. 輸出 JSON 結果（方便 Skill 推送通知）
 */

import { config } from 'dotenv';
config();

import { getEnvInfo } from '../src/binance.js';
import { maCrossStrategy } from '../src/strategies/ma-cross.js';
import { rsiStrategy } from '../src/strategies/rsi.js';
import { gridStrategy } from '../src/strategies/grid.js';
import type { Strategy, StrategyResult } from '../src/strategies/base.js';
import { getAutoTrades, isDue, updateAutoTradeResult } from '../src/scheduler.js';
import { checkRisk, recordTradeForRisk } from '../src/risk-control.js';

const STRATEGIES: Record<string, Strategy> = {
  'ma-cross': maCrossStrategy,
  'rsi': rsiStrategy,
  'grid': gridStrategy,
};

interface AutoTradeRunResult {
  key: string;
  strategy: string;
  symbol: string;
  status: 'executed' | 'skipped' | 'risk-blocked' | 'error';
  result?: StrategyResult | StrategyResult[];
  reason?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const env = getEnvInfo();

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`  🤖 自動交易  ${env.isTestnet ? '【測試網】' : '【主網 ⚠️】'}`);
  console.log('═══════════════════════════════════════');
  console.log('');

  const autoTrades = getAutoTrades();
  const entries = Object.entries(autoTrades);
  const enabledEntries = entries.filter(([, e]) => e.enabled);

  if (enabledEntries.length === 0) {
    console.log('📭 沒有啟用中的自動交易');
    if (jsonMode) {
      console.log(JSON.stringify({ results: [], message: '沒有啟用中的自動交易' }));
    }
    return;
  }

  console.log(`📋 啟用中：${enabledEntries.length} 項`);
  console.log('');

  const results: AutoTradeRunResult[] = [];

  for (const [key, entry] of enabledEntries) {
    console.log(`─── ${key} ───`);

    // 檢查是否到達執行時間
    if (!isDue(entry)) {
      const lastRunStr = entry.lastRun ? new Date(entry.lastRun).toLocaleString('zh-TW') : '未執行';
      console.log(`  ⏭️ 尚未到期（上次：${lastRunStr}，間隔：${entry.interval}）`);
      results.push({
        key,
        strategy: entry.strategy,
        symbol: entry.symbol,
        status: 'skipped',
        reason: `尚未到期（間隔 ${entry.interval}）`,
      });
      continue;
    }

    // 風控檢查
    const riskCheck = checkRisk();
    if (!riskCheck.allowed) {
      console.log(`  ${riskCheck.reason}`);
      results.push({
        key,
        strategy: entry.strategy,
        symbol: entry.symbol,
        status: 'risk-blocked',
        reason: riskCheck.reason,
      });
      continue;
    }

    // 取得策略
    const strategy = STRATEGIES[entry.strategy];
    if (!strategy) {
      console.log(`  ❌ 未知策略：${entry.strategy}`);
      results.push({
        key,
        strategy: entry.strategy,
        symbol: entry.symbol,
        status: 'error',
        reason: `未知策略：${entry.strategy}`,
      });
      continue;
    }

    // 執行策略
    try {
      console.log(`  📊 分析中...`);
      const analysis = await strategy.analyze(entry.symbol);
      console.log(`  ${analysis.reason}`);
      console.log(`  📍 訊號：${analysis.signal} | 強度：${(analysis.strength * 100).toFixed(1)}%`);

      let strategyResult: StrategyResult | StrategyResult[];

      if (analysis.signal !== 'HOLD') {
        console.log(`  ⚡ 執行交易...`);
        strategyResult = await strategy.execute(entry.symbol, analysis);
      } else {
        strategyResult = {
          action: 'HOLD',
          symbol: entry.symbol,
          strategy: strategy.name,
          reason: analysis.reason,
          timestamp: Date.now(),
        };
      }

      // 更新自動交易狀態
      updateAutoTradeResult(key, strategyResult);

      // 如果有實際交易（BUY/SELL），記錄到風控
      const resultArray = Array.isArray(strategyResult) ? strategyResult : [strategyResult];
      for (const r of resultArray) {
        if (r.action !== 'HOLD') {
          // 目前無法即時算出 PnL，記錄 pnl=0，實際 PnL 由 storage 模組處理
          recordTradeForRisk({ pnl: 0, timestamp: r.timestamp });
        }
      }

      console.log(`  ✅ 完成`);
      results.push({
        key,
        strategy: entry.strategy,
        symbol: entry.symbol,
        status: 'executed',
        result: strategyResult,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ 錯誤：${msg}`);
      updateAutoTradeResult(key, {
        action: 'HOLD',
        symbol: entry.symbol,
        strategy: entry.strategy,
        reason: `錯誤: ${msg}`,
        timestamp: Date.now(),
      }, true);
      results.push({
        key,
        strategy: entry.strategy,
        symbol: entry.symbol,
        status: 'error',
        reason: msg,
      });
    }

    console.log('');
  }

  // 摘要
  const executed = results.filter((r) => r.status === 'executed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const blocked = results.filter((r) => r.status === 'risk-blocked').length;
  const errors = results.filter((r) => r.status === 'error').length;

  console.log('═══════════════════════════════════════');
  console.log(`  📊 結果：執行 ${executed} / 跳過 ${skipped} / 風控 ${blocked} / 錯誤 ${errors}`);
  console.log('═══════════════════════════════════════');
  console.log('');

  if (jsonMode) {
    console.log(JSON.stringify({ results }));
  }
}

main();
