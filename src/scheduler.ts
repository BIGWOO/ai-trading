/**
 * 自動交易狀態管理
 * 管理哪些策略+幣對啟用了自動交易
 *
 * 狀態：data/auto-trading.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategyResult } from './strategies/base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const AUTO_TRADING_FILE = join(DATA_DIR, 'auto-trading.json');

// ===== 型別定義 =====

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
  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`未知時間單位：${unit}`);
  }
}

/** 產生自動交易 key */
function makeKey(strategy: string, symbol: string): string {
  return `${strategy}:${symbol.toUpperCase()}`;
}

// ===== 檔案讀寫 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readAutoTrades(): AutoTradeMap {
  ensureDataDir();
  if (!existsSync(AUTO_TRADING_FILE)) {
    return {};
  }
  try {
    const raw = readFileSync(AUTO_TRADING_FILE, 'utf-8');
    return JSON.parse(raw) as AutoTradeMap;
  } catch {
    return {};
  }
}

function writeAutoTrades(data: AutoTradeMap): void {
  ensureDataDir();
  writeFileSync(AUTO_TRADING_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ===== 公開函式 =====

/** 啟用自動交易 */
export function enableAutoTrade(strategy: string, symbol: string, interval: string): AutoTradeEntry {
  // 先驗證 interval 格式
  parseInterval(interval);

  const data = readAutoTrades();
  const key = makeKey(strategy, symbol);

  const existing = data[key];
  data[key] = {
    enabled: true,
    strategy,
    symbol: symbol.toUpperCase(),
    interval,
    lastRun: existing?.lastRun ?? null,
    lastResult: existing?.lastResult ?? null,
    totalRuns: existing?.totalRuns ?? 0,
    errors: existing?.errors ?? 0,
  };

  writeAutoTrades(data);
  return data[key];
}

/** 停用自動交易 */
export function disableAutoTrade(strategy: string, symbol: string): boolean {
  const data = readAutoTrades();
  const key = makeKey(strategy, symbol);

  if (!data[key]) {
    return false;
  }

  data[key].enabled = false;
  writeAutoTrades(data);
  return true;
}

/** 列出所有自動交易 */
export function getAutoTrades(): AutoTradeMap {
  return readAutoTrades();
}

/** 更新自動交易執行結果 */
export function updateAutoTradeResult(
  key: string,
  result: StrategyResult | StrategyResult[],
  error?: boolean,
): void {
  const data = readAutoTrades();
  if (!data[key]) return;

  data[key].lastRun = Date.now();
  data[key].lastResult = result;
  data[key].totalRuns += 1;
  if (error) {
    data[key].errors += 1;
  }

  writeAutoTrades(data);
}

/** 取得自動交易狀態摘要 */
export function getAutoTradeStatus(): AutoTradeStatus {
  const data = readAutoTrades();
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
