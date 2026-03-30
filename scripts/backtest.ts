/**
 * 歷史 K 線回測
 * 用法：npx tsx scripts/backtest.ts <策略> [幣對] [K線間隔] [K線數量]
 * 範例：npx tsx scripts/backtest.ts ma-cross BTCUSDT 1h 500
 *
 * 修正：
 * - 排除最後一根未收盤 K 線
 * - 買入時記錄實際 buyPrice，賣出時正確計算 PnL
 * - capital 追蹤完全正確
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import { getKlines, getEnvInfo } from '../src/binance.js';
import { maCrossStrategy } from '../src/strategies/ma-cross.js';
import { rsiStrategy } from '../src/strategies/rsi.js';
import type { BacktestableStrategy } from '../src/strategies/base.js';

const STRATEGIES: Record<string, BacktestableStrategy> = {
  'ma-cross': maCrossStrategy,
  'rsi': rsiStrategy,
};

interface BacktestTrade {
  index: number;
  side: 'BUY' | 'SELL';
  price: string;
  reason: string;
}

async function main() {
  const strategyName = process.argv[2];
  const symbol = (process.argv[3] ?? 'BTCUSDT').toUpperCase();
  const interval = process.argv[4] ?? '1h';
  const limit = parseInt(process.argv[5] ?? '500');
  const env = getEnvInfo();

  if (!strategyName || !STRATEGIES[strategyName]) {
    console.log('');
    console.log('📋 使用方式：npx tsx scripts/backtest.ts <策略> [幣對] [間隔] [數量]');
    console.log('');
    console.log('可用策略：');
    for (const [key, strategy] of Object.entries(STRATEGIES)) {
      console.log(`  ${key.padEnd(12)} — ${strategy.name}`);
    }
    console.log('');
    console.log('K 線間隔：1m, 5m, 15m, 1h, 4h, 1d');
    console.log('');
    console.log('範例：');
    console.log('  npx tsx scripts/backtest.ts ma-cross BTCUSDT 1h 500');
    console.log('  npx tsx scripts/backtest.ts rsi ETHUSDT 4h 200');
    console.log('');
    process.exit(0);
  }

  const strategy = STRATEGIES[strategyName];

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  📊 回測模式  ${env.isTestnet ? '【測試網數據】' : '【主網數據】'}`);
  console.log('═══════════════════════════════════════════════');
  console.log(`  策略：${strategy.name}`);
  console.log(`  幣對：${symbol}`);
  console.log(`  間隔：${interval}`);
  console.log(`  K 線數：${limit}`);
  console.log('');

  try {
    // 多拉一根，排除最後未收盤 K 線
    console.log('📥 下載歷史 K 線...');
    const rawKlines = await getKlines(symbol, interval, limit + 1);
    // 排除最後一根未收盤 K 線
    const klines = rawKlines.slice(0, -1);
    const closePrices = klines.map((k) => k.close);

    console.log(`✅ 取得 ${klines.length} 根已收盤 K 線`);
    console.log(`📅 期間：${new Date(klines[0].openTime).toLocaleString()} ~ ${new Date(klines[klines.length - 1].closeTime).toLocaleString()}`);
    console.log('');

    // 執行回測
    console.log('🔄 回測中...');
    const trades: BacktestTrade[] = [];
    let position: 'NONE' | 'LONG' = 'NONE';

    for (let i = 0; i < closePrices.length; i++) {
      const result = strategy.analyzeKlines(closePrices, i);

      if (result.signal === 'BUY' && position === 'NONE') {
        trades.push({ index: i, side: 'BUY', price: closePrices[i], reason: result.reason });
        position = 'LONG';
      } else if (result.signal === 'SELL' && position === 'LONG') {
        trades.push({ index: i, side: 'SELL', price: closePrices[i], reason: result.reason });
        position = 'NONE';
      }
    }

    // 統計結果
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('  📈 回測結果');
    console.log('═══════════════════════════════════════════════');
    console.log('');

    if (trades.length === 0) {
      console.log('  ⚠️ 回測期間沒有產生任何交易訊號');
      console.log('');
      return;
    }

    // 配對交易，正確計算損益（使用 10% 倉位，與實盤策略一致）
    const initialCapital = 10000; // 假設初始資金 10000 USDT
    const TRADE_RATIO = 0.1; // 每次用可用資金的 10%（與實盤一致）
    let capital = initialCapital;
    let holdings = 0;
    let buyPrice = 0; // 記錄實際買入價格
    let winCount = 0;
    let lossCount = 0;
    let maxWin = 0;
    let maxLoss = 0;
    let peak = initialCapital;
    let maxDrawdown = 0;

    console.log('  交易記錄：');
    console.log('  ──────────────────────────────────────────');

    for (const trade of trades) {
      const time = new Date(klines[trade.index].openTime).toLocaleString();
      const price = parseFloat(trade.price);

      if (trade.side === 'BUY') {
        // 用可用資金的 10% 買入（與實盤 TRADE_RATIO 一致）
        const tradeAmount = capital * TRADE_RATIO;
        buyPrice = price;
        holdings = tradeAmount / price;
        capital -= tradeAmount;
        console.log(`  🟢 ${time} 買入 @ ${price.toFixed(2)} (數量: ${holdings.toFixed(6)}, 投入: ${tradeAmount.toFixed(2)} USDT)`);
      } else {
        // 全部賣出，PnL = holdings * sellPrice - holdings * buyPrice
        const sellValue = holdings * price;
        const costBasis = holdings * buyPrice;
        const pnl = sellValue - costBasis;
        capital += sellValue; // 賣出所得歸還可用資金
        holdings = 0;
        buyPrice = 0;

        if (pnl > 0) { winCount++; maxWin = Math.max(maxWin, pnl); }
        else { lossCount++; maxLoss = Math.min(maxLoss, pnl); }

        // 計算回撤（用總資產 = 現金 + 持倉市值）
        const totalAsset = capital; // 賣出後 holdings=0，capital 即為總資產
        if (totalAsset > peak) peak = totalAsset;
        const drawdown = (peak - totalAsset) / peak * 100;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;

        const emoji = pnl >= 0 ? '📈' : '📉';
        console.log(`  🔴 ${time} 賣出 @ ${price.toFixed(2)} | ${emoji} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
      }
    }

    // 如果還有持倉，用最後價格計算
    if (holdings > 0) {
      const lastPrice = parseFloat(closePrices[closePrices.length - 1]);
      capital += holdings * lastPrice;
      holdings = 0;
      console.log(`  ⏳ 未平倉部位以最後價格 ${lastPrice.toFixed(2)} 計算`);
    }

    const totalReturn = ((capital - initialCapital) / initialCapital * 100);
    const totalTrades = Math.floor(trades.length / 2);

    console.log('');
    console.log('  ──────────────────────────────────────────');
    console.log(`  💰 初始資金：     ${initialCapital.toLocaleString()} USDT`);
    console.log(`  💎 最終資金：     ${capital.toFixed(2)} USDT`);
    console.log(`  📊 總報酬率：     ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    console.log(`  🔄 交易次數：     ${totalTrades} 筆（買賣各算一次）`);
    console.log(`  ✅ 獲利交易：     ${winCount} 筆`);
    console.log(`  ❌ 虧損交易：     ${lossCount} 筆`);
    console.log(`  🎯 勝率：         ${totalTrades > 0 ? (winCount / totalTrades * 100).toFixed(1) : '0'}%`);
    console.log(`  📈 最大單筆獲利： +${maxWin.toFixed(2)} USDT`);
    console.log(`  📉 最大單筆虧損： ${maxLoss.toFixed(2)} USDT`);
    console.log(`  ⚠️ 最大回撤：     ${maxDrawdown.toFixed(2)}%`);

    // 買入持有對照
    const firstPrice = parseFloat(closePrices[0]);
    const lastPrice = parseFloat(closePrices[closePrices.length - 1]);
    const buyHoldReturn = ((lastPrice - firstPrice) / firstPrice * 100);
    console.log('');
    console.log(`  📋 買入持有對照：  ${buyHoldReturn >= 0 ? '+' : ''}${buyHoldReturn.toFixed(2)}%`);
    console.log(`  ${totalReturn > buyHoldReturn ? '🏆 策略優於買入持有！' : '⚠️ 策略未能超越買入持有'}`);
    console.log('');

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${msg}\n`);
    process.exit(1);
  }
}

main();
