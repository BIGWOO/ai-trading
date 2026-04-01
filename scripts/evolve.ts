/**
 * Self-Evolution Script — 自動進化
 *
 * 用法：npx tsx scripts/evolve.ts [--json]
 *
 * 完整流程（v7 plan 10 步）：
 * 1. 讀取 config-envelope → 檢查 evolution.enabled
 * 2. acquireLock('evolve')
 * 3. Probation 檢查（畢業/回滾/等待）
 * 4. 偵測市場狀態
 * 5. 覆盤最近交易
 * 6. Walk-Forward 優化
 * 7. 通過閘門 → CAS 更新 + set probation
 * 8. 策略切換（需 isTradingFlat）
 * 9. Mode B 回滾（連續衰退 + flat → lastStableVersion）
 * 10. 日報輸出
 *
 * Phase C-2: Self-Evolution Plan v7
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import { getConfigEnvelope } from '../src/utils/config-envelope.js';
import type { ConfigEnvelope, EvolutionConfig } from '../src/utils/config-envelope.js';
import { mutateEnvelope } from '../src/utils/config-ops.js';
import { acquireLock, releaseLock } from '../src/utils/global-lock.js';
import {
  getProbationRuntime, clearProbationRuntime,
  calculateDrawdown,
} from '../src/utils/probation-runtime.js';
import { initProbationRuntime } from '../src/utils/probation-runtime.js';
import {
  appendEvolutionLog, getConsecutiveDeclines,
} from '../src/utils/evolution-log.js';
import { getLastStableVersion, rollbackToVersion, markGraduated } from '../src/utils/config-history.js';
import { isTradingFlat } from '../src/utils/flat-check.js';
import { getKlines } from '../src/binance.js';
import { detectRegime, formatRegime } from '../src/market-regime.js';
import { reviewRecentTrades } from '../src/trade-review.js';
import { optimize } from './optimize.js';
import type { OptimizeResult } from './optimize.js';

// ===== 常數 =====

/** Grid 策略完全排除 */
const EXCLUDED_STRATEGIES = new Set(['grid']);

/** 預設進化設定 */
const DEFAULT_EVOLUTION: EvolutionConfig = {
  enabled: false,
  intervalHours: 24,
  probationHours: 48,
  rollbackThresholdPercent: -5,
};

/** ±30% 參數調整限制 */
const ADJUSTMENT_LIMIT = 0.3;

/** 連續衰退回滾所需的連續次數 */
const CONSECUTIVE_DECLINE_COUNT = 3;

// ===== 型別 =====

interface EvolveReport {
  timestamp: number;
  steps: string[];
  regime?: string;
  reviewSummary?: string;
  optimizeResults: Record<string, OptimizeResult>;
  actions: string[];
  errors: string[];
}

// ===== 輔助函式 =====

/**
 * 檢查參數調整是否在 ±adjustmentLimit 範圍內
 */
