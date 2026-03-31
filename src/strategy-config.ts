/**
 * 策略參數設定管理
 * 從 data/strategy-config.json 讀取/寫入策略參數
 * 不存在時自動建立並使用預設值
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './utils/atomic-write.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'data', 'strategy-config.json');

// ===== 型別定義 =====

export interface MaCrossConfig {
  shortPeriod: number;
  longPeriod: number;
  tradeRatio: number;
}

export interface RsiConfig {
  period: number;
  oversold: number;
  overbought: number;
  tradeRatio: number;
}

export interface GridConfig {
  gridPercent: number;
  gridCount: number;
  tradeRatio: number;
}

export interface StrategyConfigMap {
  'ma-cross': MaCrossConfig;
  'rsi': RsiConfig;
  'grid': GridConfig;
}

export type StrategyName = keyof StrategyConfigMap;

// ===== 預設值 =====

const DEFAULTS: StrategyConfigMap = {
  'ma-cross': {
    shortPeriod: 7,
    longPeriod: 25,
    tradeRatio: 0.1,
  },
  'rsi': {
    period: 14,
    oversold: 30,
    overbought: 70,
    tradeRatio: 0.1,
  },
  'grid': {
    gridPercent: 0.05,
    gridCount: 10,
    tradeRatio: 0.05,
  },
};

// ===== 驗證邏輯 =====

function validateMaCross(cfg: Partial<MaCrossConfig>): void {
  if (cfg.shortPeriod !== undefined) {
    if (!Number.isInteger(cfg.shortPeriod) || cfg.shortPeriod < 1) {
      throw new Error(`ma-cross.shortPeriod 必須是正整數，得到：${cfg.shortPeriod}`);
    }
  }
  if (cfg.longPeriod !== undefined) {
    if (!Number.isInteger(cfg.longPeriod) || cfg.longPeriod < 1) {
      throw new Error(`ma-cross.longPeriod 必須是正整數，得到：${cfg.longPeriod}`);
    }
  }
  if (cfg.shortPeriod !== undefined && cfg.longPeriod !== undefined) {
    if (cfg.shortPeriod >= cfg.longPeriod) {
      throw new Error(`ma-cross.shortPeriod(${cfg.shortPeriod}) 必須小於 longPeriod(${cfg.longPeriod})`);
    }
  }
  if (cfg.tradeRatio !== undefined) {
    if (cfg.tradeRatio <= 0 || cfg.tradeRatio > 1) {
      throw new Error(`ma-cross.tradeRatio 必須在 (0, 1] 範圍內，得到：${cfg.tradeRatio}`);
    }
  }
}

function validateRsi(cfg: Partial<RsiConfig>): void {
  if (cfg.period !== undefined) {
    if (!Number.isInteger(cfg.period) || cfg.period < 2) {
      throw new Error(`rsi.period 必須是 >= 2 的正整數，得到：${cfg.period}`);
    }
  }
  if (cfg.oversold !== undefined) {
    if (cfg.oversold < 0 || cfg.oversold > 100) {
      throw new Error(`rsi.oversold 必須在 [0, 100] 範圍內，得到：${cfg.oversold}`);
    }
  }
  if (cfg.overbought !== undefined) {
    if (cfg.overbought < 0 || cfg.overbought > 100) {
      throw new Error(`rsi.overbought 必須在 [0, 100] 範圍內，得到：${cfg.overbought}`);
    }
  }
  if (cfg.oversold !== undefined && cfg.overbought !== undefined) {
    if (cfg.oversold >= cfg.overbought) {
      throw new Error(`rsi.oversold(${cfg.oversold}) 必須小於 overbought(${cfg.overbought})`);
    }
  }
  if (cfg.tradeRatio !== undefined) {
    if (cfg.tradeRatio <= 0 || cfg.tradeRatio > 1) {
      throw new Error(`rsi.tradeRatio 必須在 (0, 1] 範圍內，得到：${cfg.tradeRatio}`);
    }
  }
}

function validateGrid(cfg: Partial<GridConfig>): void {
  if (cfg.gridPercent !== undefined) {
    if (cfg.gridPercent <= 0 || cfg.gridPercent > 1) {
      throw new Error(`grid.gridPercent 必須在 (0, 1] 範圍內，得到：${cfg.gridPercent}`);
    }
  }
  if (cfg.gridCount !== undefined) {
    if (!Number.isInteger(cfg.gridCount) || cfg.gridCount < 2) {
      throw new Error(`grid.gridCount 必須是 >= 2 的正整數，得到：${cfg.gridCount}`);
    }
  }
  if (cfg.tradeRatio !== undefined) {
    if (cfg.tradeRatio <= 0 || cfg.tradeRatio > 1) {
      throw new Error(`grid.tradeRatio 必須在 (0, 1] 範圍內，得到：${cfg.tradeRatio}`);
    }
  }
}

function validatePartial<K extends StrategyName>(
  strategy: K,
  partial: Partial<StrategyConfigMap[K]>,
): void {
  switch (strategy) {
    case 'ma-cross':
      validateMaCross(partial as Partial<MaCrossConfig>);
      break;
    case 'rsi':
      validateRsi(partial as Partial<RsiConfig>);
      break;
    case 'grid':
      validateGrid(partial as Partial<GridConfig>);
      break;
    default:
      throw new Error(`未知策略：${strategy}`);
  }
}

// ===== 讀寫工具 =====

function loadConfig(): StrategyConfigMap {
  if (!existsSync(CONFIG_PATH)) {
    return structuredClone(DEFAULTS);
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StrategyConfigMap>;
    // 對每個策略做 merge（讓 JSON 中缺少的欄位用預設值補齊）
    return {
      'ma-cross': { ...DEFAULTS['ma-cross'], ...parsed['ma-cross'] },
      'rsi': { ...DEFAULTS['rsi'], ...parsed['rsi'] },
      'grid': { ...DEFAULTS['grid'], ...parsed['grid'] },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveConfig(config: StrategyConfigMap): void {
  atomicWriteJson(CONFIG_PATH, config);
}

// ===== 公開 API =====

/**
 * 取得指定策略的設定（含預設值合併）
 */
