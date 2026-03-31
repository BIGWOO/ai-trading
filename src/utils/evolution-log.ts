/**
 * Evolution Log — 進化事件記錄
 *
 * 記錄所有進化相關事件（優化、回滾、畢業、跳過、切換）。
 * 存在 data/evolution-log.json。
 *
 * 用途：
 * - Mode B 回滾：掃描最近 N 筆 optimization 的績效連續衰退
 * - 審計追蹤：了解系統自動做了什麼決策
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { atomicWriteJson } from './atomic-write.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const EVOLUTION_LOG_FILE = join(DATA_DIR, 'evolution-log.json');

// ===== 型別定義 =====

export interface EvolutionLogEntry {
  /** 事件類型 */
  type: 'optimization' | 'rollback' | 'graduation' | 'skip' | 'switch';
  /** 事件時間戳（毫秒） */
  timestamp: number;
  /** 此事件對應的 configVersion */
  configVersion: number;
  /** 策略 ID */
  strategyId: string;
  /** 事件原因說明 */
  reason: string;
  /** 績效指標 */
  metrics: {
    dailyPnL?: number;
    sharpe?: number;
    backtestReturn?: number;
    liveReturn?: number;
  };
  /** 回滾模式（rollback 事件時） */
  rollbackMode?: 'probation_drawdown' | 'consecutive_decline';
}

// ===== 內部工具 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readLog(): EvolutionLogEntry[] {
  if (!existsSync(EVOLUTION_LOG_FILE)) return [];
  try {
    const raw = readFileSync(EVOLUTION_LOG_FILE, 'utf-8');
    return JSON.parse(raw) as EvolutionLogEntry[];
  } catch {
    return [];
  }
}

function writeLog(entries: EvolutionLogEntry[]): void {
  ensureDataDir();
  atomicWriteJson(EVOLUTION_LOG_FILE, entries);
}

// ===== 公開 API =====

/**
 * 追加一筆進化事件
 *
 * @param entry - 事件記錄
 */
export function appendEvolutionLog(entry: EvolutionLogEntry): void {
  const log = readLog();
  log.push(entry);
  writeLog(log);
}

/**
 * 取得最近 N 筆事件記錄
 *
 * @param limit - 最多回傳幾筆（預設 50）
 * @returns 最近的事件（由新到舊）
 */
export function getRecentLogs(limit = 50): EvolutionLogEntry[] {
  const log = readLog();
  return log.slice(-limit).reverse();
}

/**
 * 取得指定策略最近的連續衰退紀錄
 *
 * 掃描最近 count 筆 type=optimization 的記錄，
 * 檢查 metrics.dailyPnL 是否連續衰退（每筆都比前一筆差）。
 *
 * @param strategyId - 策略 ID
 * @param count - 要查的連續次數
 * @returns 符合條件的記錄（若連續衰退 count 次）；若未達 count 次則回空陣列
 */
export function getConsecutiveDeclines(strategyId: string, count: number): EvolutionLogEntry[] {
  const log = readLog();

  // 篩選指定策略的 optimization 事件（由舊到新）
  const optimizations = log.filter(
    (e) => e.type === 'optimization' && e.strategyId === strategyId,
  );

  if (optimizations.length < count) return [];

  // 取最後 count 筆
  const recent = optimizations.slice(-count);

  // 檢查 dailyPnL 是否連續遞減
  let isDecline = true;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].metrics.dailyPnL;
    const curr = recent[i].metrics.dailyPnL;
    if (prev === undefined || curr === undefined || curr >= prev) {
      isDecline = false;
      break;
    }
  }

  return isDecline ? recent : [];
}

/**
 * 查詢事件記錄（依類型或策略過濾）
 *
 * @param filter - 過濾條件
 * @returns 符合條件的事件（由新到舊）
 */
export function queryEvolutionLog(filter?: {
  type?: EvolutionLogEntry['type'];
  strategyId?: string;
  since?: number;
  limit?: number;
}): EvolutionLogEntry[] {
  let log = readLog();

  if (filter?.type) {
    log = log.filter((e) => e.type === filter.type);
  }
  if (filter?.strategyId) {
    log = log.filter((e) => e.strategyId === filter.strategyId);
  }
  if (filter?.since !== undefined) {
    log = log.filter((e) => e.timestamp >= filter.since!);
  }

  const result = log.reverse();
  if (filter?.limit) {
    return result.slice(0, filter.limit);
  }
  return result;
}
