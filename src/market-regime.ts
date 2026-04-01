/**
 * Market Regime — 市場狀態偵測
 *
 * 用 ADX（Average Directional Index）判斷趨勢強度，
 * 用 ATR/price 比判斷波動度。
 *
 * Phase C-1: Self-Evolution Plan v7
 */

// ===== 型別定義 =====

export type MarketRegime = 'trending_up' | 'trending_down' | 'ranging' | 'volatile';

export interface RegimeResult {
  /** 市場狀態 */
  regime: MarketRegime;
  /** ADX 值 */
  adx: number;
  /** +DI 值 */
  plusDI: number;
  /** -DI 值 */
  minusDI: number;
  /** ATR/price 比率（百分比） */
  atrRatio: number;
  /** 狀態說明 */
  description: string;
}

// ===== 常數 =====

const DEFAULT_PERIOD = 14;

// ===== ADX 計算 =====

/**
 * 計算 True Range
 */
function calculateTR(
  high: number[],
  low: number[],
  close: number[],
): number[] {
  const tr: number[] = [];
  for (let i = 1; i < high.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  return tr;
}

/**
 * 計算 Smoothed Moving Average（Wilder's method）
 */
function wilderSmooth(values: number[], period: number): number[] {
  if (values.length < period) return [];

  const result: number[] = [];
  // 第一個值用 SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  result.push(sum / period);

  // 後續用 Wilder 平滑
  for (let i = period; i < values.length; i++) {
    const prev = result[result.length - 1];
    result.push((prev * (period - 1) + values[i]) / period);
  }

  return result;
}

/**
 * 計算 +DM 和 -DM
 */
function calculateDM(
  high: number[],
  low: number[],
): { plusDM: number[]; minusDM: number[] } {
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < high.length; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  return { plusDM, minusDM };
}

/**
 * 計算 ADX、+DI、-DI
 */
function calculateADX(
  high: number[],
  low: number[],
  close: number[],
  period: number = DEFAULT_PERIOD,
): { adx: number; plusDI: number; minusDI: number; atr: number } | null {
  if (high.length < period * 2 + 1) return null;

  const tr = calculateTR(high, low, close);
  const { plusDM, minusDM } = calculateDM(high, low);

  const smoothedTR = wilderSmooth(tr, period);
  const smoothedPlusDM = wilderSmooth(plusDM, period);
  const smoothedMinusDM = wilderSmooth(minusDM, period);

  if (smoothedTR.length === 0 || smoothedPlusDM.length === 0 || smoothedMinusDM.length === 0) {
    return null;
  }

  // 計算 +DI 和 -DI
  const minLen = Math.min(smoothedTR.length, smoothedPlusDM.length, smoothedMinusDM.length);
  const dx: number[] = [];

  let lastPlusDI = 0;
  let lastMinusDI = 0;

  for (let i = 0; i < minLen; i++) {
    const atr = smoothedTR[i];
    if (atr === 0) continue;

    const pdi = (smoothedPlusDM[i] / atr) * 100;
    const mdi = (smoothedMinusDM[i] / atr) * 100;
    const diSum = pdi + mdi;

    lastPlusDI = pdi;
    lastMinusDI = mdi;

    if (diSum > 0) {
      dx.push((Math.abs(pdi - mdi) / diSum) * 100);
    }
  }

  if (dx.length < period) return null;

  // ADX = Wilder smooth of DX
  const adxValues = wilderSmooth(dx, period);
  if (adxValues.length === 0) return null;

  const adx = adxValues[adxValues.length - 1];
  const atr = smoothedTR[smoothedTR.length - 1];

  return { adx, plusDI: lastPlusDI, minusDI: lastMinusDI, atr };
}

// ===== 公開 API =====

/**
 * 偵測市場狀態
 *
 * @param closePrices - 收盤價陣列
 * @param highPrices - 最高價陣列
 * @param lowPrices - 最低價陣列
 * @param period - ADX 計算週期（預設 14）
 * @returns RegimeResult
 */
export function detectRegime(
  closePrices: string[],
  highPrices: string[],
  lowPrices: string[],
  period: number = DEFAULT_PERIOD,
): RegimeResult {
  const close = closePrices.map(Number);
  const high = highPrices.map(Number);
  const low = lowPrices.map(Number);

  const result = calculateADX(high, low, close, period);

  if (!result) {
    return {
      regime: 'ranging',
      adx: 0,
      plusDI: 0,
      minusDI: 0,
      atrRatio: 0,
      description: '📊 數據不足，無法判斷市場狀態',
    };
  }

  const { adx, plusDI, minusDI, atr } = result;
  const currentPrice = close[close.length - 1];
  const atrRatio = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

  // 判斷邏輯
  let regime: MarketRegime;
  let description: string;

  // 先檢查高波動
  if (atrRatio > 3) {
    regime = 'volatile';
    description = `🌊 高波動市場（ATR/Price = ${atrRatio.toFixed(2)}%，ADX = ${adx.toFixed(1)}）`;
  } else if (adx > 25) {
    if (plusDI > minusDI) {
      regime = 'trending_up';
      description = `📈 上升趨勢（ADX = ${adx.toFixed(1)}，+DI = ${plusDI.toFixed(1)} > -DI = ${minusDI.toFixed(1)}）`;
    } else {
      regime = 'trending_down';
      description = `📉 下降趨勢（ADX = ${adx.toFixed(1)}，-DI = ${minusDI.toFixed(1)} > +DI = ${plusDI.toFixed(1)}）`;
    }
  } else if (adx < 20) {
    regime = 'ranging';
    description = `↔️ 橫盤整理（ADX = ${adx.toFixed(1)} < 20，無明顯趨勢）`;
  } else {
    // ADX 20-25: 弱趨勢，偏向 ranging
    regime = 'ranging';
    description = `↔️ 弱趨勢（ADX = ${adx.toFixed(1)}，趨勢不明確）`;
  }

  return {
    regime,
    adx,
    plusDI,
    minusDI,
    atrRatio,
    description,
  };
}

/**
 * 格式化 regime 結果為 emoji 表示
 */
export function formatRegime(regime: MarketRegime): string {
  switch (regime) {
    case 'trending_up': return '📈 上升趨勢';
    case 'trending_down': return '📉 下降趨勢';
    case 'ranging': return '↔️ 橫盤整理';
    case 'volatile': return '🌊 高波動';
  }
}
