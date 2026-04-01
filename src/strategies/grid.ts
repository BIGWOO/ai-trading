/**
 * 網格交易策略
 * 在指定價格區間內等距掛買賣單
 * 適合震盪行情
 *
 * 含狀態持久化：不會每次都 destructive reset
 * 執行前檢查是否已有活躍網格，只補缺失的單
 *
 * Fix #6: grid-state.json 格式改為 { entries: GridEntry[], touchedSymbols: string[] }
 * Fix #8: 非 fill 的結果改用 eventType: 'order_submitted'
 * Fix #12: 移除未使用的 recordTrade import
 */

import {
  getPrice, placeOrder, getOpenOrders, cancelOrder, getAccountInfo,
  getSymbolPrecision, adjustQuantity, adjustPrice,
} from '../binance.js';
import type { Strategy, AnalysisResult, StrategyResult } from './base.js';
import type { ExecutionContext } from '../execution-context.js';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { atomicWriteJson } from '../utils/atomic-write.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStrategyConfig } from '../strategy-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const GRID_STATE_FILE = join(DATA_DIR, 'grid-state.json');

interface GridConfig {
  /** 價格上限 */
  upperPrice: number;
  /** 價格下限 */
  lowerPrice: number;
  /** 網格數量 */
  gridCount: number;
  /** 每格交易數量 */
  quantityPerGrid: string;
}

/** Fix #6: 單一網格條目型別 */
export interface GridEntry {
  /** 交易對 */
  symbol: string;
  /** 建立時間 */
  createdAt: number;
  /** 價格上限 */
  upperPrice: number;
  /** 價格下限 */
  lowerPrice: number;
  /** 網格數量 */
  gridCount: number;
  /** 每格數量 */
  quantityPerGrid: string;
  /** 網格價格列表 */
  gridPrices: string[];
  /** 是否活躍 */
  active: boolean;
}

/** Fix #6: grid-state.json 的完整結構 */
interface GridStateFile {
  entries: GridEntry[];
  touchedSymbols: string[];
}

// 保留舊型別名稱作別名（向後相容）
type GridState = GridEntry;

// 預設值已移至 strategy-config.ts，此處透過 getStrategyConfig('grid') 動態取得

// ===== 網格狀態管理 =====

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 讀取 grid-state.json，自動遷移舊格式（純 array）
 * Fix #6: 若讀到純 array，包成 { entries: array, touchedSymbols: [] }
 */
