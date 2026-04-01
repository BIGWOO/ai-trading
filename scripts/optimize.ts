/**
 * Walk-Forward 參數優化
 *
 * 用法：npx tsx scripts/optimize.ts <策略> [幣對] [K線間隔] [K線數量]
 * 範例：npx tsx scripts/optimize.ts ma-cross BTCUSDT 1h 500
 *
 * - Anchored expanding walk-forward：train 永遠從第 0 根開始
 * - 15% holdout（最後 15% K 線不參與訓練/測試，只做最終驗證）
 * - 預設 3 folds
 * - Grid search 最大化 Sharpe Ratio
 *
 * Phase A-2: Self-Evolution Plan v7
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import { getKlines } from '../src/binance.js';
import { maCrossStrategy } from '../src/strategies/ma-cross.js';
import { rsiStrategy } from '../src/strategies/rsi.js';
import type { BacktestableStrategy } from '../src/strategies/base.js';
import { runBacktest } from '../src/backtest-engine.js';
import type { BacktestResult } from '../src/backtest-engine.js';

// ===== 策略 & 參數範圍 =====

const STRATEGIES: Record<string, BacktestableStrategy> = {
  'ma-cross': maCrossStrategy,
  'rsi': rsiStrategy,
};

/** Grid 策略完全排除 */
const EXCLUDED_STRATEGIES = new Set(['grid']);

interface ParamRange {
  name: string;
  values: number[];
}

const PARAM_RANGES: Record<string, ParamRange[]> = {
  'ma-cross': [
    { name: 'shortPeriod', values: [5, 7, 10, 14, 20] },
    { name: 'longPeriod', values: [20, 25, 30, 40, 50] },
  ],
  'rsi': [
    { name: 'period', values: [7, 10, 14, 21] },
    { name: 'oversold', values: [20, 25, 30] },
    { name: 'overbought', values: [70, 75, 80] },
  ],
};

// ===== Fold 生成 =====

