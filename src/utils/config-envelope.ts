/**
 * Config Envelope — 純 declarative 設定容器
 *
 * 管理 data/config-envelope.json，這是整個進化架構的控制平面。
 * 只存放 declarative 狀態（策略參數、active 策略、probation 宣告、close-only 標記）。
 * Runtime 狀態（lastRun、peak 等）存在獨立的 runtime 檔案。
 *
 * Fix #3: saveConfigEnvelope() 加第二參數 fencingToken，除 BOOTSTRAP_TOKEN 外均強制 assert。
 * Fix #4: 新增 evolutionConfig 欄位（預設值）。
 * Fix #5: 遷移 auto-trading.json 改用 resolveStrategyId (ID_MAP)。
 *
 * mutateEnvelope helper 在 config-ops.ts（避免循環依賴 config-history ↔ config-envelope）
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { atomicWriteJson } from './atomic-write.js';
import { assertLockOwnership } from './global-lock.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategyConfigMap } from '../strategy-config.js';
import { getAllStrategyConfigs } from '../strategy-config.js';
import { ensureConsistency, getAllSnapshots } from './config-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const BACKUP_DIR = join(DATA_DIR, '_backup');
const ENVELOPE_FILE = join(DATA_DIR, 'config-envelope.json');

// 舊檔案路徑（遷移來源）
const OLD_STRATEGY_CONFIG = join(DATA_DIR, 'strategy-config.json');
const OLD_AUTO_TRADING = join(DATA_DIR, 'auto-trading.json');

/**
 * 特殊 bootstrap token — 只在初始化（檔案不存在）時允許無鎖寫入。
 */
export const BOOTSTRAP_TOKEN = '__bootstrap__';

/** 用於 auto-trading.json 遷移的 strategy name → id 對照表 (Fix #5) */
const ID_MAP: Record<string, string> = {
  '均線交叉策略': 'ma-cross',
  'RSI 策略': 'rsi',
  '網格交易策略': 'grid',
  'ma-cross': 'ma-cross',
  'rsi': 'rsi',
  'grid': 'grid',
};

/** 從策略名稱（中文或 id）解析出標準 id */
export function resolveStrategyIdFromName(name: string): string {
  return ID_MAP[name] ?? name;
}

// ===== 型別定義 =====

/** Probation 宣告部分（存在 envelope） */
export interface ProbationDeclarative {
  /** 此 probation 對應的 configVersion */
  configVersion: number;
  /** 啟動時間戳（毫秒） */
  activatedAt: number;
  /** 啟動時的 equity（報告比較用） */
  baselineEquity: number;
  /** 受影響的策略 IDs */
  affectedStrategies: string[];
  /** drawdown 回滾閾值（%，負數） */
  drawdownThresholdPercent: number;
  /** probation 到期時間戳（毫秒） */
  expiresAt: number;
}

/** Active 策略條目（只存 declarative 部分） */
export interface ActiveStrategyEntry {
  /** 是否啟用 */
  enabled: boolean;
  /** 執行間隔（如 '1h', '4h'） */
  interval: string;
}

/** Evolution 設定（進化參數） */
export interface EvolutionConfig {
  /** 是否啟用自動進化 */
  enabled: boolean;
  /** 進化觸發間隔（小時） */
  intervalHours: number;
  /** Probation 期長（小時） */
  probationHours: number;
  /** 回滾 drawdown 閾值（%，負數） */
  rollbackThresholdPercent: number;
}

/** Config Envelope 完整結構 */
export interface ConfigEnvelope {
  /** 版本號，只在 declarative 欄位變更時遞增 */
  configVersion: number;
  /** 最後更新時間戳（毫秒） */
  updatedAt: number;
  /** 各策略的 declarative 參數 */
  strategyConfigs: StrategyConfigMap;
  /** Active 策略表（key 格式：'strategy-id:SYMBOL'） */
  activeStrategies: Record<string, ActiveStrategyEntry>;
  /** Probation 宣告（同時只允許一個，null = 無） */
  probation: ProbationDeclarative | null;
  /** Mode A 回滾後進入 close-only 的 symbol 清單 */
  closeOnlySymbols: string[];
  /** 進化設定（Fix #4：新增欄位） */
  evolutionConfig: EvolutionConfig;
}

// ===== 預設值 =====

const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: false,
  intervalHours: 24,
  probationHours: 72,
  rollbackThresholdPercent: -5,
};

function buildDefaultEnvelope(): ConfigEnvelope {
  return {
    configVersion: 1,
    updatedAt: Date.now(),
    strategyConfigs: getAllStrategyConfigs(),
    activeStrategies: {},
    probation: null,
    closeOnlySymbols: [],
    evolutionConfig: { ...DEFAULT_EVOLUTION_CONFIG },
  };
}

// ===== 舊檔遷移 =====

