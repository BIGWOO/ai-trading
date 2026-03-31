/**
 * 自動交易狀態管理
 *
 * 架構分離：
 * - Declarative 狀態（activeStrategies, interval）→ config-envelope.json（需 global-lock）
 * - Runtime 狀態（lastRun, lastResult, totalRuns, errors）→ auto-trade-runtime.json（不需鎖）
 *
 * Fix #4: enableAutoTrade / disableAutoTrade 改用 mutateEnvelope，確保 bump configVersion + snapshot。
 * 向後相容：若舊 auto-trading.json 存在，由 config-envelope 遷移機制處理。
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { atomicWriteJson } from './utils/atomic-write.js';
import { getConfigEnvelope } from './utils/config-envelope.js';
import { mutateEnvelope } from './utils/config-ops.js';
import { acquireLock, releaseLock, type LockInfo } from './utils/global-lock.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategyResult } from './strategies/base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const RUNTIME_FILE = join(DATA_DIR, 'auto-trade-runtime.json');

// ===== 型別定義 =====

/** AutoTradeEntry — 合併 declarative + runtime 的對外介面（保持向後相容） */
export interface AutoTradeEntry {
  /** 是否啟用 */
  enabled: boolean;
  /** 策略名稱（如 ma-cross） */
  strategy: string;
  /** 交易對 */
  symbol: string;
  /** 執行間隔（如 1h, 4h, 1d） */
  interval: string;
  /** 上次執行時間（毫秒） */
  lastRun: number | null;
  /** 上次執行結果 */
  lastResult: StrategyResult | StrategyResult[] | null;
  /** 總執行次數 */
  totalRuns: number;
  /** 錯誤次數 */
  errors: number;
}

export type AutoTradeMap = Record<string, AutoTradeEntry>;

/** Runtime 狀態（auto-trade-runtime.json） */
export interface AutoTradeRuntimeEntry {
  lastRun: number | null;
  lastResult: StrategyResult | StrategyResult[] | null;
  totalRuns: number;
  errors: number;
}

export type AutoTradeRuntimeMap = Record<string, AutoTradeRuntimeEntry>;

export interface AutoTradeStatus {
  /** 總數 */
  total: number;
  /** 啟用中 */
  enabled: number;
  /** 停用中 */
  disabled: number;
  /** 上次任一任務執行時間 */
  lastRunTime: number | null;
  /** 各項目摘要 */
  entries: Array<{
    key: string;
    strategy: string;
    symbol: string;
    enabled: boolean;
    interval: string;
    lastRun: string | null;
    totalRuns: number;
    errors: number;
  }>;
}

// ===== 間隔解析 =====

/** 將間隔字串（如 1h, 4h, 1d）轉為毫秒 */
export function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error(`無效的間隔格式：${interval}，請使用如 1h, 4h, 1d`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];

  if (value <= 0) throw new Error('間隔值必須大於 0');
  if (unit === 'd' && value > 30) throw new Error('最大間隔為 30 天');

  let ms: number;
  switch (unit) {
    case 'm': ms = value * 60 * 1000; break;
    case 'h': ms = value * 60 * 60 * 1000; break;
    case 'd': ms = value * 24 * 60 * 60 * 1000; break;
    default: throw new Error(`未知時間單位：${unit}`);
  }

  if (ms < 60000) throw new Error('間隔不得小於 1 分鐘');
  return ms;
}

/** 產生自動交易 key */
function makeKey(strategy: string, symbol: string): string {
  return `${strategy}:${symbol.toUpperCase()}`;
}

/** 從 key 解析 strategy / symbol */
function parseKey(key: string): { strategy: string; symbol: string } {
  const idx = key.indexOf(':');
  if (idx === -1) return { strategy: key, symbol: '' };
  return { strategy: key.slice(0, idx), symbol: key.slice(idx + 1) };
}

// ===== Runtime 檔案讀寫 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readRuntime(): AutoTradeRuntimeMap {
  ensureDataDir();
  if (!existsSync(RUNTIME_FILE)) return {};
  try {
    const raw = readFileSync(RUNTIME_FILE, 'utf-8');
    return JSON.parse(raw) as AutoTradeRuntimeMap;
  } catch {
    return {};
  }
}

function writeRuntime(data: AutoTradeRuntimeMap): void {
  ensureDataDir();
  atomicWriteJson(RUNTIME_FILE, data);
}

function getDefaultRuntime(): AutoTradeRuntimeEntry {
  return { lastRun: null, lastResult: null, totalRuns: 0, errors: 0 };
}

// ===== 公開函式 =====

/**
 * 啟用自動交易
 * 寫入 config-envelope.activeStrategies（acquireLock → mutateEnvelope → releaseLock）
 *
 * Fix #2 (R1-3 殘留): 無論是否提供外部 lock，都走 mutateEnvelope，確保 bump configVersion + snapshot。
 *   - 若提供外部 lock → 使用外部 lock 的 token
 *   - 若未提供（CLI 路徑）→ 內部自行 acquireLock → mutateEnvelope → releaseLock
 */
