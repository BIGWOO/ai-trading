/**
 * 查看即時行情
 * 用法：npx tsx scripts/check-price.ts [BTCUSDT]
 * 不指定幣對則顯示主流幣種
 * 不需要 API Key 即可執行
 */

import { getPrice, getAllPrices, getEnvInfo } from '../src/binance.js';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];

async function main() {
  const env = getEnvInfo();
  const symbol = process.argv[2]?.toUpperCase();

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`  📈 即時行情  ${env.isTestnet ? '【測試網】' : '【主網】'}`);
  console.log('═══════════════════════════════════════');
  console.log('');

  try {
    if (symbol) {
      // 查詢指定幣對
      const price = await getPrice(symbol);
      console.log(`  ${price.symbol}: ${parseFloat(price.price).toLocaleString()} USDT`);
    } else {
      // 查詢主流幣種
      const allPrices = await getAllPrices();
      const priceMap = new Map(allPrices.map((p) => [p.symbol, p.price]));

      console.log('  幣對            價格');
      console.log('  ─────────────────────────────');
      for (const sym of DEFAULT_SYMBOLS) {
        const p = priceMap.get(sym);
        if (p) {
          const label = sym.padEnd(14);
          const val = parseFloat(p).toLocaleString(undefined, { minimumFractionDigits: 2 });
          console.log(`  ${label}  ${val.padStart(14)} USDT`);
        }
      }
    }

    console.log('');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${msg}\n`);
    process.exit(1);
  }
}

main();
