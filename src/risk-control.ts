/**
 * 風控模組
 * 管理交易風險控制，防止過度虧損
 *
 * 設定：data/risk-config.json
 * 狀態：data/risk-state.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'risk-config.json');
const STATE_FILE = join(DATA_DIR, 'risk-state.json');

// ===== 型別定義 =====

export interface RiskConfig {
  /** 單日虧損上限百分比（負數，如 -5 代表 -5%） */
  maxDailyLossPercent: number;
  /** 最大回撤暫停百分比（負數，如 -10 代表 -10%） */
  maxDrawdownPercent: number;
  /** 單日最大交易次數 */
  maxDailyTrades: number;
  /** 連續虧損暫停次數 */
  maxConsecutiveLosses: number;
  /** 初始資金（計算百分比用） */
  initialCapital: number;
}

export interface RiskState {
  /** 當日日期（YYYY-MM-DD） */
  date: string;
  /** 當日已實現損益（USDT） */
  dailyPnL: number;
  /** 當日交易次數 */
  dailyTradeCount: number;
  /** 連續虧損次數（連贏則歸零） */
  consecutiveLosses: number;
  /** 歷史權益高點（USDT） */
  equityPeak: number;
  /** 當前權益（USDT） */
  currentEquity: number;
}

export interface RiskCheckResult {
  /** 是否允許交易 */
  allowed: boolean;
  /** 禁止原因（allowed=false 時） */
  reason?: string;
}

export interface RiskStatus {
  config: RiskConfig;
  state: RiskState;
  checks: {
    dailyLoss: { current: string; limit: string; triggered: boolean };
    drawdown: { current: string; limit: string; triggered: boolean };
    dailyTrades: { current: number; limit: number; triggered: boolean };
    consecutiveLosses: { current: number; limit: number; triggered: boolean };
  };
}

export interface TradeForRisk {
  /** 損益（正=獲利，負=虧損，0=持平） */
  pnl: number;
  /** 交易時間 */
  timestamp: number;
}

// ===== 預設值 =====

const DEFAULT_CONFIG: RiskConfig = {
  maxDailyLossPercent: -5,
  maxDrawdownPercent: -10,
  maxDailyTrades: 20,
  maxConsecutiveLosses: 5,
  initialCapital: 10000,
};

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultState(): RiskState {
  return {
    date: getToday(),
    dailyPnL: 0,
    dailyTradeCount: 0,
    consecutiveLosses: 0,
    equityPeak: DEFAULT_CONFIG.initialCapital,
    currentEquity: DEFAULT_CONFIG.initialCapital,
  };
}

// ===== 檔案讀寫 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function readRiskConfig(): RiskConfig {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) as Partial<RiskConfig> };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function readRiskState(): RiskState {
  ensureDataDir();
  if (!existsSync(STATE_FILE)) {
    const state = defaultState();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    return state;
  }
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw) as RiskState;
    // 如果跨日，自動重置當日數據
    if (state.date !== getToday()) {
      state.date = getToday();
      state.dailyPnL = 0;
      state.dailyTradeCount = 0;
      // consecutiveLosses、equityPeak、currentEquity 跨日保留
      writeRiskState(state);
    }
    return state;
  } catch {
    return defaultState();
  }
}