/** 確保備份目錄存在 */
function ensureBackupDir(): void {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

/**
 * 從舊檔遷移到 config-envelope.json
 *
 * Fix #5: 遷移時用 resolveStrategyIdFromName() 把中文名轉成標準 id
 */
function migrateFromLegacy(): ConfigEnvelope {
  const envelope = buildDefaultEnvelope();

  // 遷移 strategy-config.json
  if (existsSync(OLD_STRATEGY_CONFIG)) {
    try {
      const raw = readFileSync(OLD_STRATEGY_CONFIG, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<StrategyConfigMap>;
      envelope.strategyConfigs = {
        'ma-cross': { ...envelope.strategyConfigs['ma-cross'], ...parsed['ma-cross'] },
        'rsi': { ...envelope.strategyConfigs['rsi'], ...parsed['rsi'] },
        'grid': { ...envelope.strategyConfigs['grid'], ...parsed['grid'] },
      };
      console.log('📦 已從 strategy-config.json 遷移策略參數');

      ensureBackupDir();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(OLD_STRATEGY_CONFIG, join(BACKUP_DIR, `strategy-config.${ts}.json`));
      console.log(`💾 備份至 data/_backup/strategy-config.${ts}.json`);
    } catch (err) {
      console.warn(`⚠️ 遷移 strategy-config.json 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 遷移 auto-trading.json → activeStrategies
  if (existsSync(OLD_AUTO_TRADING)) {
    try {
      const raw = readFileSync(OLD_AUTO_TRADING, 'utf-8');
      const autoTradeMap = JSON.parse(raw) as Record<string, {
        enabled: boolean;
        strategy: string;
        symbol: string;
        interval: string;
      }>;

      for (const entry of Object.values(autoTradeMap)) {
        // Fix #5: 用 resolveStrategyIdFromName 把中文名或舊 id 轉成標準 id
        const strategyId = resolveStrategyIdFromName(entry.strategy);
        const normalKey = `${strategyId}:${entry.symbol.toUpperCase()}`;
        envelope.activeStrategies[normalKey] = {
          enabled: entry.enabled,
          interval: entry.interval,
        };
      }

      const count = Object.keys(autoTradeMap).length;
      if (count > 0) {
        console.log(`📦 已從 auto-trading.json 遷移 ${count} 個自動交易設定`);
        ensureBackupDir();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        copyFileSync(OLD_AUTO_TRADING, join(BACKUP_DIR, `auto-trading.${ts}.json`));
        console.log(`💾 備份至 data/_backup/auto-trading.${ts}.json`);
      }
    } catch (err) {
      console.warn(`⚠️ 遷移 auto-trading.json 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return envelope;
}

// ===== 讀寫 API =====

/**
 * 讀取 config-envelope.json
 * 若不存在，自動從舊檔遷移並儲存
 */
export function getConfigEnvelope(): ConfigEnvelope {
  if (!existsSync(ENVELOPE_FILE)) {
    const envelope = migrateFromLegacy();
    // Bootstrap 寫入：檔案不存在時允許無鎖寫入
    atomicWriteJson(ENVELOPE_FILE, envelope);
    // Fix #11: bootstrap 路徑末尾補建一致性快照
    ensureConsistency(envelope);
    return envelope;
  }

  try {
    const raw = readFileSync(ENVELOPE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ConfigEnvelope>;
    const defaults = getAllStrategyConfigs();

    // 確保必要欄位存在（向後相容）
    const envelope: ConfigEnvelope = {
      configVersion: parsed.configVersion ?? 1,
      updatedAt: parsed.updatedAt ?? Date.now(),
      strategyConfigs: {
        'ma-cross': { ...defaults['ma-cross'], ...parsed.strategyConfigs?.['ma-cross'] },
        'rsi': { ...defaults['rsi'], ...parsed.strategyConfigs?.['rsi'] },
        'grid': { ...defaults['grid'], ...parsed.strategyConfigs?.['grid'] },
      },
      activeStrategies: parsed.activeStrategies ?? {},
      probation: parsed.probation ?? null,
      closeOnlySymbols: parsed.closeOnlySymbols ?? [],
      evolutionConfig: { ...DEFAULT_EVOLUTION_CONFIG, ...parsed.evolutionConfig },
    };
    // Fix R2-4: 正常讀取路徑也呼叫 ensureConsistency，確保 history 有對應快照
    ensureConsistency(envelope);
    return envelope;
  } catch {
    // 損壞：先嘗試從 config-history 最新快照恢復（Fix R3: fail closed）
    const snapshots = getAllSnapshots();
    if (snapshots.length > 0) {
      // 取版本號最高的快照
      const latest = snapshots[snapshots.length - 1];
      console.warn(`⚠️ config-envelope.json 損壞，從 config-history v${latest.configVersion} 恢復`);
      const recovered = structuredClone(latest.envelope);
      // 確保向後相容欄位存在
      if (!recovered.evolutionConfig) {
        recovered.evolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG };
      }
      // 恢復後寫回磁碟（無鎖寫入，因為 envelope 不存在/已損壞）
      atomicWriteJson(ENVELOPE_FILE, recovered);
      ensureConsistency(recovered);
      return recovered;
    }

    // config-history 也沒有 → fail closed（拒絕啟動）
    // 只有第一次初始化（檔案完全不存在）才可以用預設值，這個路徑不應該出現
    throw new Error(
      'config-envelope.json 損壞且 config-history 無快照可供恢復。' +
      '請手動刪除 data/config-envelope.json 並重新啟動以初始化（這將重置所有設定）。',
    );
  }
}

/**
 * 儲存 config-envelope.json
 *
 * Fix #3: 強制 assertLockOwnership，除 BOOTSTRAP_TOKEN 外均要求持有 lock。
 * 寫入順序：先 saveSnapshot（在 config-history）再呼叫此函式。
 *
 * @param envelope - 要儲存的 envelope
 * @param fencingToken - 必須持有 global-lock 的 fencing token（或 BOOTSTRAP_TOKEN）
 */
export function saveConfigEnvelope(envelope: ConfigEnvelope, fencingToken: string): void {
  if (fencingToken !== BOOTSTRAP_TOKEN) {
    assertLockOwnership(fencingToken);
  }
  atomicWriteJson(ENVELOPE_FILE, envelope);
}

/**
 * 取得 config-envelope 路徑（供其他模組使用）
 */
export function getEnvelopePath(): string {
  return ENVELOPE_FILE;
}