function isWithinAdjustmentLimit(
  currentParams: Record<string, number>,
  newParams: Record<string, number>,
  limit: number,
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  for (const [key, newVal] of Object.entries(newParams)) {
    const currentVal = currentParams[key];
    if (currentVal === undefined || currentVal === 0) continue;

    const changePct = Math.abs(newVal - currentVal) / Math.abs(currentVal);
    if (changePct > limit) {
      violations.push(`${key}: ${currentVal} → ${newVal}（變化 ${(changePct * 100).toFixed(1)}% > ${(limit * 100).toFixed(0)}%）`);
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 從 envelope 取得進化設定（加入預設值向後相容）
 */
function getEvolutionConfig(envelope: ConfigEnvelope): EvolutionConfig {
  return { ...DEFAULT_EVOLUTION, ...envelope.evolutionConfig };
}

// ===== 主流程 =====

export async function runEvolution(options?: { json?: boolean }): Promise<EvolveReport> {
  const report: EvolveReport = {
    timestamp: Date.now(),
    steps: [],
    optimizeResults: {},
    actions: [],
    errors: [],
  };

  const log = (msg: string) => {
    report.steps.push(msg);
    if (!options?.json) console.log(msg);
  };

  log('🧬 Self-Evolution v7 開始');
  log('═══════════════════════════════════════');

  // Step 1: 讀取 config-envelope
  let envelope: ConfigEnvelope;
  try {
    envelope = getConfigEnvelope();
  } catch (err) {
    const msg = `❌ 無法讀取 config-envelope: ${err instanceof Error ? err.message : String(err)}`;
    log(msg);
    report.errors.push(msg);
    return report;
  }

  const evoConfig = getEvolutionConfig(envelope);
  log(`  📋 Config Version: ${envelope.configVersion}`);
  log(`  🔧 Evolution: ${evoConfig.enabled ? '啟用' : '停用'}`);

  if (!evoConfig.enabled) {
    log('  ⏭️ 進化功能未啟用，結束');
    return report;
  }

  // Step 2: acquireLock
  const lock = acquireLock('evolve', 300); // 5 分鐘 timeout
  if (!lock) {
    const msg = '❌ 無法取得 evolve lock（另一個進化程序正在執行）';
    log(msg);
    report.errors.push(msg);
    return report;
  }

  try {
    // Step 3: Probation 檢查
    log('\n📊 Step 3: Probation 檢查');

    if (envelope.probation) {
      const prob = envelope.probation;
      const now = Date.now();
      const runtime = getProbationRuntime();

      log(`  🔒 Probation 進行中 (v${prob.configVersion}, 到期: ${new Date(prob.expiresAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })})`);

      if (now >= prob.expiresAt) {
        // 畢業
        log('  🎓 Probation 到期 → 畢業！');
        markGraduated(prob.configVersion);

        mutateEnvelope(lock.token, (env) => {
          env.probation = null;
        }, `probation graduated: v${prob.configVersion}`);

        clearProbationRuntime();

        appendEvolutionLog({
          type: 'graduation',
          timestamp: now,
          configVersion: prob.configVersion,
          strategyId: prob.affectedStrategies.join(','),
          reason: 'Probation 到期，參數畢業',
          metrics: {},
        });

        report.actions.push('畢業: probation 到期');
        // 重新讀取 envelope
        envelope = getConfigEnvelope();
      } else {
        // 檢查 drawdown 回滾
        if (runtime) {
          const drawdown = calculateDrawdown(runtime.peakSinceActivation);
          if (drawdown !== null && drawdown < evoConfig.rollbackThresholdPercent) {
            log(`  ⚠️ Drawdown ${drawdown.toFixed(2)}% < ${evoConfig.rollbackThresholdPercent}% → 回滾！`);

            // Mode A 回滾
            const previousVersion = prob.configVersion - 1;
            try {
              const rollbackEnvelope = rollbackToVersion(previousVersion);
              mutateEnvelope(lock.token, (env) => {
                env.strategyConfigs = rollbackEnvelope.strategyConfigs;
                env.probation = null;
                // 加入 close-only
                for (const s of prob.affectedStrategies) {
                  for (const key of Object.keys(env.activeStrategies)) {
                    if (key.startsWith(`${s}:`)) {
                      const sym = key.split(':')[1];
                      if (!env.closeOnlySymbols.includes(sym)) {
                        env.closeOnlySymbols.push(sym);
                      }
                    }
                  }
                }
              }, `probation rollback: drawdown ${drawdown.toFixed(2)}%`);

              clearProbationRuntime();

              appendEvolutionLog({
                type: 'rollback',
                timestamp: now,
                configVersion: prob.configVersion,
                strategyId: prob.affectedStrategies.join(','),
                reason: `Drawdown ${drawdown.toFixed(2)}% 超過閾值 ${evoConfig.rollbackThresholdPercent}%`,
                metrics: { dailyPnL: drawdown },
                rollbackMode: 'probation_drawdown',
              });

              report.actions.push(`回滾: drawdown ${drawdown.toFixed(2)}%`);
            } catch (rollbackErr) {
              const msg = `⚠️ 回滾失敗: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`;
              log(`  ${msg}`);
              report.errors.push(msg);
            }

            // 回滾後不繼續優化
            envelope = getConfigEnvelope();
          } else {
            log(`  ⏳ Probation 進行中，drawdown: ${drawdown?.toFixed(2) ?? 'N/A'}%，等待...`);
          }
        } else {
          log('  ⏳ Probation 進行中，等待...');
        }

        // Probation 存在時跳過優化和切換
        log('  ⏭️ Probation 存在，跳過優化和策略切換');
        return report;
      }
    } else {
      log('  ✅ 無 Probation');
    }

    // Step 4: 偵測市場狀態
    log('\n🌍 Step 4: 偵測市場狀態');
    try {
      const klines = await getKlines('BTCUSDT', '1h', 100);
      const closedKlines = klines.slice(0, -1);
      const regimeResult = detectRegime(
        closedKlines.map((k) => k.close),
        closedKlines.map((k) => k.high),
        closedKlines.map((k) => k.low),
      );
      report.regime = regimeResult.regime;
      log(`  ${regimeResult.description}`);
    } catch (err) {
      const msg = `⚠️ 市場狀態偵測失敗: ${err instanceof Error ? err.message : String(err)}`;
      log(`  ${msg}`);
      report.errors.push(msg);
    }

    // Step 5: 覆盤最近交易
    log('\n📝 Step 5: 覆盤最近交易');
    const review = reviewRecentTrades(7);
    report.reviewSummary = `交易 ${review.summary.totalTrades} 筆, PnL ${review.summary.totalPnl.toFixed(2)}, 勝率 ${review.summary.winRate.toFixed(1)}%`;
    log(`  ${report.reviewSummary}`);
    for (const s of review.suggestions) {
      log(`  ${s}`);
    }

    // Step 6: Walk-Forward 優化（排除 Grid）
    log('\n🔬 Step 6: Walk-Forward 優化');

    // 取得 active 策略
    const activeStrategyIds = new Set<string>();
    for (const key of Object.keys(envelope.activeStrategies)) {
      const sid = key.split(':')[0];
      if (!EXCLUDED_STRATEGIES.has(sid)) {
        activeStrategyIds.add(sid);
      }
    }

    // 若無 active 策略，用 ma-cross 和 rsi 作為候選
    if (activeStrategyIds.size === 0) {
      activeStrategyIds.add('ma-cross');
      activeStrategyIds.add('rsi');
    }

    for (const strategyId of activeStrategyIds) {
      log(`\n  📈 優化 ${strategyId}...`);

      try {
        // 取得 K 線
        const defaultSymbol = 'BTCUSDT';
        const klines = await getKlines(defaultSymbol, '1h', 500);
        const closedKlines = klines.slice(0, -1);
        const closePrices = closedKlines.map((k) => k.close);

        const result = optimize(strategyId, closePrices, {
          interval: '1h',
          symbol: defaultSymbol,
        });

        report.optimizeResults[strategyId] = result;

        if (result.passed && result.bestParams) {
          log(`  ✅ ${strategyId} 通過閘門`);
          log(`     最佳參數: ${JSON.stringify(result.bestParams)}`);
          log(`     Sharpe: ${result.bestAvgSharpe.toFixed(4)}`);

          // Step 7: 通過閘門 → CAS 更新 + set probation
          // 檢查 ±30% 調整限制
          const currentConfig = envelope.strategyConfigs[strategyId as keyof typeof envelope.strategyConfigs];
          if (currentConfig) {
            const currentParams: Record<string, number> = {};
            for (const [k, v] of Object.entries(currentConfig)) {
              if (typeof v === 'number') currentParams[k] = v;
            }

            const adjustCheck = isWithinAdjustmentLimit(currentParams, result.bestParams, ADJUSTMENT_LIMIT);

            if (!adjustCheck.ok) {
              log(`  ⚠️ 參數調整超過 ±${(ADJUSTMENT_LIMIT * 100).toFixed(0)}% 限制：`);
              for (const v of adjustCheck.violations) {
                log(`     ${v}`);
              }
              log('  ⏭️ 跳過此次更新');
              report.actions.push(`跳過 ${strategyId}: 參數變化超限`);
              continue;
            }
          }

          // CAS 更新 envelope
          const oldVersion = envelope.configVersion;
          envelope = mutateEnvelope(lock.token, (env) => {
            const cfg = env.strategyConfigs[strategyId as keyof typeof env.strategyConfigs];
            if (cfg) {
              for (const [k, v] of Object.entries(result.bestParams!)) {
                (cfg as unknown as Record<string, number>)[k] = v;
              }
            }

            // Set probation
            env.probation = {
              configVersion: env.configVersion, // will be bumped by mutateEnvelope
              activatedAt: Date.now(),
              baselineEquity: 0, // will be set when probation runtime initializes
              affectedStrategies: [strategyId],
              drawdownThresholdPercent: getEvolutionConfig(env).rollbackThresholdPercent,
              expiresAt: Date.now() + getEvolutionConfig(env).probationHours * 60 * 60 * 1000,
            };
          }, `evolve: optimize ${strategyId}`);

          // Fix: probation.configVersion 需要更新為新版本
          // mutateEnvelope 已經 bump 了 configVersion
          if (envelope.probation) {
            envelope.probation.configVersion = envelope.configVersion;
          }

          // Init probation runtime
          initProbationRuntime(0); // 初始 equity 由下次交易時更新

          appendEvolutionLog({
            type: 'optimization',
            timestamp: Date.now(),
            configVersion: envelope.configVersion,
            strategyId,
            reason: `Walk-Forward 優化通過 (Sharpe: ${result.bestAvgSharpe.toFixed(4)})`,
            metrics: {
              sharpe: result.bestAvgSharpe,
              backtestReturn: result.holdoutResult?.totalReturn,
            },
          });

          report.actions.push(`更新 ${strategyId}: v${oldVersion} → v${envelope.configVersion}`);
          log(`  🔄 Config 更新: v${oldVersion} → v${envelope.configVersion}`);
          log(`  🔒 Probation 啟動: ${evoConfig.probationHours}h`);

          // Probation 啟動後，跳過其他策略的優化
          break;
        } else {
          log(`  ❌ ${strategyId} 未通過閘門`);
          for (const reason of result.gateFailReasons) {
            log(`     ${reason}`);
          }
        }
      } catch (err) {
        const msg = `⚠️ ${strategyId} 優化失敗: ${err instanceof Error ? err.message : String(err)}`;
        log(`  ${msg}`);
        report.errors.push(msg);
      }
    }

    // Step 8: 策略切換（需 isTradingFlat）
    // 注意：只有在未設定 probation 時才考慮切換
    // 且本次未做任何優化更新時才考慮
    if (!envelope.probation && report.actions.length === 0) {
      log('\n🔄 Step 8: 策略切換評估');
      // 目前不自動切換策略，只記錄可能性
      log('  ⏭️ 策略切換需手動評估（自動切換待後續版本實作）');
    }

    // Step 9: Mode B 回滾
    if (!envelope.probation) {
      log('\n🔙 Step 9: Mode B 回滾檢查');

      for (const strategyId of activeStrategyIds) {
        if (EXCLUDED_STRATEGIES.has(strategyId)) continue;

        const declines = getConsecutiveDeclines(strategyId, CONSECUTIVE_DECLINE_COUNT);
        if (declines.length > 0) {
          log(`  ⚠️ ${strategyId} 連續 ${CONSECUTIVE_DECLINE_COUNT} 次優化績效衰退`);

          // 檢查 flat
          const flatResult = await isTradingFlat();
          if (flatResult.isFlat) {
            const stableVersion = getLastStableVersion();
            if (stableVersion !== null) {
              log(`  🔙 回滾到穩定版本 v${stableVersion}`);

              try {
                const rollbackEnvelope = rollbackToVersion(stableVersion);
                envelope = mutateEnvelope(lock.token, (env) => {
                  env.strategyConfigs = rollbackEnvelope.strategyConfigs;
                }, `Mode B rollback: ${strategyId} consecutive decline → v${stableVersion}`);

                appendEvolutionLog({
                  type: 'rollback',
                  timestamp: Date.now(),
                  configVersion: envelope.configVersion,
                  strategyId,
                  reason: `連續 ${CONSECUTIVE_DECLINE_COUNT} 次績效衰退，回滾到 v${stableVersion}`,
                  metrics: {},
                  rollbackMode: 'consecutive_decline',
                });

                report.actions.push(`Mode B 回滾 ${strategyId}: → v${stableVersion}`);
              } catch (err) {
                const msg = `⚠️ Mode B 回滾失敗: ${err instanceof Error ? err.message : String(err)}`;
                log(`  ${msg}`);
                report.errors.push(msg);
              }
            } else {
              log('  ⚠️ 無穩定版本可回滾');
            }
          } else {
            log('  ⚠️ 尚未完全平倉，暫緩回滾');
            for (const b of flatResult.blockers) {
              log(`     ${b}`);
            }
          }
        } else {
          log(`  ✅ ${strategyId} 無連續衰退`);
        }
      }
    }

    // Step 10: 日報摘要
    log('\n📋 Step 10: 進化摘要');
    log('───────────────────────────────────────');
    if (report.regime) log(`  市場: ${formatRegime(report.regime as import('../src/market-regime.js').MarketRegime)}`);
    if (report.reviewSummary) log(`  覆盤: ${report.reviewSummary}`);
    if (report.actions.length > 0) {
      log('  動作:');
      for (const a of report.actions) log(`    • ${a}`);
    } else {
      log('  動作: 無（維持現狀）');
    }
    if (report.errors.length > 0) {
      log('  警告:');
      for (const e of report.errors) log(`    ⚠️ ${e}`);
    }
    log('');

  } finally {
    releaseLock(lock.token);
  }

  return report;
}

// ===== CLI =====

async function main() {
  const jsonMode = process.argv.includes('--json');

  const report = await runEvolution({ json: jsonMode });

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error(`\n❌ 進化失敗：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
