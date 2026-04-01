/**
 * Trade Journal — 交易日誌
 *
 * 每筆交易寫入 data/trade-journal.jsonl（JSONL 格式）。
 * 提供 append / read 功能，供覆盤和報告使用。
 *
 * Phase B-1: Self-Evolution Plan v7
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const JOURNAL_FILE = join(DATA_DIR, 'trade-journal.jsonl');

// ===== 型別定義 =====

export interface JournalEntry {
  /** 時間戳（毫秒） */
  timestamp: number;
  /** 策略 ID */
  strategyId: string;
  /** 交易對 */
  symbol: string;
  /** 動作 */
  action: 'BUY' | 'SELL' | 'HOLD';
  /** 成交價格 */
  price?: string;
  /** 成交數量 */
  quantity?: string;
  /** 損益（SELL 時） */
  pnl?: number;
  /** 設定版本號 */
  configVersion: number;
  /** 指標快照 */
  indicators?: Record<string, number>;
  /** 原因說明 */
  reason: string;
  /** 市場狀態 */
  marketRegime?: string;
}

// ===== 內部工具 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 讀取所有 journal entries
 */
function readAllEntries(): JournalEntry[] {
  if (!existsSync(JOURNAL_FILE)) return [];

  try {
    const raw = readFileSync(JOURNAL_FILE, 'utf-8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const entries: JournalEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // 跳過損壞的行
      }
    }

    return entries;
  } catch {
    return [];
  }
}

// ===== 公開 API =====

/**
 * 追加一筆交易日誌
 *
 * @param entry - 日誌條目
 */
export function appendJournalEntry(entry: JournalEntry): void {
  ensureDataDir();
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(JOURNAL_FILE, line, 'utf-8');
}

/**
 * 讀取最近 N 筆交易日誌
 *
 * @param count - 要讀取的筆數
 * @returns 最近的日誌條目（由舊到新）
 */
export function getRecentJournalEntries(count: number): JournalEntry[] {
  const entries = readAllEntries();
  return entries.slice(-count);
}

/**
 * 讀取指定時間後的所有日誌條目
 *
 * @param timestamp - 起始時間戳（毫秒）
 * @returns 該時間後的所有條目（由舊到新）
 */
export function getJournalEntriesSince(timestamp: number): JournalEntry[] {
  const entries = readAllEntries();
  return entries.filter((e) => e.timestamp >= timestamp);
}

/**
 * 取得 journal 檔案路徑（供外部工具使用）
 */
export function getJournalPath(): string {
  return JOURNAL_FILE;
}
