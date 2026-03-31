/**
 * ExecutionContext — 單次策略執行的共享上下文
 *
 * 每次 auto-trade 呼叫策略時建立一個 context，
 * 傳遞給 analyze / execute，讓它們能讀取 configVersion、closeOnly 等狀態。
 *
 * Fix #4: updateConfigWithCAS 改用 mutateEnvelope，確保 bump configVersion + snapshot。
 */

import { getConfigEnvelope } from './utils/config-envelope.js';
import { mutateEnvelope } from './utils/config-ops.js';
import { assertLockOwnership } from './utils/global-lock.js';
import { getDefaultConfigs } from './strategy-config.js';
import type { StrategyConfigMap } from './strategy-config.js';

// ===== 型別定義 =====

export interface ExecutionContext {
  /** config-envelope 的版本號 */
  configVersion: number;
  /** 策略參數快照（唯讀） */
  strategyConfig: Readonly<Record<string, number>>;
  /** 策略 ID */
  strategyId: string;
  /** 交易對 */
  symbol: string;
  /** 建立時間戳（毫秒） */
  createdAt: number;
  /** global-lock fencing token（若此 context 持有 lock 則設定） */
  fencingToken?: string;
  /**
   * Mode A 回滾後：true = 只允許平倉，禁止新開倉
   * 由 config-envelope.closeOnlySymbols 判斷
   */
  closeOnly?: boolean;
  // Fix R5-3: 標記 envelope 是否損壞，讓下游拒絕交易
  /** 若 envelope 損壞且無法恢復，設為 true */
  corruptedEnvelope?: boolean;
}

// ===== 策略參數驗證（共用） =====

/** Fix R6-1: strategy-specific 值域限制（抽出共用，供 updateConfigWithCAS 和 CLI config set 使用） */
const RANGE_LIMITS: Record<string, Record<string, { min: number; max: number }>> = {
  'ma-cross': {
    shortPeriod: { min: 2, max: 200 },
    longPeriod: { min: 2, max: 200 },
    tradeRatio: { min: 0.01, max: 1.0 },
  },
  'rsi': {
    period: { min: 2, max: 100 },
    oversold: { min: 5, max: 45 },
    overbought: { min: 55, max: 95 },
    tradeRatio: { min: 0.01, max: 1.0 },
  },
  'grid': {
    gridPercent: { min: 0.001, max: 0.2 },
    gridCount: { min: 2, max: 50 },
    tradeRatio: { min: 0.01, max: 1.0 },
  },
};

/**
 * Fix R6-1: 驗證策略參數 key 與值域
 * 供 updateConfigWithCAS 和 CLI config set 共用
 *
 * @param strategyId - 策略 ID
 * @param partial - 要驗證的參數 key-value pairs
 * @throws Error 若 key 不屬於該策略或值超出範圍
 */
export function validateStrategyParams(
  strategyId: string,
  partial: Record<string, number>,
): void {
  const defaults = getDefaultConfigs();
  const strategyDefaults = defaults[strategyId as keyof typeof defaults] as unknown as Record<string, unknown> | undefined;
  if (!strategyDefaults) {
    throw new Error(`未知策略 "${strategyId}"`);
  }
  const validKeys = new Set<string>(Object.keys(strategyDefaults));
  const rangeLimits = RANGE_LIMITS[strategyId] ?? {};

  for (const [key, value] of Object.entries(partial)) {
    if (!validKeys.has(key)) {
      throw new Error(`策略 "${strategyId}" 沒有參數 "${key}"（可用：${[...validKeys].join(', ')}）`);
    }
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
      throw new Error(`參數 "${key}" 值必須是正數，得到：${value}`);
    }
    const range = rangeLimits[key];
    if (range && (value < range.min || value > range.max)) {
      throw new Error(`參數 "${strategyId}.${key}" 值必須在 [${range.min}, ${range.max}] 範圍內，得到：${value}`);
    }
  }
}

// ===== 公開函式 =====

