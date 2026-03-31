/**
 * 部位管理模組
 * 追蹤每個策略+幣對的持倉狀態，避免重複加碼
 * 使用 data/positions.json 持久化
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { atomicWriteJson } from './utils/atomic-write.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const POSITIONS_FILE = join(DATA_DIR, 'positions.json');

// ===== 型別定義 =====

export interface Position {
  /** 策略名稱 */
  strategy: string;
  /** 策略 ID（機器識別用） */
  strategyId?: string;
  /** 交易對 */
  symbol: string;
  /** 方向 */
  side: 'LONG' | 'NONE';
  /** 進場價格 */
  entryPrice: string;
  /** 持有數量 */
  quantity: string;
  /** 進場時間（毫秒） */
  entryTime: number;
  /** 訂單 ID */
  orderId: number;
  /** 設定版本號 */
  configVersion?: number;
}

// ===== 策略 ID 解析 =====

/** name→id fallback mapping（用於舊資料遷移） */
const ID_MAP: Record<string, string> = {
  '均線交叉策略': 'ma-cross',
  'RSI 策略': 'rsi',
  '網格交易策略': 'grid',
};

/** 解析 strategyId，優先用 strategyId 欄位，fallback 到 name mapping */
export function resolveStrategyId(record: { strategy: string; strategyId?: string }): string {
  return record.strategyId ?? ID_MAP[record.strategy] ?? record.strategy;
}

// ===== 初始化 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(POSITIONS_FILE)) {
    atomicWriteJson(POSITIONS_FILE, []);
  }
}

function readPositions(): Position[] {
  ensureDataDir();
  const raw = readFileSync(POSITIONS_FILE, 'utf-8');
  return JSON.parse(raw) as Position[];
}

function writePositions(positions: Position[]): void {
  ensureDataDir();
  atomicWriteJson(POSITIONS_FILE, positions);
}

// ===== 公開函式 =====

/** 取得指定策略+幣對的部位 */
export function getPosition(strategy: string, symbol: string): Position | null {
  const positions = readPositions();
  const pos = positions.find(
    (p) => p.strategy === strategy && p.symbol === symbol.toUpperCase() && p.side === 'LONG',
  );
  return pos ?? null;
}

/** 檢查是否已有 LONG 部位 */
export function hasPosition(strategy: string, symbol: string): boolean {
  return getPosition(strategy, symbol) !== null;
}

/** 開倉：記錄新部位 */
export function openPosition(params: {
  strategy: string;
  strategyId?: string;
  symbol: string;
  entryPrice: string;
  quantity: string;
  orderId: number;
  configVersion?: number;
}): void {
  const positions = readPositions();

  // 如果已有同策略同幣對的 LONG 部位，先清除
  const filtered = positions.filter(
    (p) => !(p.strategy === params.strategy && p.symbol === params.symbol.toUpperCase() && p.side === 'LONG'),
  );

  filtered.push({
    strategy: params.strategy,
    strategyId: params.strategyId,
    symbol: params.symbol.toUpperCase(),
    side: 'LONG',
    entryPrice: params.entryPrice,
    quantity: params.quantity,
    entryTime: Date.now(),
    orderId: params.orderId,
    configVersion: params.configVersion,
  });

  writePositions(filtered);
  console.log(`📂 部位已開倉：${params.strategy} ${params.symbol} ${params.quantity} @ ${params.entryPrice}`);
}

/** 平倉：移除部位 */
export function closePosition(strategy: string, symbol: string): Position | null {
  const positions = readPositions();
  const pos = positions.find(
    (p) => p.strategy === strategy && p.symbol === symbol.toUpperCase() && p.side === 'LONG',
  );

  if (!pos) return null;

  const filtered = positions.filter(
    (p) => !(p.strategy === strategy && p.symbol === symbol.toUpperCase() && p.side === 'LONG'),
  );

  writePositions(filtered);
  console.log(`📂 部位已平倉：${strategy} ${symbol}`);
  return pos;
}

/** 列出所有部位 */
export function getAllPositions(): Position[] {
  return readPositions().filter((p) => p.side === 'LONG');
}

/**
 * 縮減持倉量（partial SELL 用）
 * 當實際成交量 < 持倉量時，減少持倉量而非完全平倉。
 *
 * @param strategy - 策略名稱
 * @param symbol - 交易對
 * @param soldQty - 已賣出的數量（字串，Binance API 格式）
 * @returns 更新後的部位，若無部位則返回 null
 */
export function shrinkPosition(strategy: string, symbol: string, soldQty: string): Position | null {
  const positions = readPositions();
  const idx = positions.findIndex(
    (p) => p.strategy === strategy && p.symbol === symbol.toUpperCase() && p.side === 'LONG',
  );

  if (idx === -1) return null;

  const pos = positions[idx];
  const newQty = parseFloat(pos.quantity) - parseFloat(soldQty);

  if (newQty <= 0) {
    // 數量歸零，直接平倉
    positions.splice(idx, 1);
    writePositions(positions);
    console.log(`📂 部位已完全平倉（shrink）：${strategy} ${symbol}`);
    return null;
  }

  positions[idx] = { ...pos, quantity: newQty.toString() };
  writePositions(positions);
  console.log(`📂 部位已縮減：${strategy} ${symbol} ${pos.quantity} → ${newQty.toString()}`);
  return positions[idx];
}

/**
 * Fix #14: 補填 positions.json 中缺少 strategyId 的記錄
 * 只跑一次：若所有記錄都有 strategyId 則直接返回
 */
export function migratePositions(): void {
  const positions = readPositions();
  const needsMigration = positions.some((p) => !p.strategyId);
  if (!needsMigration) return;

  let changed = 0;
  for (const pos of positions) {
    if (!pos.strategyId) {
      pos.strategyId = ID_MAP[pos.strategy] ?? pos.strategy;
      changed++;
    }
  }

  if (changed > 0) {
    writePositions(positions);
    console.log(`📦 positions.json 遷移：補填 ${changed} 筆 strategyId`);
  }
}
