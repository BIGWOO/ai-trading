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
  calculateMA, getSymbolPrecision, adjustQuantity, getAvgFillPrice,
  getNetQuantity, getTotalCommission, extractBaseAsset,
} from '../binance.js';
import { recordTrade } from '../storage.js';
import { hasPosition, openPosition, closePosition, getPosition } from '../position.js';
import type { Strategy, BacktestableStrategy, AnalysisResult, StrategyResult } from './base.js';
import { getStrategyConfig } from '../strategy-config.js';

export const maCrossStrategy: Strategy & BacktestableStrategy = {
  name: '均線交叉策略',
  get description() {
    const cfg = getStrategyConfig('ma-cross');
    return `MA${cfg.shortPeriod} / MA${cfg.longPeriod} 交叉訊號`;
  },

  async analyze(symbol: string): Promise<AnalysisResult> {
    const cfg = getStrategyConfig('ma-cross');
    // 多拉一根，排除最後未收盤的 K 線
    const klines = await getKlines(symbol, '1h', cfg.longPeriod + 6);
    // 排除最後一根未收盤 K 線
    const closedKlines = klines.slice(0, -1);
    const closePrices = closedKlines.map((k) => k.close);
    return this.analyzeKlines(closePrices, closePrices.length - 1);
  },

  analyzeKlines(closePrices: string[], index: number, overrides?: Partial<{ shortPeriod: number; longPeriod: number }>): AnalysisResult {
    const baseCfg = getStrategyConfig('ma-cross');
    const SHORT_PERIOD = overrides?.shortPeriod ?? baseCfg.shortPeriod;
    const LONG_PERIOD = overrides?.longPeriod ?? baseCfg.longPeriod;

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

  async execute(symbol: string, result: AnalysisResult): Promise<StrategyResult> {
    if (result.signal === 'HOLD') {
      console.log(`⏸️ [${this.name}] ${result.reason}`);
      return {
        action: 'HOLD',
        symbol,
        strategy: this.name,
        reason: result.reason,
        timestamp: Date.now(),
      };
    }

    const priceInfo = await getPrice(symbol);
    const price = priceInfo.price;

    if (result.signal === 'BUY') {
      // 檢查是否已有部位，避免重複加碼
      if (hasPosition(this.name, symbol)) {
        console.log(`⏸️ [${this.name}] 已有 ${symbol} 部位，跳過買入`);
        return {
          action: 'HOLD',
          symbol,
          strategy: this.name,
          reason: `已有 ${symbol} 部位，跳過買入`,
          timestamp: Date.now(),
        };
      }

      const { tradeRatio } = getStrategyConfig('ma-cross');
      const account = await getAccountInfo();
      const usdtBalance = account.balances.find((b) => b.asset === 'USDT');
      const available = parseFloat(usdtBalance?.free ?? '0');
      const tradeAmount = available * tradeRatio;

      // 使用 Exchange Info 調整精度
      const precision = await getSymbolPrecision(symbol);
      const rawQty = tradeAmount / parseFloat(price);
      const quantity = adjustQuantity(precision.stepSize, rawQty);

      if (parseFloat(quantity) <= 0) {
        console.log('⚠️ USDT 餘額不足，無法買入');
        return {
          action: 'HOLD',
          symbol,
          strategy: this.name,
          reason: 'USDT 餘額不足，無法買入',
          timestamp: Date.now(),
        };
      }

      console.log(`🟢 [${this.name}] 買入 ${symbol}: ${quantity} @ ~${price}`);
      const order = await placeOrder(symbol, 'BUY', 'MARKET', quantity, price);

      // 使用實際成交數據（非下單前的 ticker 價格）
      const actualPrice = getAvgFillPrice(order);
      // 扣除手續費後的淨數量（Binance 可能從基礎幣扣手續費）
      const baseAsset = extractBaseAsset(symbol);
      const netQty = getNetQuantity(order, baseAsset);

      // 記錄部位（用扣手續費後的淨數量）
      openPosition({
        strategy: this.name,
        symbol,
        entryPrice: actualPrice,
        quantity: netQty,
        orderId: order.orderId,
      });

      await recordTrade({
        timestamp: Date.now(),
        symbol,
        side: 'BUY',
        price: actualPrice,
        quantity: netQty,
        strategy: this.name,
        orderId: order.orderId,
        reason: result.reason,
      });

      return {
        action: 'BUY',
        symbol,
        strategy: this.name,
        price: actualPrice,
        quantity: netQty,
        orderId: order.orderId,
        reason: result.reason,
        timestamp: Date.now(),
      };
    }

    if (result.signal === 'SELL') {
      // 先查部位（不刪除），確認下單成功後才 close
      const position = getPosition(this.name, symbol);
      if (!position) {
        console.log(`⏸️ [${this.name}] 沒有 ${symbol} 部位，跳過賣出`);
        return {
          action: 'HOLD',
          symbol,
          strategy: this.name,
          reason: `沒有 ${symbol} 部位，跳過賣出`,
          timestamp: Date.now(),
        };
      }

      // 使用 position 記錄的 quantity（已扣 BUY 手續費）
      const quantity = position.quantity;

      console.log(`🔴 [${this.name}] 賣出 ${symbol}: ${quantity} @ ~${price}（完整平倉）`);
      const order = await placeOrder(symbol, 'SELL', 'MARKET', quantity, price);

      // 使用實際成交數據
      const actualPrice = getAvgFillPrice(order);
      const actualQty = order.executedQty;

      // 計算 PnL（扣 SELL 側手續費）
      const sellCommission = getTotalCommission(order);
      const sellCommissionUsdt = sellCommission.asset === 'USDT'
        ? sellCommission.amount
        : parseFloat(actualPrice) * sellCommission.amount;
      const grossPnl = (parseFloat(actualPrice) - parseFloat(position.entryPrice)) * parseFloat(actualQty);
      const pnl = grossPnl - sellCommissionUsdt;

      // 下單成功後才關閉本地部位
      closePosition(this.name, symbol);

      await recordTrade({
        timestamp: Date.now(),
        symbol,
        side: 'SELL',
        price: actualPrice,
        quantity: actualQty,
        strategy: this.name,
        orderId: order.orderId,
        reason: result.reason,
      });

      return {
        action: 'SELL',
        symbol,
        strategy: this.name,
        price: actualPrice,
        quantity: actualQty,
        orderId: order.orderId,
        reason: result.reason,
        timestamp: Date.now(),
        pnl,
      };
    }

    // fallback（理論上不會到這裡）
    return {
      action: 'HOLD',
      symbol,
      strategy: this.name,
      reason: result.reason,
      timestamp: Date.now(),
    };
  },
};