export interface FoldSpec {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

export interface FoldResult {
  folds: FoldSpec[];
  holdout: { start: number; end: number };
}

/**
 * Anchored expanding walk-forward fold 生成
 *
 * @param N - 總 K 線數
 * @param holdoutRatio - holdout 比例（預設 0.15）
 * @param foldCount - fold 數量（預設 3）
 * @returns FoldResult
 */
export function generateFolds(N: number, holdoutRatio: number = 0.15, foldCount: number = 3): FoldResult {
  const holdoutSize = Math.floor(N * holdoutRatio);
  const usable = N - holdoutSize;
  const minTrainRatio = 0.5;
  const minTrainSize = Math.floor(usable * minTrainRatio);
  const totalTestSize = usable - minTrainSize;
  const testSize = Math.floor(totalTestSize / foldCount);

  // Invariant checks
  if (testSize < 1) {
    throw new Error(`K 線數不足：N=${N}, usable=${usable}, minTrainSize=${minTrainSize}, 無法產生有效的 test fold`);
  }
  if (minTrainSize < 10) {
    throw new Error(`訓練集過小：minTrainSize=${minTrainSize}（至少需要 10 根 K 線）`);
  }
  if (holdoutSize < 1) {
    throw new Error(`Holdout 集過小：holdoutSize=${holdoutSize}（至少需要 1 根 K 線）`);
  }

  const folds: FoldSpec[] = [];
  for (let i = 0; i < foldCount; i++) {
    const testStart = minTrainSize + i * testSize;
    const testEnd = (i === foldCount - 1) ? usable : testStart + testSize;

    // Invariant: train 永遠從 0 開始（anchored）
    folds.push({
      trainStart: 0,
      trainEnd: testStart,
      testStart,
      testEnd,
    });
  }

  // Invariant checks
  for (let i = 0; i < folds.length; i++) {
    const f = folds[i];
    if (f.trainEnd <= f.trainStart) {
      throw new Error(`Fold ${i}: trainEnd(${f.trainEnd}) <= trainStart(${f.trainStart})`);
    }
    if (f.testEnd <= f.testStart) {
      throw new Error(`Fold ${i}: testEnd(${f.testEnd}) <= testStart(${f.testStart})`);
    }
    if (f.testStart !== f.trainEnd) {
      throw new Error(`Fold ${i}: testStart(${f.testStart}) !== trainEnd(${f.trainEnd})`);
    }
  }

  return {
    folds,
    holdout: { start: usable, end: N },
  };
}

// ===== Grid Search =====

interface ParamCombo {
  params: Record<string, number>;
  foldResults: BacktestResult[];
  foldValid: boolean[];
  avgSharpe: number;
  allValid: boolean;
  allDrawdownOK: boolean;
}

/**
 * 產生所有參數組合（笛卡兒積）
 */
function generateParamCombos(ranges: ParamRange[]): Record<string, number>[] {
  if (ranges.length === 0) return [{}];

  const [first, ...rest] = ranges;
  const restCombos = generateParamCombos(rest);
  const combos: Record<string, number>[] = [];

  for (const val of first.values) {
    for (const restCombo of restCombos) {
      combos.push({ [first.name]: val, ...restCombo });
    }
  }

  return combos;
}

/**
 * 過濾無效的參數組合（例如 ma-cross 的 shortPeriod >= longPeriod）
 */
function filterValidCombos(strategyId: string, combos: Record<string, number>[]): Record<string, number>[] {
  if (strategyId === 'ma-cross') {
    return combos.filter((c) => c.shortPeriod < c.longPeriod);
  }
  if (strategyId === 'rsi') {
    return combos.filter((c) => c.oversold < c.overbought);
  }
  return combos;
}

// ===== 主流程 =====

export interface OptimizeResult {
  strategyId: string;
  symbol: string;
  interval: string;
  totalKlines: number;
  bestParams: Record<string, number> | null;
  bestAvgSharpe: number;
  holdoutResult: BacktestResult | null;
  foldResults: BacktestResult[] | null;
  passed: boolean;
  gateFailReasons: string[];
  allCombosCount: number;
  validCombosCount: number;
}

/**
 * 執行 Walk-Forward 優化
 *
 * @param strategyId - 策略 ID
 * @param closePrices - 收盤價陣列
 * @param options - 選項
 * @returns OptimizeResult
 */
export function optimize(
  strategyId: string,
  closePrices: string[],
  options?: {
    interval?: string;
    symbol?: string;
    foldCount?: number;
    holdoutRatio?: number;
    minTradesPerFold?: number;
    maxDrawdownPercent?: number;
  },
): OptimizeResult {
  const interval = options?.interval ?? '1h';
  const symbol = options?.symbol ?? 'BTCUSDT';
  const foldCount = options?.foldCount ?? 3;
  const holdoutRatio = options?.holdoutRatio ?? 0.15;
  const minTradesPerFold = options?.minTradesPerFold ?? 3;
  const maxDrawdownPercent = options?.maxDrawdownPercent ?? 15;

  if (EXCLUDED_STRATEGIES.has(strategyId)) {
    return {
      strategyId,
      symbol,
      interval,
      totalKlines: closePrices.length,
      bestParams: null,
      bestAvgSharpe: 0,
      holdoutResult: null,
      foldResults: null,
      passed: false,
      gateFailReasons: ['Grid 策略不參與優化'],
      allCombosCount: 0,
      validCombosCount: 0,
    };
  }

  const strategy = STRATEGIES[strategyId];
  if (!strategy) {
    return {
      strategyId,
      symbol,
      interval,
      totalKlines: closePrices.length,
      bestParams: null,
      bestAvgSharpe: 0,
      holdoutResult: null,
      foldResults: null,
      passed: false,
      gateFailReasons: [`未知策略: ${strategyId}`],
      allCombosCount: 0,
      validCombosCount: 0,
    };
  }

  const ranges = PARAM_RANGES[strategyId];
  if (!ranges) {
    return {
      strategyId,
      symbol,
      interval,
      totalKlines: closePrices.length,
      bestParams: null,
      bestAvgSharpe: 0,
      holdoutResult: null,
      foldResults: null,
      passed: false,
      gateFailReasons: [`無參數範圍定義: ${strategyId}`],
      allCombosCount: 0,
      validCombosCount: 0,
    };
  }

  // 產生 folds
  const { folds, holdout } = generateFolds(closePrices.length, holdoutRatio, foldCount);

  // 產生參數組合
  const allCombos = generateParamCombos(ranges);
  const validCombos = filterValidCombos(strategyId, allCombos);

  // Grid search
  let bestCombo: ParamCombo | null = null;

  for (const params of validCombos) {
    const foldResults: BacktestResult[] = [];
    const foldValid: boolean[] = [];
    let allValid = true;
    let allDrawdownOK = true;

    for (const fold of folds) {
      // Train: 用 train 部分跑 backtest（驗證參數可行性）
      // Test: 用 test 部分跑 backtest（評估 out-of-sample 表現）
      const testResult = runBacktest(
        closePrices,
        strategy,
        params,
        { interval, startIndex: fold.testStart, endIndex: fold.testEnd },
      );

      foldResults.push(testResult);
      const valid = testResult.tradeCount >= minTradesPerFold;
      foldValid.push(valid);

      if (!valid) allValid = false;
      if (testResult.maxDrawdown > maxDrawdownPercent) allDrawdownOK = false;
    }

    const avgSharpe = foldResults.reduce((sum, r) => sum + r.sharpeRatio, 0) / foldResults.length;

    const combo: ParamCombo = {
      params,
      foldResults,
      foldValid,
      avgSharpe,
      allValid,
      allDrawdownOK,
    };

    // 選擇最佳：allValid + allDrawdownOK + 最高 avgSharpe
    if (allValid && allDrawdownOK) {
      if (!bestCombo || avgSharpe > bestCombo.avgSharpe) {
        bestCombo = combo;
      }
    }
  }

  // 閘門檢查
  const gateFailReasons: string[] = [];

  if (!bestCombo) {
    gateFailReasons.push('無參數組合通過所有折的交易次數和回撤要求');
    return {
      strategyId,
      symbol,
      interval,
      totalKlines: closePrices.length,
      bestParams: null,
      bestAvgSharpe: 0,
      holdoutResult: null,
      foldResults: null,
      passed: false,
      gateFailReasons,
      allCombosCount: allCombos.length,
      validCombosCount: validCombos.length,
    };
  }

  // 閘門 2: 平均 Sharpe > 0
  if (bestCombo.avgSharpe <= 0) {
    gateFailReasons.push(`平均 Sharpe (${bestCombo.avgSharpe.toFixed(4)}) <= 0`);
  }

  // Holdout test
  const holdoutResult = runBacktest(
    closePrices,
    strategy,
    bestCombo.params,
    { interval, startIndex: holdout.start, endIndex: holdout.end },
  );

  // 閘門 3: Holdout Sharpe > 0
  if (holdoutResult.sharpeRatio <= 0) {
    gateFailReasons.push(`Holdout Sharpe (${holdoutResult.sharpeRatio.toFixed(4)}) <= 0`);
  }

  // 閘門 4: 每折 maxDrawdown < maxDrawdownPercent
  for (let i = 0; i < bestCombo.foldResults.length; i++) {
    if (bestCombo.foldResults[i].maxDrawdown > maxDrawdownPercent) {
      gateFailReasons.push(`Fold ${i + 1} maxDrawdown (${bestCombo.foldResults[i].maxDrawdown.toFixed(2)}%) > ${maxDrawdownPercent}%`);
    }
  }

  const passed = gateFailReasons.length === 0;

  return {
    strategyId,
    symbol,
    interval,
    totalKlines: closePrices.length,
    bestParams: bestCombo.params,
    bestAvgSharpe: bestCombo.avgSharpe,
    holdoutResult,
    foldResults: bestCombo.foldResults,
    passed,
    gateFailReasons,
    allCombosCount: allCombos.length,
    validCombosCount: validCombos.length,
  };
}

// ===== CLI 主程式 =====

async function main() {
  const strategyId = process.argv[2];
  const symbol = (process.argv[3] ?? 'BTCUSDT').toUpperCase();
  const interval = process.argv[4] ?? '1h';
  const limit = parseInt(process.argv[5] ?? '500', 10);

  if (!strategyId) {
    console.log('用法：npx tsx scripts/optimize.ts <策略> [幣對] [K線間隔] [K線數量]');
    console.log('範例：npx tsx scripts/optimize.ts ma-cross BTCUSDT 1h 500');
    console.log(`可用策略：${Object.keys(STRATEGIES).join(', ')}`);
    process.exit(1);
  }

  if (EXCLUDED_STRATEGIES.has(strategyId)) {
    console.log(`❌ ${strategyId} 策略不參與優化`);
    process.exit(1);
  }

  if (!STRATEGIES[strategyId]) {
    console.log(`❌ 未知策略：${strategyId}`);
    console.log(`可用策略：${Object.keys(STRATEGIES).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n🔬 Walk-Forward 參數優化`);
  console.log('═══════════════════════════════════════');
  console.log(`  策略：${strategyId}`);
  console.log(`  幣對：${symbol}`);
  console.log(`  間隔：${interval}`);
  console.log(`  K線數：${limit}`);
  console.log('');

  // 取得 K 線資料
  console.log('📡 取得 K 線資料...');
  const klines = await getKlines(symbol, interval, limit);
  // 排除最後一根未收盤 K 線
  const closedKlines = klines.slice(0, -1);
  const closePrices = closedKlines.map((k) => k.close);
  console.log(`  ✅ 取得 ${closePrices.length} 根已收盤 K 線\n`);

  // Fold 資訊
  const { folds, holdout } = generateFolds(closePrices.length);
  console.log('📐 Fold 配置：');
  for (let i = 0; i < folds.length; i++) {
    const f = folds[i];
    console.log(`  Fold ${i + 1}: Train [${f.trainStart}-${f.trainEnd}) → Test [${f.testStart}-${f.testEnd})`);
  }
  console.log(`  Holdout: [${holdout.start}-${holdout.end})`);
  console.log('');

  // 執行優化
  console.log('🔍 Grid Search 中...');
  const result = optimize(strategyId, closePrices, { interval, symbol });

  // 輸出結果
  console.log(`\n  測試組合數：${result.validCombosCount}/${result.allCombosCount}`);
  console.log('');

  if (result.bestParams) {
    console.log('🏆 最佳參數組合：');
    for (const [key, val] of Object.entries(result.bestParams)) {
      console.log(`  ${key}: ${val}`);
    }
    console.log(`  平均 Sharpe: ${result.bestAvgSharpe.toFixed(4)}`);
    console.log('');

    if (result.foldResults) {
      console.log('📊 各折結果：');
      for (let i = 0; i < result.foldResults.length; i++) {
        const fr = result.foldResults[i];
        console.log(`  Fold ${i + 1}: Return=${fr.totalReturn.toFixed(2)}% | Sharpe=${fr.sharpeRatio.toFixed(4)} | Trades=${fr.tradeCount} | DD=${fr.maxDrawdown.toFixed(2)}% | WR=${fr.winRate.toFixed(1)}%`);
      }
      console.log('');
    }

    if (result.holdoutResult) {
      const hr = result.holdoutResult;
      console.log('🔒 Holdout 結果：');
      console.log(`  Return=${hr.totalReturn.toFixed(2)}% | Sharpe=${hr.sharpeRatio.toFixed(4)} | Trades=${hr.tradeCount} | DD=${hr.maxDrawdown.toFixed(2)}% | WR=${hr.winRate.toFixed(1)}%`);
      console.log('');
    }
  }

  if (result.passed) {
    console.log('✅ 通過所有閘門！');
  } else {
    console.log('❌ 未通過閘門：');
    for (const reason of result.gateFailReasons) {
      console.log(`  - ${reason}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(`\n❌ 優化失敗：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
