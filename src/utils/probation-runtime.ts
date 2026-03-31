/**
 * Probation Runtime — Probation 高水位標記
 *
 * 管理 data/probation-runtime.json，
 * 記錄 probation 期間的高水位 equity（peakSinceActivation）。
 *
 * 寫入此檔案不需要 global-lock（runtime 狀態，不影響 configVersion）。
 * auto-trade 和 evolve 都可以更新，不需要協調。
 */

import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeSync, constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { atomicWriteJson } from './atomic-write.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PROBATION_RUNTIME_FILE = join(DATA_DIR, 'probation-runtime.json');
const PROBATION_PEAK_LOCK_FILE = join(DATA_DIR, 'probation-peak.lock');

// ===== File lock for probation peak read-compare-write =====

// Fix R5-5: lock 檔案格式，包含 PID 和建立時間，用於 stale 偵測
interface PeakLockContent {
  pid: number;
  createdAt: number;
}

/** Fix R5-5: stale lock TTL（毫秒），超過此時間視為 stale */
const PEAK_LOCK_TTL_MS = 30_000;

/** 嘗試以 O_CREAT|O_EXCL 建立 lock 檔案（原子操作，避免 race condition） */
function tryAcquirePeakLock(): boolean {
  try {
    const fd = openSync(PROBATION_PEAK_LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    try {
      // Fix R5-5: lock 檔案內寫入 PID 和建立時間
      const content: PeakLockContent = { pid: process.pid, createdAt: Date.now() };
      writeSync(fd, JSON.stringify(content));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function releasePeakLock(): void {
  try {
    if (existsSync(PROBATION_PEAK_LOCK_FILE)) {
      unlinkSync(PROBATION_PEAK_LOCK_FILE);
    }
  } catch {
    // ignore
  }
}

/**
 * Fix R5-5: 檢查 lock 是否為 stale（持有程序已死或超過 TTL）
 * @returns true 若 lock 是 stale 且應被清除
 */
function isStalePeakLock(): boolean {
  try {
    if (!existsSync(PROBATION_PEAK_LOCK_FILE)) return false;
    const raw = readFileSync(PROBATION_PEAK_LOCK_FILE, 'utf-8');
    // 向後相容：舊的空 lock 檔案視為 stale
    if (!raw.trim()) return true;
    const content = JSON.parse(raw) as PeakLockContent;
    // 檢查 PID 是否仍存活
    try {
      process.kill(content.pid, 0); // 不發送信號，只檢查程序是否存在
    } catch {
      // PID 已死，lock 是 stale
      return true;
    }
    // 檢查是否超過 TTL
    if (Date.now() - content.createdAt > PEAK_LOCK_TTL_MS) {
      return true;
    }
    return false;
  } catch {
    // 無法讀取 lock 檔案，視為 stale
    return true;
  }
}

/**
 * 取得 probation peak lock，最多重試指定次數。
 * Fix R5-5: 失敗時檢測 stale lock（PID 已死或超過 TTL），自動清除後重試。
 * @returns true 若成功取得 lock
 */
function acquirePeakLock(maxRetries = 10, retryMs = 50): boolean {
  for (let i = 0; i < maxRetries; i++) {
    if (tryAcquirePeakLock()) return true;
    // Fix R5-5: 檢測 stale lock
    if (isStalePeakLock()) {
      console.warn('⚠️ acquirePeakLock: 偵測到 stale lock，清除後重試');
      try { unlinkSync(PROBATION_PEAK_LOCK_FILE); } catch { /* ignore */ }
      // 清除後立即重試一次
      if (tryAcquirePeakLock()) return true;
    }
    // 同步等待（Node.js 環境下 probation-runtime 寫入很快，短暫 spin 即可）
    const until = Date.now() + retryMs;
    while (Date.now() < until) { /* spin */ }
  }
  return false;
}

/**
 * Fix R5-5: 程式啟動時清理 stale peak lock
 * 應在 auto-trade 或主程式入口呼叫
 */
export function cleanupStalePeakLock(): void {
  if (isStalePeakLock()) {
    console.log('🧹 cleanupStalePeakLock: 清除啟動前遺留的 stale peak lock');
    try { unlinkSync(PROBATION_PEAK_LOCK_FILE); } catch { /* ignore */ }
  }
}

// ===== 型別定義 =====

export interface ProbationRuntime {
  /** 自 probation 啟動以來的最高 equity（高水位） */
  peakSinceActivation: number;
  /** 最後一次更新時間戳（毫秒） */
  lastCheckedAt: number;
}

// ===== 內部工具 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ===== 公開 API =====

/**
 * 讀取 probation runtime 狀態
 *
 * @returns ProbationRuntime 或 null（probation 不存在或尚未初始化）
 */
export function getProbationRuntime(): ProbationRuntime | null {
  if (!existsSync(PROBATION_RUNTIME_FILE)) return null;
  try {
    const raw = readFileSync(PROBATION_RUNTIME_FILE, 'utf-8');
    return JSON.parse(raw) as ProbationRuntime;
  } catch {
    return null;
  }
}

/**
 * 初始化 probation runtime（probation 啟動時呼叫）
 *
 * @param initialEquity - 啟動時的 equity（作為初始高水位）
 */
export function initProbationRuntime(initialEquity: number): ProbationRuntime {
  ensureDataDir();
  const runtime: ProbationRuntime = {
    peakSinceActivation: initialEquity,
    lastCheckedAt: Date.now(),
  };
  atomicWriteJson(PROBATION_RUNTIME_FILE, runtime);
  return runtime;
}

/**
 * 更新 peakSinceActivation（若 currentEquity 超過現有高水位）
 *
 * Fix R4-3: 用 O_CREAT|O_EXCL file lock 保護整個 read-compare-write cycle，
 * 避免並發寫入互相覆蓋造成 lost-update race。
 *
 * @param currentEquity - 目前的 equity
 * @returns 更新後的 runtime（或原本的 runtime 若未更新）
 */
export function updateProbationPeak(currentEquity: number): ProbationRuntime | null {
  ensureDataDir();

  // 取得 file lock，保護整個 read-compare-write cycle
  const locked = acquirePeakLock();
  if (!locked) {
    console.warn('⚠️ updateProbationPeak: 無法取得 peak lock，跳過本次更新');
    return getProbationRuntime();
  }

  try {
    const runtime = getProbationRuntime();
    if (!runtime) return null;

    const newPeak = Math.max(runtime.peakSinceActivation, currentEquity);
    const updated: ProbationRuntime = {
      peakSinceActivation: newPeak,
      lastCheckedAt: Date.now(),
    };

    atomicWriteJson(PROBATION_RUNTIME_FILE, updated);
    return updated;
  } finally {
    releasePeakLock();
  }
}

/**
 * 清除 probation runtime（probation 結束時呼叫：畢業或回滾）
 *
 * @returns true 若成功清除，false 若檔案不存在
 */
export function clearProbationRuntime(): boolean {
  if (!existsSync(PROBATION_RUNTIME_FILE)) return false;

  // 寫入空標記而非刪除檔案，避免 race condition
  ensureDataDir();
  atomicWriteJson(PROBATION_RUNTIME_FILE, null);
  return true;
}

/**
 * 計算目前的 drawdown 百分比
 *
 * drawdown = (currentEquity - peak) / peak × 100
 * 負值表示虧損。
 *
 * @param currentEquity - 目前 equity
 * @returns drawdown 百分比，或 null（無 probation runtime）
 */
export function calculateDrawdown(currentEquity: number): number | null {
  const runtime = getProbationRuntime();
  if (!runtime) return null;
  if (runtime.peakSinceActivation <= 0) return null;

  return ((currentEquity - runtime.peakSinceActivation) / runtime.peakSinceActivation) * 100;
}
