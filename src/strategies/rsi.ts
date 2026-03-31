/**
 * RSI 策略
 * RSI < 30 → 超賣，買入
 * RSI > 70 → 超買，賣出
 *
 * 含部位管理：BUY 前檢查是否已持倉，SELL 時賣出完整部位
 * 分析時排除最後一根未收盤 K 線
 */

import {
  getKlines, getPrice, placeOrder, getAccountInfo,
  calculateRSI, getSymbolPrecision, adjustQuantity, getAvgFillPrice,
  getNetQuantity, getTotalCommission, extractBaseAsset,
} from '../binance.js';
import { recordTrade } from '../storage.js';
import { hasPosition, openPosition, closePosition, getPosition, shrinkPosition } from '../position.js';
import type { Strategy, BacktestableStrategy, AnalysisResult, StrategyResult } from './base.js';
import type { ExecutionContext } from '../execution-context.js';
import { getStrategyConfig } from '../strategy-config.js';

export const rsiStrategy: Strategy & BacktestableStrategy = {
  id: 'rsi',
  name: 'RSI 策略',
  get description() {
    const cfg = getStrategyConfig('rsi');
    return `RSI(${cfg.period}) 超買超賣訊號`;
  },

  async analyze(symbol: string, ctx?: ExecutionContext): Promise<AnalysisResult> {
    // 優先從 ctx 讀取，否則 fallback legacy
    const defaults = getStrategyConfig('rsi');
    const cfg = ctx?.strategyConfig && Object.keys(ctx.strategyConfig).length > 0
      ? {
          period: (ctx.strategyConfig.period as number) ?? defaults.period,
          oversold: (ctx.strategyConfig.oversold as number) ?? defaults.oversold,
          overbought: (ctx.strategyConfig.overbought as number) ?? defaults.overbought,
          tradeRatio: (ctx.strategyConfig.tradeRatio as number) ?? defaults.tradeRatio,
        }
      : defaults;
    // 多拉一根，排除最後未收盤的 K 線
    const klines = await getKlines(symbol, '1h', cfg.period + 21);
    // 排除最後一根未收盤 K 線
    const closedKlines = klines.slice(0, -1);
    const closePrices = closedKlines.map((k) => k.close);
    // Fix #1: 若 ctx 有 strategyConfig，傳入 overrides 給 analyzeKlines
    const overrides = ctx?.strategyConfig && Object.keys(ctx.strategyConfig).length > 0
      ? { period: cfg.period, oversold: cfg.oversold, overbought: cfg.overbought }
      : undefined;
    return this.analyzeKlines(closePrices, closePrices.length - 1, overrides);
  },

  analyzeKlines(closePrices: string[], index: number, overrides?: Partial<{ period: number; oversold: number; overbought: number }>): AnalysisResult {
    const baseCfg = getStrategyConfig('rsi');
    const RSI_PERIOD = overrides?.period ?? baseCfg.period;
    const OVERSOLD = overrides?.oversold ?? baseCfg.oversold;
    const OVERBOUGHT = overrides?.overbought ?? baseCfg.overbought;

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

  async execute(symbol: string, result: AnalysisResult, ctx?: ExecutionContext): Promise<StrategyResult> {
    // 優先從 ctx 讀取，否則 fallback legacy
    const defaults = getStrategyConfig('rsi');
    const ctxCfg = ctx?.strategyConfig && Object.keys(ctx.strategyConfig).length > 0
      ? {
          period: (ctx.strategyConfig.period as number) ?? defaults.period,
          oversold: (ctx.strategyConfig.oversold as number) ?? defaults.oversold,
          overbought: (ctx.strategyConfig.overbought as number) ?? defaults.overbought,
          tradeRatio: (ctx.strategyConfig.tradeRatio as number) ?? defaults.tradeRatio,
        }
      : defaults;

    if (result.signal === 'HOLD') {
      console.log(`⏸️ [${this.name}] ${result.reason}`);
      return {
        action: 'HOLD',
        symbol,
        strategy: this.name,
        strategyId: this.id,
        reason: result.reason,
        timestamp: Date.now(),
        configVersion: ctx?.configVersion,
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
          strategyId: this.id,
          reason: `已有 ${symbol} 部位，跳過買入`,
          timestamp: Date.now(),
          configVersion: ctx?.configVersion,
        };
      }

      const { tradeRatio } = ctxCfg;
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
          strategyId: this.id,
          reason: 'USDT 餘額不足，無法買入',
          timestamp: Date.now(),
          configVersion: ctx?.configVersion,
        };
      }

      console.log(`🟢 [${this.name}] 買入 ${symbol}: ${quantity} @ ~${price}`);
      const order = await placeOrder(symbol, 'BUY', 'MARKET', quantity, price);

      // 使用實際成交數據
      const actualPrice = getAvgFillPrice(order);
      // 扣除手續費後的淨數量（Binance 可能從基礎幣扣手續費）
      const baseAsset = extractBaseAsset(symbol);
      const netQty = getNetQuantity(order, baseAsset);

      // 記錄部位（用扣手續費後的淨數量）
      // Fix #6: 傳入 strategyId 和 configVersion
      openPosition({
        strategy: this.name,
        strategyId: this.id,
        symbol,
        entryPrice: actualPrice,
        quantity: netQty,
        orderId: order.orderId,
        configVersion: ctx?.configVersion,
      });

      await recordTrade({
        timestamp: Date.now(),
        symbol,
        side: 'BUY',
        price: actualPrice,
        quantity: netQty,
        strategy: this.name,
        strategyId: this.id,
        orderId: order.orderId,
        reason: result.reason,
        configVersion: ctx?.configVersion,
      });

      return {
        action: 'BUY',
        symbol,
        strategy: this.name,
        strategyId: this.id,
        price: actualPrice,
        quantity: netQty,
        orderId: order.orderId,
        reason: result.reason,
        timestamp: Date.now(),
        configVersion: ctx?.configVersion,
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
          strategyId: this.id,
          reason: `沒有 ${symbol} 部位，跳過賣出`,
          timestamp: Date.now(),
          configVersion: ctx?.configVersion,
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

      // 下單成功後判斷是否完整平倉
      // 若 executedQty >= position.quantity * 0.99（容忍精度誤差），視為完整平倉
      const isFullClose = parseFloat(actualQty) >= parseFloat(position.quantity) * 0.99;
      if (isFullClose) {
        closePosition(this.name, symbol);
      } else {
        shrinkPosition(this.name, symbol, actualQty);
      }

      await recordTrade({
        timestamp: Date.now(),
        symbol,
        side: 'SELL',
        price: actualPrice,
        quantity: actualQty,
        strategy: this.name,
        strategyId: this.id,
        orderId: order.orderId,
        reason: result.reason,
        configVersion: ctx?.configVersion,
      });

      return {
        action: 'SELL',
        symbol,
        strategy: this.name,
        strategyId: this.id,
        price: actualPrice,
        quantity: actualQty,
        orderId: order.orderId,
        reason: result.reason,
        timestamp: Date.now(),
        pnl,
        configVersion: ctx?.configVersion,
      };
    }

    // fallback
    return {
      action: 'HOLD',
      symbol,
      strategy: this.name,
      strategyId: this.id,
      reason: result.reason,
      timestamp: Date.now(),
      configVersion: ctx?.configVersion,
    };
  },
};