function readGridStateFile(): GridStateFile {
  ensureDataDir();
  if (!existsSync(GRID_STATE_FILE)) {
    return { entries: [], touchedSymbols: [] };
  }
  try {
    const raw = readFileSync(GRID_STATE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      // 舊格式：純 array，自動遷移
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

function writeGridStateFile(stateFile: GridStateFile): void {
  ensureDataDir();
  atomicWriteJson(GRID_STATE_FILE, stateFile);
}

function readGridState(symbol: string): GridState | null {
  const { entries } = readGridStateFile();
  return entries.find((s) => s.symbol === symbol.toUpperCase() && s.active) ?? null;
}

function writeGridState(state: GridState): void {
  const stateFile = readGridStateFile();

  // 替換同幣對的活躍狀態
  stateFile.entries = stateFile.entries.filter(
    (s) => !(s.symbol === state.symbol && s.active),
  );
  stateFile.entries.push(state);

  // 記錄 touchedSymbols（Fix #6）
  if (!stateFile.touchedSymbols.includes(state.symbol)) {
    stateFile.touchedSymbols.push(state.symbol);
  }

  writeGridStateFile(stateFile);
}

function deactivateGridState(symbol: string): void {
  ensureDataDir();
  if (!existsSync(GRID_STATE_FILE)) return;
  try {
    const stateFile = readGridStateFile();
    for (const s of stateFile.entries) {
      if (s.symbol === symbol.toUpperCase() && s.active) {
        s.active = false;
      }
    }
    writeGridStateFile(stateFile);
  } catch {
    // 忽略
  }
}

export const gridStrategy: Strategy = {
  id: 'grid' as const,
  name: '網格交易策略',
  description: '在價格區間內等距掛買賣單，適合震盪行情',

  async analyze(symbol: string, ctx?: ExecutionContext): Promise<AnalysisResult> {
    // Fix #1: 優先從 ctx.strategyConfig 讀取，fallback 到 getStrategyConfig
    const baseCfg = getStrategyConfig('grid');
    const cfg = ctx?.strategyConfig && Object.keys(ctx.strategyConfig).length > 0
      ? {
          gridPercent: (ctx.strategyConfig['gridPercent'] as number | undefined) ?? baseCfg.gridPercent,
          gridCount: (ctx.strategyConfig['gridCount'] as number | undefined) ?? baseCfg.gridCount,
          tradeRatio: (ctx.strategyConfig['tradeRatio'] as number | undefined) ?? baseCfg.tradeRatio,
        }
      : baseCfg;
    const priceInfo = await getPrice(symbol);
    const currentPrice = parseFloat(priceInfo.price);

    // 檢查是否已有活躍網格
    const existingGrid = readGridState(symbol);
    if (existingGrid) {
      return {
        signal: 'BUY', // 表示要管理網格
        strength: 0.3,
        reason: [
          `📊 發現既有網格：`,
          `   價格區間: ${existingGrid.lowerPrice.toFixed(2)} ~ ${existingGrid.upperPrice.toFixed(2)}`,
          `   網格數: ${existingGrid.gridCount}`,
          `   每格數量: ${existingGrid.quantityPerGrid}`,
          `   當前價格: ${currentPrice.toFixed(2)}`,
          `   模式: 補單（不重建）`,
        ].join('\n'),
        price: priceInfo.price,
      };
    }

    // 根據當前價格自動計算網格區間
    const upperPrice = currentPrice * (1 + cfg.gridPercent);
    const lowerPrice = currentPrice * (1 - cfg.gridPercent);
    const gridSize = (upperPrice - lowerPrice) / cfg.gridCount;

    return {
      signal: 'BUY', // 網格策略總是要掛單
      strength: 0.5,
      reason: [
        `📊 網格設定：`,
        `   價格區間: ${lowerPrice.toFixed(2)} ~ ${upperPrice.toFixed(2)}`,
        `   網格數: ${cfg.gridCount}`,
        `   每格間距: ${gridSize.toFixed(2)}`,
        `   當前價格: ${currentPrice.toFixed(2)}`,
        `   模式: 新建`,
      ].join('\n'),
      price: priceInfo.price,
    };
  },

  async execute(symbol: string, _result: AnalysisResult, ctx?: ExecutionContext): Promise<StrategyResult[]> {
    // Fix #1: 優先從 ctx.strategyConfig 讀取，fallback 到 getStrategyConfig
    const baseCfg = getStrategyConfig('grid');
    const cfg = ctx?.strategyConfig && Object.keys(ctx.strategyConfig).length > 0
      ? {
          gridPercent: (ctx.strategyConfig['gridPercent'] as number | undefined) ?? baseCfg.gridPercent,
          gridCount: (ctx.strategyConfig['gridCount'] as number | undefined) ?? baseCfg.gridCount,
          tradeRatio: (ctx.strategyConfig['tradeRatio'] as number | undefined) ?? baseCfg.tradeRatio,
        }
      : baseCfg;
    const upperSymbol = symbol.toUpperCase();

    const priceInfo = await getPrice(symbol);
    const currentPrice = parseFloat(priceInfo.price);
    const account = await getAccountInfo();

    // 取得精度資訊
    const precision = await getSymbolPrecision(upperSymbol);

    // 計算可用餘額和每格數量
    const usdtBalance = account.balances.find((b) => b.asset === 'USDT');
    const available = parseFloat(usdtBalance?.free ?? '0');
    const perGridAmount = available * cfg.tradeRatio;
    const rawQty = perGridAmount / currentPrice;
    const quantityPerGrid = adjustQuantity(precision.stepSize, rawQty);

    if (parseFloat(quantityPerGrid) <= 0) {
      console.log('⚠️ USDT 餘額不足，無法建立網格');
      return [{
        action: 'HOLD',
        eventType: 'order_submitted',
        symbol: upperSymbol,
        strategy: this.name,
        strategyId: this.id,
        reason: 'USDT 餘額不足，無法建立網格',
        timestamp: Date.now(),
        configVersion: ctx?.configVersion,
      }];
    }

    // 檢查是否有既有活躍網格
    const existingGrid = readGridState(upperSymbol);
    const openOrders = await getOpenOrders(upperSymbol);

    if (existingGrid) {
      // 補單模式：檢查缺失的格位
      console.log(`\n📐 [${this.name}] 補單模式...`);
      console.log(`   💰 當前價格: ${currentPrice.toFixed(2)}`);

      // 正規化價格字串，避免 "69239.31" vs "69239.31000000" 比對失敗
      const normalizePrice = (p: string) => parseFloat(p).toString();
      const existingPrices = new Set(openOrders.map((o) => normalizePrice(o.price)));
      let addedCount = 0;
      let failedCount = 0;
      let addedBuy = 0;
      let addedSell = 0;

      for (const gridPrice of existingGrid.gridPrices) {
        if (existingPrices.has(normalizePrice(gridPrice))) continue; // 已有此價位的單

        const gridPriceNum = parseFloat(gridPrice);
        try {
          if (gridPriceNum < currentPrice) {
            await placeOrder(upperSymbol, 'BUY', 'LIMIT', existingGrid.quantityPerGrid, gridPrice);
            addedCount++;
            addedBuy++;
            console.log(`   🟢 補買單 @ ${gridPrice}`);
          } else if (gridPriceNum > currentPrice) {
            await placeOrder(upperSymbol, 'SELL', 'LIMIT', existingGrid.quantityPerGrid, gridPrice);
            addedCount++;
            addedSell++;
            console.log(`   🔴 補賣單 @ ${gridPrice}`);
          }
        } catch (err) {
          failedCount++;
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`   ⚠️ 補單失敗 @ ${gridPrice}: ${msg}`);
        }
      }

      // 判斷回傳 action
      let replenishAction: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      if (addedBuy > 0 && addedSell === 0) replenishAction = 'BUY';
      else if (addedSell > 0 && addedBuy === 0) replenishAction = 'SELL';

      console.log(`\n✅ 補單完成！成功 ${addedCount} 筆${failedCount > 0 ? `，失敗 ${failedCount} 筆` : ''}`);
      return [{
        action: replenishAction,
        eventType: 'order_submitted',
        symbol: upperSymbol,
        strategy: this.name,
        strategyId: this.id,
        reason: `網格補單完成，成功 ${addedCount} 筆${failedCount > 0 ? `，失敗 ${failedCount} 筆` : ''}`,
        timestamp: Date.now(),
        configVersion: ctx?.configVersion,
      }];
    }

    // 新建模式
    const config: GridConfig = {
      upperPrice: currentPrice * (1 + cfg.gridPercent),
      lowerPrice: currentPrice * (1 - cfg.gridPercent),
      gridCount: cfg.gridCount,
      quantityPerGrid,
    };

    console.log(`\n📐 [${this.name}] 建立新網格...`);
    console.log(`   💰 當前價格: ${currentPrice.toFixed(2)}`);
    console.log(`   📏 區間: ${config.lowerPrice.toFixed(2)} ~ ${config.upperPrice.toFixed(2)}`);
    console.log(`   🔢 網格數: ${config.gridCount}`);
    console.log(`   📦 每格數量: ${config.quantityPerGrid}`);

    // 如果交易所有掛單但本地沒 state，必須全部取消才能建新格
    if (openOrders.length > 0) {
      console.log(`\n⚠️ 發現 ${openOrders.length} 筆既有掛單，需先全部取消`);
      let cancelFailed = 0;
      for (const order of openOrders) {
        try {
          await cancelOrder(upperSymbol, order.orderId);
          console.log(`   🗑️ 已取消 ID:${order.orderId}`);
        } catch (err) {
          cancelFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`   ❌ 取消失敗 ID:${order.orderId}: ${msg}`);
        }
      }
      deactivateGridState(upperSymbol);

      // 如果有任何取消失敗，中止建新格（避免舊新重疊放大曝險）
      if (cancelFailed > 0) {
        console.log(`\n❌ ${cancelFailed} 筆掛單取消失敗，為避免重疊曝險，中止建立新網格`);
        console.log(`   請手動到 Binance 確認並取消殘留掛單後重新執行`);
        return [{
          action: 'HOLD',
          eventType: 'order_submitted',
          symbol: upperSymbol,
          strategy: this.name,
          strategyId: this.id,
          reason: `${cancelFailed} 筆掛單取消失敗，中止建立新網格`,
          timestamp: Date.now(),
          configVersion: ctx?.configVersion,
        }];
      }
    }

    // 計算每格價格
    const gridSize = (config.upperPrice - config.lowerPrice) / config.gridCount;
    let buyCount = 0;
    let sellCount = 0;
    const gridPrices: string[] = [];

    for (let i = 0; i <= config.gridCount; i++) {
      const rawPrice = config.lowerPrice + gridSize * i;
      const gridPrice = adjustPrice(precision.tickSize, rawPrice);
      const gridPriceNum = parseFloat(gridPrice);
      gridPrices.push(gridPrice);

      try {
        if (gridPriceNum < currentPrice) {
          await placeOrder(upperSymbol, 'BUY', 'LIMIT', config.quantityPerGrid, gridPrice);
          buyCount++;
          console.log(`   🟢 買單 @ ${gridPrice}`);
        } else if (gridPriceNum > currentPrice) {
          await placeOrder(upperSymbol, 'SELL', 'LIMIT', config.quantityPerGrid, gridPrice);
          sellCount++;
          console.log(`   🔴 賣單 @ ${gridPrice}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`   ⚠️ 掛單失敗 @ ${gridPrice}: ${msg}`);
      }
    }

    // 儲存網格狀態
    writeGridState({
      symbol: upperSymbol,
      createdAt: Date.now(),
      upperPrice: config.upperPrice,
      lowerPrice: config.lowerPrice,
      gridCount: config.gridCount,
      quantityPerGrid: config.quantityPerGrid,
      gridPrices,
      active: true,
    });

    console.log(`\n✅ 網格建立完成！買單 ${buyCount} 筆 / 賣單 ${sellCount} 筆`);

    // 網格掛單不寫入 trades.json（掛單 ≠ 成交，避免污染績效計算）
    // 實際成交會由 Binance 端追蹤，未來可透過 getTradeHistory 同步

    // Fix #5 (R1-8): 掛單不等於成交，使用 order_submitted
    return [{
      action: 'BUY',
      eventType: 'order_submitted',
      symbol: upperSymbol,
      strategy: this.name,
      strategyId: this.id,
      reason: `網格建立完成！買單 ${buyCount} 筆 / 賣單 ${sellCount} 筆`,
      timestamp: Date.now(),
      configVersion: ctx?.configVersion,
    }];
  },
};
