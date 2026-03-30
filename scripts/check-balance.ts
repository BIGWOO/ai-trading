/**
 * 查看帳戶餘額
 * 用法：npx tsx scripts/check-balance.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import { getAccountInfo, getEnvInfo } from '../src/binance.js';

async function main() {
  const env = getEnvInfo();
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`  💰 帳戶餘額查詢  ${env.isTestnet ? '【測試網】' : '【主網 ⚠️】'}`);
  console.log('═══════════════════════════════════════');
  console.log('');

  try {
    const account = await getAccountInfo();

    // 只顯示有餘額的幣種
    const nonZero = account.balances.filter(
      (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0,
    );

    if (nonZero.length === 0) {
      console.log('  ⚠️ 沒有任何餘額');
    } else {
      console.log('  幣種        可用              鎖定');
      console.log('  ─────────────────────────────────────');
      for (const b of nonZero) {
        const free = parseFloat(b.free).toFixed(8);
        const locked = parseFloat(b.locked).toFixed(8);
        const asset = b.asset.padEnd(10);
        console.log(`  ${asset}  ${free.padStart(16)}  ${locked.padStart(16)}`);
      }
    }

    console.log('');
    console.log(`  📊 手續費：Maker ${account.makerCommission / 100}% / Taker ${account.takerCommission / 100}%`);
    console.log('');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${msg}\n`);
    process.exit(1);
  }
}

main();