function writeRiskState(state: RiskState): void {
  ensureDataDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ===== 公開函式 =====

/** 檢查當前風控狀態，是否允許交易 */
export function checkRisk(): RiskCheckResult {
  const config = readRiskConfig();
  const state = readRiskState();

  // 1. 單日虧損上限
  const dailyLossLimit = config.initialCapital * (config.maxDailyLossPercent / 100);
  if (state.dailyPnL <= dailyLossLimit) {
    return {
      allowed: false,
      reason: `⛔ 單日虧損已達上限：${state.dailyPnL.toFixed(2)} USDT（上限 ${dailyLossLimit.toFixed(2)} USDT / ${config.maxDailyLossPercent}%）`,
    };
  }

  // 2. 最大回撤
  const drawdown = state.equityPeak > 0
    ? ((state.currentEquity - state.equityPeak) / state.equityPeak) * 100
    : 0;
  if (drawdown <= config.maxDrawdownPercent) {
    return {
      allowed: false,
      reason: `⛔ 最大回撤已達上限：${drawdown.toFixed(2)}%（上限 ${config.maxDrawdownPercent}%），高點 ${state.equityPeak.toFixed(2)} / 當前 ${state.currentEquity.toFixed(2)}`,
    };
  }

  // 3. 單日交易次數
  if (state.dailyTradeCount >= config.maxDailyTrades) {
    return {
      allowed: false,
      reason: `⛔ 單日交易次數已達上限：${state.dailyTradeCount} 次（上限 ${config.maxDailyTrades} 次）`,
    };
  }

  // 4. 連續虧損
  if (state.consecutiveLosses >= config.maxConsecutiveLosses) {
    return {
      allowed: false,
      reason: `⛔ 連續虧損已達上限：${state.consecutiveLosses} 次（上限 ${config.maxConsecutiveLosses} 次）`,
    };
  }

  return { allowed: true };
}

/** 記錄一筆交易到風控狀態 */
export function recordTradeForRisk(trade: TradeForRisk): void {
  const state = readRiskState();

  state.dailyTradeCount += 1;
  state.dailyPnL += trade.pnl;
  state.currentEquity += trade.pnl;

  // 更新連續虧損
  if (trade.pnl < 0) {
    state.consecutiveLosses += 1;
  } else if (trade.pnl > 0) {
    state.consecutiveLosses = 0;
  }
  // pnl === 0 不改變連續虧損計數

  // 更新權益高點
  if (state.currentEquity > state.equityPeak) {
    state.equityPeak = state.currentEquity;
  }

  writeRiskState(state);
}

/** 取得風控狀態摘要 */
export function getRiskStatus(): RiskStatus {
  const config = readRiskConfig();
  const state = readRiskState();

  const dailyLossLimit = config.initialCapital * (config.maxDailyLossPercent / 100);
  const drawdown = state.equityPeak > 0
    ? ((state.currentEquity - state.equityPeak) / state.equityPeak) * 100
    : 0;

  return {
    config,
    state,
    checks: {
      dailyLoss: {
        current: `${state.dailyPnL.toFixed(2)} USDT`,
        limit: `${dailyLossLimit.toFixed(2)} USDT (${config.maxDailyLossPercent}%)`,
        triggered: state.dailyPnL <= dailyLossLimit,
      },
      drawdown: {
        current: `${drawdown.toFixed(2)}%`,
        limit: `${config.maxDrawdownPercent}%`,
        triggered: drawdown <= config.maxDrawdownPercent,
      },
      dailyTrades: {
        current: state.dailyTradeCount,
        limit: config.maxDailyTrades,
        triggered: state.dailyTradeCount >= config.maxDailyTrades,
      },
      consecutiveLosses: {
        current: state.consecutiveLosses,
        limit: config.maxConsecutiveLosses,
        triggered: state.consecutiveLosses >= config.maxConsecutiveLosses,
      },
    },
  };
}

/** 同步初始資金與實際帳戶餘額 */
export function syncInitialCapital(actualBalance: number): void {
  const config = readRiskConfig();
  config.initialCapital = actualBalance;
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

  // 如果 risk-state 的 equityPeak / currentEquity 還是預設值 10000，一起更新
  const state = readRiskState();
  if (state.equityPeak === 10000) {
    state.equityPeak = actualBalance;
  }
  if (state.currentEquity === 10000) {
    state.currentEquity = actualBalance;
  }
  writeRiskState(state);
}

/** 手動重置當日風控 */
export function resetDailyRisk(): void {
  const state = readRiskState();
  state.date = getToday();
  state.dailyPnL = 0;
  state.dailyTradeCount = 0;
  state.consecutiveLosses = 0;
  writeRiskState(state);
}
