/**
 * Flat Check — 確認交易已清倉
 *
 * isTradingFlat() 判斷指定 symbol 是否已完全平倉，
 * 進化系統在進行策略切換或 Mode B 回滾前必須確認 flat。
 *
 * Flat 條件（以下全部成立）：
 * 1. positions.json 無 LONG 部位（該 symbol）
 * 2. Binance 無 open orders（該 symbol）
 * 3. grid-state.json 無活躍網格（該 symbol）
 * 4. 該 symbol 的 exchange balance ≈ 0（低於 minNotional，以 USDT 計算）
 * 5. 該 symbol 不在 grid-state.json 的 touchedSymbols 中
 *
 * Fix #3 (R1-6): 讀取 grid-state.json 改用新格式 { entries, touchedSymbols }
 * Fix #7 (R1-11): 條件 4 改用 notional（qty × price）和 MIN_NOTIONAL_USDT 比較
 * Fix #13: 無 symbol 時，掃描交易所所有非穩定幣資產，若有 notional > threshold 就不 flat
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOpenOrders, getAccountInfo, getPrice, extractBaseAsset } from '../binance.js';
import { getAllPositions } from '../position.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const GRID_STATE_FILE = join(DATA_DIR, 'grid-state.json');

/** 視為「有餘額」的最低名義價值（USDT），低於此值視為 ≈ 0 */
const MIN_NOTIONAL_USDT = 1.0;

/** 穩定幣清單（不視為持倉） */
const STABLECOINS = new Set(['USDT', 'BUSD', 'USDC', 'DAI', 'TUSD', 'FDUSD']);

// ===== 型別定義 =====

export interface FlatCheckResult {
  /** 是否完全平倉 */
  isFlat: boolean;
  /** 阻礙平倉的條件清單（empty = isFlat=true） */
  blockers: string[];
}

interface GridEntry {
  symbol: string;
  active: boolean;
}

interface GridStateFile {
  entries: GridEntry[];
  touchedSymbols: string[];
}

// ===== 內部工具 =====

/** Fix #3: 讀取新格式 grid-state.json（{ entries, touchedSymbols }），相容舊格式純 array */
function readGridStateFile(): GridStateFile {
  if (!existsSync(GRID_STATE_FILE)) return { entries: [], touchedSymbols: [] };
  try {
    const raw = readFileSync(GRID_STATE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      // 舊格式純 array，自動遷移
      return { entries: data as GridEntry[], touchedSymbols: [] };
    }
    const stateFile = data as Partial<GridStateFile>;
    return {
      entries: stateFile.entries ?? [],
      touchedSymbols: stateFile.touchedSymbols ?? [],
    };
  } catch {
    return { entries: [], touchedSymbols: [] };
  }
}

// ===== 公開 API =====

/**
 * 檢查指定 symbol 是否已完全平倉
 *
 * @param symbol - 交易對（如 'ETCUSDT'），若不傳則檢查所有 symbol
 * @returns FlatCheckResult
 */
