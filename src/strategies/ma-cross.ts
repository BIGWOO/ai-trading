/**
 * 均線交叉策略
 * 短期 MA7 上穿 MA25 → 買入（黃金交叉）
 * 短期 MA7 下穿 MA25 → 賣出（死亡交叉）
 *
 * 含部位管理：BUY 前檢查是否已持倉，SELL 時賣出完整部位
 * 分析時排除最後一根未收盤 K 線
 */

import {
  getKlines, getPrice, placeOrder, getAccountInfo,
  calculateMA, getSymbolPrecision, adjustQuantity,
} from '../binance.js';
import { recordTrade } from '../storage.js';
import { hasPosition, openPosition, closePosition } from '../position.js';
import type { Strategy, BacktestableStrategy, AnalysisResult } from './base.js';

const SHORT_PERIOD = 7;
const LONG_PERIOD = 25;
/** 每次交易使用可用餘額的比例 */
const TRADE_RATIO = 0.1;

export const maCrossStrategy: Strategy & BacktestableStrategy = {
  name: '均線交叉策略',
  description: `MA${SHORT_PERIOD} / MA${LONG_PERIOD} 交叉訊號`,

  async analyze(symbol: string): Promise<AnalysisResult> {
    // 多拉一根，排除最後未收盤的 K 線
    const klines = await getKlines(symbol, '1h', LONG_PERIOD + 6);
    // 排除最後一根未收盤 K 線
    const closedKlines = klines.slice(0, -1);
    const closePrices = closedKlines.map((k) => k.close);
    return this.analyzeKlines(closePrices, closePrices.length - 1);
  },

  analyzeKlines(closePrices: string[], index: number): AnalysisResult {
    if (index < LONG_PERIOD) {
      return { signal: 'HOLD', strength: 0, reason: '📊 數據不足，無法計算均線' };
    }

    // 取截至 index 的價格
    const prices = closePrices.slice(0, index + 1);
    const shortMA = calculateMA(prices, SHORT_PERIOD);
    const longMA = calculateMA(prices, LONG_PERIOD);

    if (shortMA.length < 2 || longMA.length < 2) {
      return { signal: 'HOLD', strength: 0, reason: '📊 均線數據不足' };
    }

    // 取最近兩根均線值，判斷交叉
    const shortCurrent = parseFloat(shortMA[shortMA.length - 1]);
    const shortPrev = parseFloat(shortMA[shortMA.length - 2]);
    const longCurrent = parseFloat(longMA[longMA.length - 1]);
    const longPrev = parseFloat(longMA[longMA.length - 2]);

    const currentPrice = closePrices[index];

    // 黃金交叉：短期均線從下方穿越長期均線
    if (shortPrev <= longPrev && shortCurrent > longCurrent) {
      const strength = Math.min((shortCurrent - longCurrent) / longCurrent * 100, 1);
      return {
        signal: 'BUY',
        strength,
        reason: `🟢 黃金交叉！MA${SHORT_PERIOD}(${shortCurrent.toFixed(2)}) 上穿 MA${LONG_PERIOD}(${longCurrent.toFixed(2)})`,
        price: currentPrice,
      };
    }

    // 死亡交叉：短期均線從上方穿越長期均線
    if (shortPrev >= longPrev && shortCurrent < longCurrent) {
      const strength = Math.min((longCurrent - shortCurrent) / longCurrent * 100, 1);
      return {
        signal: 'SELL',
        strength,
        reason: `🔴 死亡交叉！MA${SHORT_PERIOD}(${shortCurrent.toFixed(2)}) 下穿 MA${LONG_PERIOD}(${longCurrent.toFixed(2)})`,
        price: currentPrice,
      };
    }

    // 無交叉
    const diff = ((shortCurrent - longCurrent) / longCurrent * 100).toFixed(4);
    const trend = shortCurrent > longCurrent ? '多頭排列 📈' : '空頭排列 📉';
    return {
      signal: 'HOLD',
      strength: 0,
      reason: `⏸️ ${trend}，MA${SHORT_PERIOD} 與 MA${LONG_PERIOD} 差距 ${diff}%，等待交叉訊號`,
      price: currentPrice,
    };
  },

  async execute(symbol: string, result: AnalysisResult): Promise<void> {
    if (result.signal === 'HOLD') {
      console.log(`⏸️ [${this.name}] ${result.reason}`);
      return;
    }

    const priceInfo = await getPrice(symbol);
    const price = priceInfo.price;

    if (result.signal === 'BUY') {
      // 檢查是否已有部位，避免重複加碼
      if (hasPosition(this.name, symbol)) {
        console.log(`⏸️ [${this.name}] 已有 ${symbol} 部位，跳過買入`);
        return;
      }

      const account = await getAccountInfo();
      const usdtBalance = account.balances.find((b) => b.asset === 'USDT');
      const available = parseFloat(usdtBalance?.free ?? '0');
      const tradeAmount = available * TRADE_RATIO;

      // 使用 Exchange Info 調整精度
      const precision = await getSymbolPrecision(symbol);
      const rawQty = tradeAmount / parseFloat(price);
      const quantity = adjustQuantity(precision.stepSize, rawQty);

      if (parseFloat(quantity) <= 0) {
        console.log('⚠️ USDT 餘額不足，無法買入');
        return;
      }

      console.log(`🟢 [${this.name}] 買入 ${symbol}: ${quantity} @ ${price}`);
      const order = await placeOrder(symbol, 'BUY', 'MARKET', quantity, price);

      // 記錄部位
      openPosition({
        strategy: this.name,
        symbol,
        entryPrice: price,
        quantity,
        orderId: order.orderId,
      });

      await recordTrade({
        timestamp: Date.now(),
        symbol,
        side: 'BUY',
        price,
        quantity,
        strategy: this.name,
        orderId: order.orderId,
        reason: result.reason,
      });
    }

    if (result.signal === 'SELL') {
      // 取得該策略建立的部位，賣出完整數量
      const position = closePosition(this.name, symbol);
      if (!position) {
        console.log(`⏸️ [${this.name}] 沒有 ${symbol} 部位，跳過賣出`);
        return;
      }

      const quantity = position.quantity;

      console.log(`🔴 [${this.name}] 賣出 ${symbol}: ${quantity} @ ${price}（完整平倉）`);
      const order = await placeOrder(symbol, 'SELL', 'MARKET', quantity, price);

      await recordTrade({
        timestamp: Date.now(),
        symbol,
        side: 'SELL',
        price,
        quantity,
        strategy: this.name,
        orderId: order.orderId,
        reason: result.reason,
      });
    }
  },
};
