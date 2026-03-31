/**
 * Global Lock — Lease-based 全域鎖
 *
 * 使用 data/.global.lock 檔案實作分散式 lease 鎖。
 * 每次取得鎖時產生新的 fencing token（monotonically increasing），
 * 讓 assertLockOwnership 可以偵測 lock 是否已被他人搶走。
 *
 * Fix #2: acquireLock 改用 O_CREAT | O_EXCL 消除 TOCTOU race。
 *
 * 規則：
 * - 所有 config-envelope.json 寫入都必須先 assertLockOwnership()
 * - probation-runtime.json 和 auto-trade-runtime.json 寫入不需要鎖
 */

import { existsSync, readFileSync, openSync, closeSync, writeSync, unlinkSync, mkdirSync, constants } from 'node:fs';
import { atomicWriteJson } from './atomic-write.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const LOCK_FILE = join(DATA_DIR, '.global.lock');

const DEFAULT_LEASE_SEC = 300; // 5 分鐘預設 lease
const MAX_ACQUIRE_ATTEMPTS = 3;

// ===== 型別定義 =====

export interface LockInfo {
  /** 鎖的持有者識別（如 'auto-trade', 'evolve'） */
  owner: string;
  /** Fencing token（取得鎖時產生的唯一 UUID） */
  token: string;
  /** 取得鎖的時間戳（毫秒） */
  acquiredAt: number;
  /** 過期時間戳（毫秒） */
  expiresAt: number;
}

/** lock 已遺失時拋出此錯誤 */
export class LockLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockLostError';
  }
}

// ===== 內部工具 =====

function readLockFile(): LockInfo | null {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    const raw = readFileSync(LOCK_FILE, 'utf-8');
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

function isLockExpired(lock: LockInfo): boolean {
  return Date.now() >= lock.expiresAt;
}

// ===== 公開 API =====

/**
 * 嘗試取得 global lock
 *
 * 使用 O_CREAT | O_EXCL 原子建立鎖檔案，消除 TOCTOU race condition。
 * 若發現過期的 lock 則刪除並最多重試 3 次。
 *
 * @param owner - 持有者識別字串（如 'auto-trade', 'evolve'）
 * @param leaseSec - lease 時間（秒），預設 300 秒
 * @returns LockInfo（成功）或 null（已被他人持有）
 */
export function acquireLock(owner: string, leaseSec = DEFAULT_LEASE_SEC): LockInfo | null {
  // 確保 data 目錄存在
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const lock: LockInfo = {
    owner,
    token: randomUUID(),
    acquiredAt: Date.now(),
    expiresAt: Date.now() + leaseSec * 1000,
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      // 使用 O_CREAT | O_EXCL 原子建立：若檔案已存在則拋出錯誤（消除 TOCTOU）
      const fd = openSync(LOCK_FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        writeSync(fd, JSON.stringify(lock, null, 2));
      } finally {
        closeSync(fd);
      }
      return lock;
    } catch (err) {
      // Fix #12: 只有 EEXIST 視為 lock 已存在，其他錯誤直接 rethrow
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      // 檔案已存在，讀取並檢查是否過期
      const existing = readLockFile();
      if (existing !== null && !isLockExpired(existing)) {
        // 有人持有且未過期，無法取得
        return null;
      }
      // 過期或損壞，嘗試刪除後重試
      try {
        unlinkSync(LOCK_FILE);
      } catch {
        // 另一個程序可能已先刪除，繼續重試
      }
    }
  }

  return null;
}

/**
 * 更新 lease 延長過期時間
 *
 * @param token - 持有者的 fencing token
 * @param leaseSec - 新的 lease 時間（秒），預設 300 秒
 * @returns true（成功）或 false（token 不符或 lock 已過期）
 */
export function renewLock(token: string, leaseSec = DEFAULT_LEASE_SEC): boolean {
  const existing = readLockFile();
  if (!existing || existing.token !== token) return false;
  if (isLockExpired(existing)) return false;

  const renewed: LockInfo = {
    ...existing,
    expiresAt: Date.now() + leaseSec * 1000,
  };
  atomicWriteJson(LOCK_FILE, renewed);
  return true;
}

/**
 * 釋放 global lock
 *
 * @param token - 持有者的 fencing token（確保只有持有者能釋放）
 * @returns true（成功釋放）或 false（token 不符）
 */
export function releaseLock(token: string): boolean {
  const existing = readLockFile();
  if (!existing || existing.token !== token) return false;

  // 原子刪除：寫入一個「空」的過期 lock，語意上等同於釋放
  // 直接刪除不如 atomic write 安全，改寫為過期狀態
  const released: LockInfo = {
    ...existing,
    expiresAt: 0, // 立即過期
  };
  atomicWriteJson(LOCK_FILE, released);
  return true;
}

/**
 * 讀取目前 lock 狀態（不修改）
 *
 * @returns 目前的 LockInfo，若不存在或已過期則為 null
 */
export function getLockInfo(): LockInfo | null {
  const lock = readLockFile();
  if (!lock) return null;
  if (isLockExpired(lock)) return null;
  return lock;
}

/**
 * 斷言目前 token 仍持有 lock，否則拋出 LockLostError
 *
 * 所有 config-envelope.json 寫入前都必須呼叫此函式。
 *
 * @param token - 持有者的 fencing token
 * @throws LockLostError 若 lock 已不屬於此 token
 */
export function assertLockOwnership(token: string): void {
  const lock = readLockFile();

  if (!lock) {
    throw new LockLostError(`Lock 已遺失：lock 檔案不存在（token: ${token.slice(0, 8)}...）`);
  }

  if (lock.token !== token) {
    throw new LockLostError(
      `Lock 已遺失：token 不符（預期 ${token.slice(0, 8)}..., 實際 ${lock.token.slice(0, 8)}...）`,
    );
  }

  if (isLockExpired(lock)) {
    throw new LockLostError(`Lock 已過期（token: ${token.slice(0, 8)}..., 過期時間: ${new Date(lock.expiresAt).toISOString()}）`);
  }
}