export async function isTradingFlat(symbol?: string): Promise<FlatCheckResult> {
  const blockers: string[] = [];
  const upperSymbol = symbol?.toUpperCase();

  // 條件 1：positions.json 無 LONG 部位
  const allPositions = getAllPositions();
  const activePositions = upperSymbol
    ? allPositions.filter((p) => p.symbol === upperSymbol)
    : allPositions;

  if (activePositions.length > 0) {
    const posStr = activePositions.map((p) => `${p.strategy}/${p.symbol}`).join(', ');
    blockers.push(`⛔ 有活躍部位：${posStr}`);
  }

  // 條件 2：Binance 無 open orders
  try {
    const openOrders = await getOpenOrders(upperSymbol ?? '');
    if (openOrders.length > 0) {
      blockers.push(`⛔ Binance 有 ${openOrders.length} 筆未成交訂單`);
    }
  } catch (err) {
    blockers.push(`⛔ 無法確認 Binance 掛單狀態：${err instanceof Error ? err.message : String(err)}`);
  }

  // 條件 3：grid-state.json 無活躍網格（Fix #3: 用新格式）
  const { entries: gridEntries, touchedSymbols } = readGridStateFile();
  const activeGrids = upperSymbol
    ? gridEntries.filter((g) => g.active && g.symbol === upperSymbol)
    : gridEntries.filter((g) => g.active);

  if (activeGrids.length > 0) {
    const gridStr = activeGrids.map((g) => g.symbol).join(', ');
    blockers.push(`⛔ 有活躍網格：${gridStr}`);
  }

  // 條件 4：exchange balance ≈ 0（Fix #7: 用 notional = qty × price 比較 MIN_NOTIONAL_USDT）
  if (upperSymbol) {
    try {
      const account = await getAccountInfo();
      const baseAsset = extractBaseAsset(upperSymbol);
      const balance = account.balances.find((b) => b.asset === baseAsset);
      if (balance) {
        const total = parseFloat(balance.free) + parseFloat(balance.locked);
        if (total > 0) {
          // 取得即時價格計算 notional
          try {
            const priceInfo = await getPrice(upperSymbol);
            const price = parseFloat(priceInfo.price);
            const notional = total * price;
            if (notional > MIN_NOTIONAL_USDT) {
              blockers.push(`⛔ ${baseAsset} 餘額尚存：${total}（名義價值 ${notional.toFixed(2)} USDT > ${MIN_NOTIONAL_USDT} USDT）`);
            }
          } catch {
            // 若取不到價格，fallback 到保守判斷
            if (total > 0.0001) {
              blockers.push(`⛔ ${baseAsset} 餘額尚存：${total}（無法取得價格，保守判斷）`);
            }
          }
        }
      }
    } catch (err) {
      blockers.push(`⛔ 無法確認交易所餘額：${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // Fix #13: 無 symbol 時，掃描所有非穩定幣資產
    try {
      const account = await getAccountInfo();
      const nonStableBalances = account.balances.filter(
        (b) => !STABLECOINS.has(b.asset) && (parseFloat(b.free) + parseFloat(b.locked)) > 0,
      );

      for (const balance of nonStableBalances) {
        const total = parseFloat(balance.free) + parseFloat(balance.locked);
        // 嘗試用 XXXUSDT 取得價格
        const pairSymbol = `${balance.asset}USDT`;
        try {
          const priceInfo = await getPrice(pairSymbol);
          const price = parseFloat(priceInfo.price);
          const notional = total * price;
          if (notional > MIN_NOTIONAL_USDT) {
            blockers.push(`⛔ ${balance.asset} 餘額尚存：${total}（名義價值 ${notional.toFixed(2)} USDT > ${MIN_NOTIONAL_USDT} USDT）`);
          }
        } catch {
          // 無法取得價格（可能不是 USDT 交易對），若有任何餘額就保守視為有持倉
          if (total > 0.0001) {
            blockers.push(`⛔ ${balance.asset} 餘額尚存：${total}（無法取得 ${pairSymbol} 價格，保守判斷）`);
          }
        }
      }
    } catch (err) {
      blockers.push(`⛔ 無法確認交易所帳戶餘額：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 條件 5：symbol 不在 grid-state.touchedSymbols（Fix #3: 直接使用已讀出的 touchedSymbols）
  if (upperSymbol && touchedSymbols.includes(upperSymbol)) {
    blockers.push(`⛔ ${upperSymbol} 在 grid-state.touchedSymbols 中（Grid 曾操作過此 symbol）`);
  } else if (!upperSymbol && touchedSymbols.length > 0) {
    blockers.push(`⛔ grid-state.touchedSymbols 非空：${touchedSymbols.join(', ')}`);
  }

  return {
    isFlat: blockers.length === 0,
    blockers,
  };
}
