/**
 * 自動交易單次執行入口
 * 被 OpenClaw cron 呼叫：npx tsx scripts/auto-trade.ts [--json]
 *
 * 流程：
 * 1. 用 global-lock 防止重疊執行
 * 2. 讀取 config-envelope.activeStrategies 中 enabled=true 的項目
 * 3. 檢查各項目距離上次執行是否已過 interval
 * 4. 對到期的項目：先 checkRisk() → 通過才 execute()（含 close-only 攔截）
 * 5. 更新 auto-trade-runtime.json 和 risk-state
 * 6. 更新 probation-runtime.json 的 peakSinceActivation（不需鎖）
 * 7. 輸出 JSON 結果（方便 Skill 推送通知）
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import { existsSync, mkdirSync } from 'node:fs';
import { cleanupTmpFiles } from '../src/utils/atomic-write.js';
import { acquireLock, releaseLock, renewLock } from '../src/utils/global-lock.js';
import { getEnvInfo, getAccountInfo } from '../src/binance.js';
import { maCrossStrategy } from '../src/strategies/ma-cross.js';
import { rsiStrategy } from '../src/strategies/rsi.js';
import { gridStrategy } from '../src/strategies/grid.js';
import type { Strategy, StrategyResult } from '../src/strategies/base.js';
import { getAutoTrades, isDue, updateAutoTradeResult } from '../src/scheduler.js';
import { syncInitialCapital, getRiskStatus } from '../src/risk-control.js';
import { executeWithRisk } from '../src/trade-executor.js';
import { createExecutionContext } from '../src/execution-context.js';
import { getProbationRuntime, updateProbationPeak, cleanupStalePeakLock } from '../src/utils/probation-runtime.js';
import { getConfigEnvelope } from '../src/utils/config-envelope.js';
import { mutateEnvelope } from '../src/utils/config-ops.js';
import { migratePositions } from '../src/position.js';
import { migrateTrades } from '../src/storage.js';
import { isTradingFlat } from '../src/utils/flat-check.js';

const STRATEGIES: Record<string, Strategy> = {
  'ma-cross': maCrossStrategy,
  'rsi': rsiStrategy,
  'grid': gridStrategy,
};

const DATA_DIR = join(__dirname, '..', 'data');

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ===== 主要邏輯 =====

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
  const results: AutoTradeRunResult[] = [];

  ensureDataDir();

  // Fix R5-5: 程式啟動時清理可能因 crash 遺留的 stale peak lock
  cleanupStalePeakLock();

  // 取得 global lock（防止重疊執行）
  const lock = acquireLock('auto-trade', 300);
  if (!lock) {
    console.log('⚠️ 另一個 auto-trade 正在執行中（global-lock 已持有），跳過本次執行');
    if (jsonMode) {
      console.log(JSON.stringify({ results: [], message: '另一個實例正在執行中' }));
    }
    process.exit(0);
  }

  // 確保任何情況下都釋放 lock
  const cleanup = () => { releaseLock(lock.token); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  try {
    // 啟動時清理可能的 .tmp 殘留檔案
    const tmpCleaned = cleanupTmpFiles(DATA_DIR);
    if (tmpCleaned > 0) {
      console.log(`🧹 已清理 ${tmpCleaned} 個殘留 .tmp 檔案`);
    }

    // Fix #14: 補填 positions.json 和 trades.json 的 strategyId（只跑一次）
    try {
      migratePositions();
      migrateTrades();
    } catch (err) {
      console.log(`⚠️ 資料遷移失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    const env = getEnvInfo();

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(`  🤖 自動交易  ${env.isTestnet ? '【測試網】' : '【主網 ⚠️】'}`);
    console.log('═══════════════════════════════════════');
    console.log('');

    // 首次啟動時同步 initialCapital
    try {
      const STATE_FILE = join(__dirname, '..', 'data', 'risk-state.json');
      const isNewState = !existsSync(STATE_FILE);
      if (isNewState) {
        const accountInfo = await getAccountInfo();
        const usdtBalance = accountInfo.balances.find((b) => b.asset === 'USDT');
        const balance = parseFloat(usdtBalance?.free ?? '0') + parseFloat(usdtBalance?.locked ?? '0');
        if (balance > 0) {
          syncInitialCapital(balance);
          console.log(`💰 已同步初始資金：${balance.toFixed(2)} USDT`);
        }
      }
    } catch (err) {
      console.log(`⚠️ 同步初始資金失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    // 讀取 closeOnlySymbols（從 config-envelope）
    const envelope = getConfigEnvelope();
    const closeOnlySymbols = new Set(envelope.closeOnlySymbols ?? []);

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
    if (closeOnlySymbols.size > 0) {
      console.log(`🔒 Close-only 模式：${[...closeOnlySymbols].join(', ')}`);
    }
    console.log('');

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

      // 建立 ExecutionContext（含 closeOnly 判斷）
      const symbolUpper = entry.symbol.toUpperCase();
      const ctx = createExecutionContext(
        strategy.id,
        symbolUpper,
        lock.token, // 傳入 fencing token
      );
      // 補充 closeOnly（若在 closeOnlySymbols 中）
      if (closeOnlySymbols.has(symbolUpper)) {
        (ctx as { closeOnly: boolean }).closeOnly = true;
      }

      // 透過風控包裝器執行（風控 + close-only 攔截 + 分析 + 交易 + 風控記錄）
      try {
        console.log(`  📊 分析 + 風控檢查中...`);
        const strategyResult = await executeWithRisk({ strategy, symbol: symbolUpper, ctx });

        // 檢查是否被風控攔截（用 flag 判斷，不靠字串比對）
        const resultArray = Array.isArray(strategyResult) ? strategyResult : [strategyResult];
        const isRiskBlocked = resultArray.some((r) => r.riskBlocked === true);

        // 更新 auto-trade-runtime（不需鎖）
        updateAutoTradeResult(key, strategyResult);

        if (isRiskBlocked) {
          console.log(`  ${resultArray[0].reason}`);
          results.push({
            key,
            strategy: entry.strategy,
            symbol: entry.symbol,
            status: 'risk-blocked',
            reason: resultArray[0].reason,
          });
        } else {
          console.log(`  ✅ 完成`);
          results.push({
            key,
            strategy: entry.strategy,
            symbol: entry.symbol,
            status: 'executed',
            result: strategyResult,
          });

          // Fix R4-4 (原 Fix #4 R1-7): 若有 SELL 且 symbol 在 closeOnlySymbols，平倉後移除
          // 改用 isTradingFlat() 同時檢查 exchange balance 和 open orders，而非只看 local positions
          for (const r of resultArray) {
            if (r.action === 'SELL' && closeOnlySymbols.has(symbolUpper)) {
              try {
                const flatResult = await isTradingFlat(symbolUpper);
                if (flatResult.isFlat) {
                  mutateEnvelope(
                    lock.token,
                    (env) => {
                      env.closeOnlySymbols = env.closeOnlySymbols.filter((s) => s !== symbolUpper);
                    },
                    `close-only cleanup: ${symbolUpper} 已平倉（isTradingFlat 確認）`,
                  );
                  closeOnlySymbols.delete(symbolUpper);
                  console.log(`  🔓 ${symbolUpper} 已從 closeOnlySymbols 移除（isTradingFlat 確認平倉完成）`);
                } else {
                  console.log(`  ℹ️ ${symbolUpper} SELL 完成但尚未完全平倉：${flatResult.blockers.join('; ')}`);
                }
              } catch (cleanupErr) {
                console.log(`  ⚠️ 移除 close-only 標記失敗：${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ❌ 錯誤：${msg}`);
        updateAutoTradeResult(key, {
          action: 'HOLD',
          symbol: symbolUpper,
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

      // Fix R3: 每處理完一個策略後 renew lock，避免長時間 loop 中 lease 過期
      const renewed = renewLock(lock.token, 300);
      if (!renewed) {
        console.log('⚠️ Lock 已遺失或過期（renewLock 失敗），中斷執行');
        break;
      }

      console.log('');
    }

    // 每次執行後更新 probation-runtime.peak（若 probation 存在）
    try {
      const probationRuntime = getProbationRuntime();
      if (probationRuntime !== null) {
        const riskStatus = getRiskStatus();
        const currentEquity = riskStatus.state.currentEquity;
        if (currentEquity > probationRuntime.peakSinceActivation) {
          updateProbationPeak(currentEquity);
          console.log(`📈 更新 probation 高水位：${currentEquity.toFixed(2)} USDT`);
        }
      }
    } catch (err) {
      console.log(`⚠️ 更新 probation peak 失敗：${err instanceof Error ? err.message : String(err)}`);
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
  } catch (err) {
    // 最外層 crash 保護
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ 未預期的錯誤：${msg}\n`);
    if (jsonMode) {
      console.log(JSON.stringify({ results, error: msg }));
    }
  }
}

main();
