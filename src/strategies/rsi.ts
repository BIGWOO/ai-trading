/**
 * RSI 策略
 * RSI < 30 → 超賣，買入
 * RSI > 70 → 超買，賣出
 */

import {
  getKlines, getPrice, placeOrder, getAccountInfo,
  calculateRSI,
} from '../binance.js';
import { recordTrade } from '../storage.js';
import type { Strategy, BacktestableStrategy, AnalysisResult } from './base.js';

const RSI_PERIOD = 14;
const OVERSOLD = 30;
const OVERBOUGHT = 70;
const TRADE_RATIO = 0.1;

export const rsiStrategy: Strategy & BacktestableStrategy = {
  name: 'RSI 策略',
  description: `RSI(${RSI_PERIOD}) 超買超賣訊號`,

  async analyze(symbol: string): Promise<AnalysisResult> {
    const klines = await getKlines(symbol, '1h', RSI_PERIOD + 20);
    const closePrices = klines.map((k) => k.close);
    return this.analyzeKlines(closePrices, closePrices.length - 1);
  },

  analyzeKlines(closePrices: string[], index: number): AnalysisResult {
    if (index < RSI_PERIOD + 1) {
      return { signal: 'HOLD', strength: 0, reason: '📊 數據不足，無法計算 RSI' };
    }

    const prices = closePrices.slice(0, index + 1);
    const rsiValues = calculateRSI(prices, RSI_PERIOD);

    if (rsiValues.length === 0) {
      return { signal: 'HOLD', strength: 0, reason: '📊 RSI 數據不足' };
    }

    const currentRSI = parseFloat(rsiValues[rsiValues.length - 1]);
    const currentPrice = closePrices[index];

    if (currentRSI < OVERSOLD) {
      const strength = Math.min((OVERSOLD - currentRSI) / OVERSOLD, 1);
      return {
        signal: 'BUY',
        strength,
        reason: `🟢 RSI = ${currentRSI.toFixed(2)}（超賣區 < ${OVERSOLD}），建議買入`,
        price: currentPrice,
      };
    }

    if (currentRSI > OVERBOUGHT) {
      const strength = Math.min((currentRSI - OVERBOUGHT) / (100 - OVERBOUGHT), 1);
      return {
        signal: 'SELL',
        strength,
        reason: `🔴 RSI = ${currentRSI.toFixed(2)}（超買區 > ${OVERBOUGHT}），建議賣出`,
        price: currentPrice,
      };
    }

    return {
      signal: 'HOLD',
      strength: 0,
      reason: `⏸️ RSI = ${currentRSI.toFixed(2)}（中性區 ${OVERSOLD}~${OVERBOUGHT}），觀望`,
      price: currentPrice,
    };
  },

  async execute(symbol: string, result: AnalysisResult): Promise<void> {
    if (result.signal === 'HOLD') {
      console.log(`⏸️ [${this.name}] ${result.reason}`);
      return;
    }

    const account = await getAccountInfo();
    const priceInfo = await getPrice(symbol);
    const price = priceInfo.price;

    if (result.signal === 'BUY') {
      const usdtBalance = account.balances.find((b) => b.asset === 'USDT');
      const available = parseFloat(usdtBalance?.free ?? '0');
      const tradeAmount = available * TRADE_RATIO;
      const quantity = (tradeAmount / parseFloat(price)).toFixed(5);

      if (parseFloat(quantity) <= 0) {
        console.log('⚠️ USDT 餘額不足，無法買入');
        return;
      }

      console.log(`🟢 [${this.name}] 買入 ${symbol}: ${quantity} @ ${price}`);
      const order = await placeOrder(symbol, 'BUY', 'MARKET', quantity);
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
      const base = symbol.replace('USDT', '');
      const baseBalance = account.balances.find((b) => b.asset === base);
      const available = parseFloat(baseBalance?.free ?? '0');
      const quantity = (available * TRADE_RATIO).toFixed(5);

      if (parseFloat(quantity) <= 0) {
        console.log(`⚠️ ${base} 餘額不足，無法賣出`);
        return;
      }

      console.log(`🔴 [${this.name}] 賣出 ${symbol}: ${quantity} @ ${price}`);
      const order = await placeOrder(symbol, 'SELL', 'MARKET', quantity);
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