export function getStrategyConfig<K extends StrategyName>(strategy: K): StrategyConfigMap[K] {
  const config = loadConfig();
  return config[strategy];
}

/**
 * 更新指定策略的部分參數
 * 會驗證數值範圍，不合法則拋出錯誤
 */
export function updateStrategyConfig<K extends StrategyName>(
  strategy: K,
  partial: Partial<StrategyConfigMap[K]>,
): StrategyConfigMap[K] {
  // 驗證新值
  validatePartial(strategy, partial);

  const config = loadConfig();
  const merged = { ...config[strategy], ...partial } as StrategyConfigMap[K];

  // 合併後再驗證一次（跨欄位約束，例如 shortPeriod < longPeriod）
  validatePartial(strategy, merged);

  config[strategy] = merged;
  saveConfig(config);
  return merged;
}

/**
 * 重置指定策略（或全部策略）為預設值
 */
export function resetStrategyConfig(strategy?: StrategyName): StrategyConfigMap {
  const config = loadConfig();
  if (strategy) {
    (config[strategy] as StrategyConfigMap[StrategyName]) = structuredClone(DEFAULTS[strategy]);
  } else {
    config['ma-cross'] = structuredClone(DEFAULTS['ma-cross']);
    config['rsi'] = structuredClone(DEFAULTS['rsi']);
    config['grid'] = structuredClone(DEFAULTS['grid']);
  }
  saveConfig(config);
  return config;
}

/**
 * 取得全部策略設定
 */
export function getAllStrategyConfigs(): StrategyConfigMap {
  return loadConfig();
}

/**
 * 取得預設值（不依賴檔案）
 */
export function getDefaultConfigs(): StrategyConfigMap {
  return structuredClone(DEFAULTS);
}

export { DEFAULTS };
