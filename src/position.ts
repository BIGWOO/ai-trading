/**
 * 部位管理模組
 * 追蹤每個策略+幣對的持倉狀態，避免重複加碼
 * 使用 data/positions.json 持久化
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const POSITIONS_FILE = join(DATA_DIR, 'positions.json');

// ===== 型別定義 =====

export interface Position {
  /** 策略名稱 */
  strategy: string;
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
}

// ===== 初始化 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(POSITIONS_FILE)) {
    writeFileSync(POSITIONS_FILE, '[]', 'utf-8');
  }
}

function readPositions(): Position[] {
  ensureDataDir();
  const raw = readFileSync(POSITIONS_FILE, 'utf-8');
  return JSON.parse(raw) as Position[];
}

function writePositions(positions: Position[]): void {
  ensureDataDir();
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2), 'utf-8');
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
  symbol: string;
  entryPrice: string;
  quantity: string;
  orderId: number;
}): void {
  const positions = readPositions();

  // 如果已有同策略同幣對的 LONG 部位，先清除
  const filtered = positions.filter(
    (p) => !(p.strategy === params.strategy && p.symbol === params.symbol.toUpperCase() && p.side === 'LONG'),
  );

  filtered.push({
    strategy: params.strategy,
    symbol: params.symbol.toUpperCase(),
    side: 'LONG',
    entryPrice: params.entryPrice,
    quantity: params.quantity,
    entryTime: Date.now(),
    orderId: params.orderId,
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