/**
 * 建立 ExecutionContext
 *
 * 從 config-envelope 讀取 configVersion 和策略參數，
 * 同時檢查 closeOnlySymbols 設定 ctx.closeOnly。
 *
 * @param strategyId - 策略 ID ('ma-cross' | 'rsi' | 'grid')
 * @param symbol - 交易對（如 'ETCUSDT'）
 * @param fencingToken - 若有持有 global-lock 則傳入，否則留 undefined
 */
export function createExecutionContext(
  strategyId: string,
  symbol: string,
  fencingToken?: string,
): ExecutionContext {
  // Fix R4-1: 使用 getConfigEnvelope() 而非手動 readFileSync，確保走 corruption recovery + ensureConsistency
  let configVersion = 1;
  let strategyConfig: Record<string, number> = {};
  let closeOnly = false;
  let corruptedEnvelope = false; // Fix R5-3

  try {
    const envelope = getConfigEnvelope();

    configVersion = envelope.configVersion;

    // 取對應策略的 config（轉成 Record<string, number>）
    const cfgMap = envelope.strategyConfigs ?? {};
    const stratCfg = cfgMap[strategyId as keyof StrategyConfigMap] as unknown as Record<string, number> | undefined;
    if (stratCfg) {
      strategyConfig = { ...stratCfg };
    }

    // 檢查 closeOnly
    const closeOnlySymbols = envelope.closeOnlySymbols ?? [];
    closeOnly = closeOnlySymbols.includes(symbol.toUpperCase());
  } catch {
    // Fix R5-3: envelope 損壞時 fail closed — 設 closeOnly=true 禁止新開倉，
    // 並標記 corruptedEnvelope=true 讓 trade-executor 拒絕所有交易
    console.warn('⚠️ createExecutionContext: 無法讀取 config-envelope，啟用 fail-closed 模式（closeOnly + corruptedEnvelope）');
    closeOnly = true;
    corruptedEnvelope = true; // Fix R5-3
  }

  return {
    configVersion,
    strategyConfig: Object.freeze(strategyConfig),
    strategyId,
    symbol: symbol.toUpperCase(),
    createdAt: Date.now(),
    fencingToken,
    closeOnly,
    corruptedEnvelope, // Fix R5-3
  };
}

/**
 * 使用 CAS（Compare-And-Swap）更新 config-envelope 的策略參數
 *
 * Fix #4: 改用 mutateEnvelope，確保 bump configVersion + snapshot。
 *
 * @param strategyId - 策略 ID
 * @param expectedVersion - 預期的目前版本號
 * @param partial - 要更新的參數（部分更新）
 * @param fencingToken - 必須持有 global-lock 的 fencing token
 * @returns { success, currentVersion }
 */
export function updateConfigWithCAS(
  strategyId: string,
  expectedVersion: number,
  partial: Record<string, number>,
  fencingToken: string,
): { success: boolean; currentVersion: number } {
  // 確認持有 lock
  assertLockOwnership(fencingToken);

  const envelope = getConfigEnvelope();
  const currentVersion = envelope.configVersion;

  if (currentVersion !== expectedVersion) {
    return { success: false, currentVersion };
  }

  // Fix R5-4 + R6-1: 使用共用的 validateStrategyParams 驗證
  validateStrategyParams(strategyId, partial);

  // 使用 mutateEnvelope 確保 bump configVersion + snapshot
  const updated = mutateEnvelope(
    fencingToken,
    (env) => {
      const existingCfg = (env.strategyConfigs?.[strategyId as keyof StrategyConfigMap] ?? {}) as unknown as Record<string, number>;
      const merged = { ...existingCfg, ...partial };
      (env.strategyConfigs as unknown as Record<string, unknown>)[strategyId] = merged;
    },
    `updateConfigWithCAS: strategyId=${strategyId} version=${expectedVersion}→${expectedVersion + 1}`,
  );

  return { success: true, currentVersion: updated.configVersion };
}
