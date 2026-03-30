/**
 * 執行指定策略一次
 * 用法：npx tsx scripts/run-strategy.ts <策略名稱> [幣對]
 * 策略名稱：ma-cross | rsi | grid
 * 幣對預設：BTCUSDT
 */

import { getEnvInfo } from '../src/binance.js';
import { maCrossStrategy } from '../src/strategies/ma-cross.js';
import { rsiStrategy } from '../src/strategies/rsi.js';
import { gridStrategy } from '../src/strategies/grid.js';
import type { Strategy } from '../src/strategies/base.js';

const STRATEGIES: Record<string, Strategy> = {
  'ma-cross': maCrossStrategy,
  'rsi': rsiStrategy,
  'grid': gridStrategy,
};

async function main() {
  const strategyName = process.argv[2];
  const symbol = (process.argv[3] ?? 'BTCUSDT').toUpperCase();
  const env = getEnvInfo();

  if (!strategyName || !STRATEGIES[strategyName]) {
    console.log('');
    console.log('📋 使用方式：npx tsx scripts/run-strategy.ts <策略> [幣對]');
    console.log('');
    console.log('可用策略：');
    for (const [key, strategy] of Object.entries(STRATEGIES)) {
      console.log(`  ${key.padEnd(12)} — ${strategy.description}`);
    }
    console.log('');
    console.log('範例：');
    console.log('  npx tsx scripts/run-strategy.ts ma-cross BTCUSDT');
    console.log('  npx tsx scripts/run-strategy.ts rsi ETHUSDT');
    console.log('  npx tsx scripts/run-strategy.ts grid BTCUSDT');
    console.log('');
    process.exit(0);
  }

  const strategy = STRATEGIES[strategyName];

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`  🤖 執行策略  ${env.isTestnet ? '【測試網】' : '【主網 ⚠️】'}`);
  console.log('═══════════════════════════════════════');
  console.log(`  策略：${strategy.name}`);
  console.log(`  幣對：${symbol}`);
  console.log('');

  try {
    // 分析
    console.log('📊 分析中...');
    const result = await strategy.analyze(symbol);
    console.log(`\n${result.reason}`);
    console.log(`\n📍 訊號：${result.signal} | 強度：${(result.strength * 100).toFixed(1)}%`);

    if (result.signal !== 'HOLD') {
      console.log('\n⚡ 執行交易...');
      await strategy.execute(symbol, result);
    }

    console.log('\n✅ 策略執行完成！');
    console.log('');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${msg}\n`);
    process.exit(1);
  }
}

main();
