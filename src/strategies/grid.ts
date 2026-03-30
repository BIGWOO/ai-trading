/**
 * 網格交易策略
 * 在指定價格區間內等距掛買賣單
 * 適合震盪行情
 */

import {
  getPrice, placeOrder, getOpenOrders, cancelOrder, getAccountInfo,
} from '../binance.js';
import { recordTrade } from '../storage.js';
import type { Strategy, AnalysisResult } from './base.js';

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

/** 預設網格設定（會根據當前價格自動調整） */
const DEFAULT_GRID_PERCENT = 0.05; // 上下 5% 區間
const DEFAULT_GRID_COUNT = 10;
const DEFAULT_TRADE_RATIO = 0.05; // 每格用 5% 餘額

export const gridStrategy: Strategy = {
  name: '網格交易策略',
  description: '在價格區間內等距掛買賣單，適合震盪行情',

  async analyze(symbol: string): Promise<AnalysisResult> {
    const priceInfo = await getPrice(symbol);
    const currentPrice = parseFloat(priceInfo.price);

    // 根據當前價格自動計算網格區間
    const upperPrice = currentPrice * (1 + DEFAULT_GRID_PERCENT);
    const lowerPrice = currentPrice * (1 - DEFAULT_GRID_PERCENT);
    const gridSize = (upperPrice - lowerPrice) / DEFAULT_GRID_COUNT;

    return {
      signal: 'BUY', // 網格策略總是要掛單
      strength: 0.5,
      reason: [
        `📊 網格設定：`,
        `   價格區間: ${lowerPrice.toFixed(2)} ~ ${upperPrice.toFixed(2)}`,
        `   網格數: ${DEFAULT_GRID_COUNT}`,
        `   每格間距: ${gridSize.toFixed(2)}`,
        `   當前價格: ${currentPrice.toFixed(2)}`,
      ].join('\n'),
      price: priceInfo.price,
    };
  },

  async execute(symbol: string, _result: AnalysisResult): Promise<void> {
    const priceInfo = await getPrice(symbol);
    const currentPrice = parseFloat(priceInfo.price);
    const account = await getAccountInfo();

    // 計算可用餘額和每格數量
    const usdtBalance = account.balances.find((b) => b.asset === 'USDT');
    const available = parseFloat(usdtBalance?.free ?? '0');
    const perGridAmount = available * DEFAULT_TRADE_RATIO;
    const quantityPerGrid = (perGridAmount / currentPrice).toFixed(5);

    if (parseFloat(quantityPerGrid) <= 0) {
      console.log('⚠️ USDT 餘額不足，無法建立網格');
      return;
    }

    const config: GridConfig = {
      upperPrice: currentPrice * (1 + DEFAULT_GRID_PERCENT),
      lowerPrice: currentPrice * (1 - DEFAULT_GRID_PERCENT),
      gridCount: DEFAULT_GRID_COUNT,
      quantityPerGrid,
    };

    console.log(`\n📐 [${this.name}] 建立網格...`);
    console.log(`   💰 當前價格: ${currentPrice.toFixed(2)}`);
    console.log(`   📏 區間: ${config.lowerPrice.toFixed(2)} ~ ${config.upperPrice.toFixed(2)}`);
    console.log(`   🔢 網格數: ${config.gridCount}`);
    console.log(`   📦 每格數量: ${config.quantityPerGrid}`);

    // 先取消所有現有掛單
    const openOrders = await getOpenOrders(symbol);
    if (openOrders.length > 0) {
      console.log(`\n🗑️ 取消 ${openOrders.length} 筆現有掛單...`);
      for (const order of openOrders) {
        await cancelOrder(symbol, order.orderId);
      }
    }

    // 計算每格價格
    const gridSize = (config.upperPrice - config.lowerPrice) / config.gridCount;
    let buyCount = 0;
    let sellCount = 0;

    for (let i = 0; i <= config.gridCount; i++) {
      const gridPrice = (config.lowerPrice + gridSize * i).toFixed(2);
      const gridPriceNum = parseFloat(gridPrice);

      try {
        if (gridPriceNum < currentPrice) {
          // 低於當前價格 → 掛買單
          await placeOrder(symbol, 'BUY', 'LIMIT', config.quantityPerGrid, gridPrice);
          buyCount++;
          console.log(`   🟢 買單 @ ${gridPrice}`);
        } else if (gridPriceNum > currentPrice) {
          // 高於當前價格 → 掛賣單
          await placeOrder(symbol, 'SELL', 'LIMIT', config.quantityPerGrid, gridPrice);
          sellCount++;
          console.log(`   🔴 賣單 @ ${gridPrice}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`   ⚠️ 掛單失敗 @ ${gridPrice}: ${msg}`);
      }
    }

    console.log(`\n✅ 網格建立完成！買單 ${buyCount} 筆 / 賣單 ${sellCount} 筆`);

    // 記錄網格建立
    await recordTrade({
      timestamp: Date.now(),
      symbol,
      side: 'BUY',
      price: String(currentPrice),
      quantity: '0',
      strategy: this.name,
      orderId: 0,
      reason: `建立網格：${config.lowerPrice.toFixed(2)}~${config.upperPrice.toFixed(2)}，${config.gridCount} 格`,
    });
  },
};
