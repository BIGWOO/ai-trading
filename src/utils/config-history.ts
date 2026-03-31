/**
 * Config History — 快照歷史管理
 *
 * 記錄每次 config-envelope 變更的快照，
 * 支援回滾到任意版本，並追蹤 probation 畢業狀態。
 *
 * 寫入順序（crash safety）：先 saveSnapshot → 再 saveConfigEnvelope
 * 啟動時 consistency check：確認 envelope.configVersion 在 history 有對應快照，
 * 若無則自動補建。
 */

import { existsSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { atomicWriteJson } from './atomic-write.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigEnvelope } from './config-envelope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const HISTORY_FILE = join(DATA_DIR, 'config-history.json');

// ===== 型別定義 =====

export interface ConfigEnvelopeSnapshot {
  /** 此快照對應的 configVersion */
  configVersion: number;
  /** 前一個版本號（第一個快照為 null） */
  previousVersion: number | null;
  /** 快照時間戳（毫秒） */
  timestamp: number;
  /** envelope 完整內容 */
  envelope: ConfigEnvelope;
  /** 此版本變更的原因說明 */
  reason: string;
  /** Probation 畢業後設為 true（表示此版本已驗證為穩定） */
  graduated: boolean;
  /** 可選的績效指標 */
  metrics?: {
    backtestSharpe?: number;
    backtestReturn?: number;
    livePnL?: number;
  };
}

// ===== 內部工具 =====

function readHistory(): ConfigEnvelopeSnapshot[] {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw) as ConfigEnvelopeSnapshot[];
  } catch (err) {
    // Fix R4-5: parse 失敗時 rename 原檔為 .bak，保留證據，降級為空 history（不阻止啟動）
    const backupPath = `${HISTORY_FILE}.${Date.now()}.bak`;
    try {
      renameSync(HISTORY_FILE, backupPath);
      console.warn(`⚠️ config-history.json 解析失敗，已備份至 ${backupPath}，繼續以空 history 啟動`);
      console.warn(`   錯誤原因：${err instanceof Error ? err.message : String(err)}`);
    } catch (renameErr) {
      console.warn(`⚠️ config-history.json 解析失敗，且備份失敗：${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
    }
    return [];
  }
}

function writeHistory(snapshots: ConfigEnvelopeSnapshot[]): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  atomicWriteJson(HISTORY_FILE, snapshots);
}

// ===== 公開 API =====

/**
 * 儲存一個新快照
 *
 * 冪等：若相同 configVersion 的快照已存在，會以新快照覆蓋（避免重複）。
 *
 * @param snapshot - 要儲存的快照
 */
export function saveSnapshot(snapshot: ConfigEnvelopeSnapshot): void {
  const history = readHistory();

  // Fix #9: 若同版本快照已存在，保留 graduated/metrics/previousVersion（merge 而非覆蓋）
  const existing = history.find((s) => s.configVersion === snapshot.configVersion);
  if (existing) {
    if (existing.graduated) snapshot.graduated = existing.graduated;
    if (existing.metrics !== undefined && snapshot.metrics === undefined) {
      snapshot.metrics = existing.metrics;
    }
    if (existing.previousVersion !== null && snapshot.previousVersion === null) {
      snapshot.previousVersion = existing.previousVersion;
    }
  }

  // 冪等：移除同版本的舊快照
  const filtered = history.filter((s) => s.configVersion !== snapshot.configVersion);
  filtered.push(snapshot);

  // 依版本號排序（升序）
  filtered.sort((a, b) => a.configVersion - b.configVersion);

  writeHistory(filtered);
}

/**
 * 取得指定版本的快照
 *
 * @param version - configVersion
 * @returns 快照或 null（不存在）
 */
export function getSnapshot(version: number): ConfigEnvelopeSnapshot | null {
  const history = readHistory();
  return history.find((s) => s.configVersion === version) ?? null;
}

/**
 * 取得所有快照（依版本升序）
 */
export function getAllSnapshots(): ConfigEnvelopeSnapshot[] {
  return readHistory();
}

/**
 * 取得最後一個畢業版本（graduated === true）的 configVersion
 *
 * lastStableVersion = 最後一個 probation 畢業的 configVersion
 *
 * @returns configVersion 或 null（沒有任何畢業版本）
 */
export function getLastStableVersion(): number | null {
  const history = readHistory();
  const graduated = history.filter((s) => s.graduated);
  if (graduated.length === 0) return null;

  // 取最新的畢業版本
  const sorted = graduated.sort((a, b) => b.configVersion - a.configVersion);
  return sorted[0].configVersion;
}

/**
 * 標記指定版本為畢業（graduated = true）
 *
 * @param version - configVersion
 * @returns true（成功）或 false（版本不存在）
 */
export function markGraduated(version: number): boolean {
  const history = readHistory();
  const idx = history.findIndex((s) => s.configVersion === version);
  if (idx === -1) return false;

  history[idx].graduated = true;
  writeHistory(history);
  return true;
}

/**
 * 從快照取得指定版本的 envelope（用於回滾）
 *
 * @param targetVersion - 要回滾到的 configVersion
 * @returns envelope 內容
 * @throws Error 若版本不存在
 */
export function rollbackToVersion(targetVersion: number): ConfigEnvelope {
  const snapshot = getSnapshot(targetVersion);
  if (!snapshot) {
    throw new Error(`找不到版本 ${targetVersion} 的快照，無法回滾`);
  }
  return structuredClone(snapshot.envelope);
}

/**
 * 啟動時 consistency check
 *
 * 確認 envelope.configVersion 在 history 有對應快照，
 * 若無則自動補建一個「startup auto-补建」快照。
 *
 * @param currentEnvelope - 目前的 config-envelope
 */
export function ensureConsistency(currentEnvelope: ConfigEnvelope): void {
  const existing = getSnapshot(currentEnvelope.configVersion);
  if (!existing) {
    console.log(`⚠️ config-history: 版本 ${currentEnvelope.configVersion} 無快照，自動補建...`);
    const history = readHistory();
    const previousVersions = history
      .filter((s) => s.configVersion < currentEnvelope.configVersion)
      .sort((a, b) => b.configVersion - a.configVersion);
    const previousVersion = previousVersions.length > 0 ? previousVersions[0].configVersion : null;

    saveSnapshot({
      configVersion: currentEnvelope.configVersion,
      previousVersion,
      timestamp: Date.now(),
      envelope: structuredClone(currentEnvelope),
      reason: 'startup auto-recovery: missing snapshot補建',
      graduated: false,
    });
  }
}