export function enableAutoTrade(
  strategy: string,
  symbol: string,
  interval: string,
  lock?: LockInfo,
): AutoTradeEntry {
  // 先驗證 interval 格式
  parseInterval(interval);

  const key = makeKey(strategy, symbol);

  if (lock) {
    // 有外部 lock：直接使用
    mutateEnvelope(
      lock.token,
      (env) => {
        env.activeStrategies[key] = { enabled: true, interval };
      },
      `enableAutoTrade: ${key} interval=${interval}`,
    );
  } else {
    // CLI 路徑：自行 acquireLock → mutateEnvelope → releaseLock
    const acquired = acquireLock('scheduler-enable', 30);
    if (!acquired) {
      throw new Error('無法取得 global-lock，請稍後再試（另一個程序正在寫入設定）');
    }
    try {
      mutateEnvelope(
        acquired.token,
        (env) => {
          env.activeStrategies[key] = { enabled: true, interval };
        },
        `enableAutoTrade: ${key} interval=${interval}`,
      );
    } finally {
      releaseLock(acquired.token);
    }
  }

  // 讀取 runtime（保留既有 runtime 狀態）
  const runtime = readRuntime();
  const rt = runtime[key] ?? getDefaultRuntime();

  return {
    enabled: true,
    strategy,
    symbol: symbol.toUpperCase(),
    interval,
    lastRun: rt.lastRun,
    lastResult: rt.lastResult,
    totalRuns: rt.totalRuns,
    errors: rt.errors,
  };
}

/**
 * 停用自動交易
 * 寫入 config-envelope.activeStrategies（acquireLock → mutateEnvelope → releaseLock）
 *
 * Fix #2 (R1-3 殘留): 無論是否提供外部 lock，都走 mutateEnvelope，確保 bump configVersion + snapshot。
 */
export function disableAutoTrade(
  strategy: string,
  symbol: string,
  lock?: LockInfo,
): boolean {
  const key = makeKey(strategy, symbol);

  const envelope = getConfigEnvelope();
  if (!envelope.activeStrategies[key]) {
    return false;
  }

  if (lock) {
    mutateEnvelope(
      lock.token,
      (env) => {
        if (env.activeStrategies[key]) {
          env.activeStrategies[key].enabled = false;
        }
      },
      `disableAutoTrade: ${key}`,
    );
  } else {
    // CLI 路徑：自行 acquireLock → mutateEnvelope → releaseLock
    const acquired = acquireLock('scheduler-disable', 30);
    if (!acquired) {
      throw new Error('無法取得 global-lock，請稍後再試（另一個程序正在寫入設定）');
    }
    try {
      mutateEnvelope(
        acquired.token,
        (env) => {
          if (env.activeStrategies[key]) {
            env.activeStrategies[key].enabled = false;
          }
        },
        `disableAutoTrade: ${key}`,
      );
    } finally {
      releaseLock(acquired.token);
    }
  }
  return true;
}

/**
 * 列出所有自動交易（合併 declarative + runtime）
 */
export function getAutoTrades(): AutoTradeMap {
  const envelope = getConfigEnvelope();
  const runtime = readRuntime();
  const result: AutoTradeMap = {};

  for (const [key, decl] of Object.entries(envelope.activeStrategies)) {
    const { strategy, symbol } = parseKey(key);
    const rt = runtime[key] ?? getDefaultRuntime();

    result[key] = {
      enabled: decl.enabled,
      strategy,
      symbol,
      interval: decl.interval,
      lastRun: rt.lastRun,
      lastResult: rt.lastResult,
      totalRuns: rt.totalRuns,
      errors: rt.errors,
    };
  }

  return result;
}

/**
 * 更新自動交易執行結果（寫入 runtime，不需鎖）
 */
export function updateAutoTradeResult(
  key: string,
  result: StrategyResult | StrategyResult[],
  error?: boolean,
): void {
  const runtime = readRuntime();
  if (!runtime[key]) {
    runtime[key] = getDefaultRuntime();
  }

  runtime[key].lastRun = Date.now();
  runtime[key].lastResult = result;
  runtime[key].totalRuns += 1;
  if (error) {
    runtime[key].errors += 1;
  }

  writeRuntime(runtime);
}

/** 取得自動交易狀態摘要 */
export function getAutoTradeStatus(): AutoTradeStatus {
  const data = getAutoTrades();
  const entries = Object.entries(data);

  let lastRunTime: number | null = null;
  const summaries = entries.map(([key, entry]) => {
    if (entry.lastRun && (lastRunTime === null || entry.lastRun > lastRunTime)) {
      lastRunTime = entry.lastRun;
    }
    return {
      key,
      strategy: entry.strategy,
      symbol: entry.symbol,
      enabled: entry.enabled,
      interval: entry.interval,
      lastRun: entry.lastRun ? new Date(entry.lastRun).toLocaleString('zh-TW') : null,
      totalRuns: entry.totalRuns,
      errors: entry.errors,
    };
  });

  return {
    total: entries.length,
    enabled: entries.filter(([, e]) => e.enabled).length,
    disabled: entries.filter(([, e]) => !e.enabled).length,
    lastRunTime,
    entries: summaries,
  };
}

/** 檢查某個自動交易是否已到執行時間 */
export function isDue(entry: AutoTradeEntry): boolean {
  if (!entry.enabled) return false;
  if (entry.lastRun === null) return true; // 從未執行過

  const intervalMs = parseInterval(entry.interval);
  return Date.now() - entry.lastRun >= intervalMs;
}
