/**
 * AI Trading 主程式入口
 * 用法：npx tsx src/index.ts <命令>
 *
 * 命令：
 *   balance      — 查看帳戶餘額
 *   price        — 查看即時行情
 *   strategy     — 執行策略
 *   backtest     — 回測策略
 *   orders       — 查看未成交訂單
 *   trades       — 查看交易記錄
 *   performance  — 查看績效
 *   auto         — 自動交易管理
 *   risk         — 風控管理
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import {
  getAccountInfo, getPrice, getAllPrices, getOpenOrders,
  getTradeHistory, getEnvInfo,
} from './binance.js';
import { maCrossStrategy } from './strategies/ma-cross.js';
import { rsiStrategy } from './strategies/rsi.js';
import { gridStrategy } from './strategies/grid.js';
import { getTrades, getPerformance } from './storage.js';
import { getKlines } from './binance.js';
import { getRiskStatus, resetDailyRisk } from './risk-control.js';
import {
  enableAutoTrade, disableAutoTrade, getAutoTradeStatus,
} from './scheduler.js';
import type { Strategy, BacktestableStrategy } from './strategies/base.js';
import { executeWithRisk } from './trade-executor.js';
import {
  getAllStrategyConfigs, updateStrategyConfig, resetStrategyConfig,
  getDefaultConfigs, type StrategyName,
} from './strategy-config.js';
import { acquireLock, releaseLock } from './utils/global-lock.js';
import { mutateEnvelope } from './utils/config-ops.js';
import { createExecutionContext, validateStrategyParams } from './execution-context.js';
import { getRecentJournalEntries } from './trade-journal.js';
import { reviewRecentTrades, formatReviewReport } from './trade-review.js';
import { detectRegime } from './market-regime.js';

const STRATEGIES: Record<string, Strategy> = {
  'ma-cross': maCrossStrategy,
  'rsi': rsiStrategy,
  'grid': gridStrategy,
};

function showHelp() {
  const env = getEnvInfo();
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  🤖 AI Trading System  ${env.isTestnet ? '【測試網】' : '【主網 ⚠️】'}`);
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log('  命令：');
  console.log('    balance              查看帳戶餘額');
  console.log('    price [幣對]         查看即時行情');
  console.log('    strategy <名稱> [幣對] 執行策略');
  console.log('    backtest <名稱> [幣對] 回測策略');
  console.log('    orders [幣對]        查看未成交訂單');
  console.log('    history <幣對>       查看成交歷史');
  console.log('    trades               查看本地交易記錄');
  console.log('    performance          查看績效統計');
  console.log('    auto                 列出自動交易狀態');
  console.log('    auto enable <策略> <幣對> <間隔>  啟用自動交易');
  console.log('    auto disable <策略> <幣對>       停用自動交易');
  console.log('    risk                 查看風控狀態');
  console.log('    risk reset           重置當日風控');
  console.log('    config               查看所有策略設定');
  console.log('    config set <策略> <參數> <值>  修改策略參數');
  console.log('    config reset [策略]  重置為預設值');
  console.log('    evolve               手動觸發自動進化');
  console.log('    regime [幣對]         顯示市場狀態');
  console.log('    journal [N]          顯示最近 N 筆交易日誌');
  console.log('    review [天數]        覆盤交易');
  console.log('    report daily         日報');
  console.log('    report weekly        週報');
  console.log('');
  console.log('  可用策略：');
  for (const [key, strategy] of Object.entries(STRATEGIES)) {
    console.log(`    ${key.padEnd(14)} ${strategy.description}`);
  }
  console.log('');
  console.log('  範例：');
  console.log('    npx tsx src/index.ts balance');
  console.log('    npx tsx src/index.ts price BTCUSDT');
  console.log('    npx tsx src/index.ts strategy ma-cross ETHUSDT');
  console.log('');
}

async function handleBalance() {
  const account = await getAccountInfo();
  const nonZero = account.balances.filter(
    (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0,
  );

  console.log('\n💰 帳戶餘額：');
  console.log('─────────────────────────────────────');
  for (const b of nonZero) {
    console.log(`  ${b.asset.padEnd(8)} 可用: ${parseFloat(b.free).toFixed(8)}  鎖定: ${parseFloat(b.locked).toFixed(8)}`);
  }
  console.log('');
}

async function handlePrice(symbol?: string) {
  if (symbol) {
    const price = await getPrice(symbol);
    console.log(`\n📈 ${price.symbol}: ${parseFloat(price.price).toLocaleString()} USDT\n`);
  } else {
    const defaults = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
    const allPrices = await getAllPrices();
    const priceMap = new Map(allPrices.map((p) => [p.symbol, p.price]));

    console.log('\n📈 即時行情：');
    console.log('─────────────────────────────────────');
    for (const sym of defaults) {
      const p = priceMap.get(sym);
      if (p) {
        console.log(`  ${sym.padEnd(12)} ${parseFloat(p).toLocaleString(undefined, { minimumFractionDigits: 2 }).padStart(14)} USDT`);
      }
    }
    console.log('');
  }
}

async function handleStrategy(name: string, symbol: string) {
  const strategy = STRATEGIES[name];
  if (!strategy) {
    console.log(`❌ 未知策略：${name}`);
    console.log(`可用策略：${Object.keys(STRATEGIES).join(', ')}`);
    return;
  }

  // Fix R5-2: 手動執行策略必須取 global lock，避免與 auto-trade cron 併發
  const lock = acquireLock('manual-trade', 30);
  if (!lock) {
    console.log('❌ 無法取得 lock（另一個程序正在執行交易），請稍後再試');
    return;
  }

  try {
    console.log(`\n🤖 執行 ${strategy.name}（${symbol}）...`);
    // Fix R5-2: 傳入 fencingToken 給 createExecutionContext
    // Fix R6-2: 改用頂部 static import（無需動態 import）
    const ctx = createExecutionContext(strategy.id, symbol, lock.token);
    // 透過風控包裝器執行（分析 + 風控 + 交易）
    await executeWithRisk({ strategy, symbol, ctx });
    console.log('\n✅ 完成！\n');
  } finally {
    releaseLock(lock.token);
  }
}

async function handleOrders(symbol?: string) {
  const orders = await getOpenOrders(symbol);

  console.log(`\n📋 未成交訂單${symbol ? `（${symbol}）` : ''}：`);
  console.log('─────────────────────────────────────');

  if (orders.length === 0) {
    console.log('  無未成交訂單');
  } else {
    for (const o of orders) {
      const emoji = o.side === 'BUY' ? '🟢' : '🔴';
      console.log(`  ${emoji} ${o.symbol} ${o.side} ${o.origQty} @ ${o.price} [${o.type}] ID:${o.orderId}`);
    }
  }
  console.log('');
}

async function handleHistory(symbol: string) {
  const trades = await getTradeHistory(symbol);

  console.log(`\n📜 ${symbol} 成交歷史（最近 ${trades.length} 筆）：`);
  console.log('─────────────────────────────────────');

  for (const t of trades.slice(-10)) {
    const emoji = t.isBuyer ? '🟢' : '🔴';
    const side = t.isBuyer ? '買入' : '賣出';
    const time = new Date(t.time).toLocaleString();
    console.log(`  ${emoji} ${time} ${side} ${t.qty} @ ${t.price} | 手續費: ${t.commission} ${t.commissionAsset}`);
  }
  console.log('');
}

async function handleTrades() {
  const trades = await getTrades();

  console.log(`\n📒 本地交易記錄（共 ${trades.length} 筆）：`);
  console.log('─────────────────────────────────────');

  if (trades.length === 0) {
    console.log('  尚無交易記錄');
  } else {
    for (const t of trades.slice(-20)) {
      const emoji = t.side === 'BUY' ? '🟢' : '🔴';
      const time = new Date(t.timestamp).toLocaleString();
      console.log(`  ${emoji} ${time} ${t.side} ${t.quantity} ${t.symbol} @ ${t.price} [${t.strategy}]`);
    }
  }
  console.log('');
}

async function handlePerformance() {
  const perf = await getPerformance();

  console.log('\n📊 績效統計：');
  console.log('═══════════════════════════════════════');
  console.log(`  📋 總交易次數：  ${perf.totalTrades}`);
  console.log(`  🟢 買入次數：    ${perf.buyCount}`);
  console.log(`  🔴 賣出次數：    ${perf.sellCount}`);
  console.log(`  💰 總損益：      ${parseFloat(perf.totalPnL) >= 0 ? '+' : ''}${perf.totalPnL} USDT`);
  console.log(`  🎯 勝率：        ${perf.winRate}%`);
  console.log(`  ✅ 獲利次數：    ${perf.winCount}`);
  console.log(`  ❌ 虧損次數：    ${perf.lossCount}`);
  console.log(`  📈 最大獲利：    +${perf.maxWin} USDT`);
  console.log(`  📉 最大虧損：    ${perf.maxLoss} USDT`);
  console.log(`  ⚠️ 最大回撤：    ${perf.maxDrawdown} USDT`);
  console.log('');
}

async function handleAuto(subcommand?: string, arg1?: string, arg2?: string, arg3?: string) {
  if (!subcommand || subcommand === 'list' || subcommand === 'status') {
    // 列出自動交易狀態
    const status = getAutoTradeStatus();

    console.log('\n🤖 自動交易狀態：');
    console.log('═══════════════════════════════════════');
    console.log(`  📋 總數：${status.total}  |  啟用：${status.enabled}  |  停用：${status.disabled}`);

    if (status.entries.length === 0) {
      console.log('  📭 尚未設定任何自動交易');
    } else {
      console.log('');
      for (const entry of status.entries) {
        const icon = entry.enabled ? '🟢' : '⚪';
        const lastRun = entry.lastRun ?? '未執行';
        console.log(`  ${icon} ${entry.key}`);
        console.log(`     間隔: ${entry.interval} | 上次: ${lastRun} | 執行: ${entry.totalRuns} 次 | 錯誤: ${entry.errors}`);
      }
    }
    console.log('');
    return;
  }

  if (subcommand === 'enable') {
    if (!arg1 || !arg2 || !arg3) {
      console.log('❌ 用法：auto enable <策略> <幣對> <間隔>');
      console.log('   範例：auto enable ma-cross BTCUSDT 1h');
      return;
    }
    const strategyName = arg1;
    if (!STRATEGIES[strategyName]) {
      console.log(`❌ 未知策略：${strategyName}`);
      console.log(`   可用策略：${Object.keys(STRATEGIES).join(', ')}`);
      return;
    }
    try {
      const entry = enableAutoTrade(strategyName, arg2, arg3);
      console.log(`\n✅ 已啟用自動交易：${strategyName}:${entry.symbol}`);
      console.log(`   間隔：${entry.interval}`);
      console.log('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`❌ ${msg}`);
    }
    return;
  }

  if (subcommand === 'disable') {
    if (!arg1 || !arg2) {
      console.log('❌ 用法：auto disable <策略> <幣對>');
      console.log('   範例：auto disable ma-cross BTCUSDT');
      return;
    }
    const success = disableAutoTrade(arg1, arg2);
    if (success) {
      console.log(`\n✅ 已停用自動交易：${arg1}:${arg2.toUpperCase()}\n`);
    } else {
      console.log(`\n❌ 找不到自動交易：${arg1}:${arg2.toUpperCase()}\n`);
    }
    return;
  }

  console.log(`❌ 未知子命令：${subcommand}`);
  console.log('   可用：auto / auto enable / auto disable');
}

function handleRisk(subcommand?: string) {
  if (subcommand === 'reset') {
    console.log('⚠️ 此操作會清除當日損益、交易次數、連續虧損紀錄');
    resetDailyRisk();
    console.log('\n✅ 已重置當日風控狀態\n');
    return;
  }

  const status = getRiskStatus();

  console.log('\n🛡️ 風控狀態：');
  console.log('═══════════════════════════════════════');
  console.log(`  📅 日期：${status.state.date}`);
  console.log(`  💰 當前權益：${status.state.currentEquity.toFixed(2)} USDT`);
  console.log(`  📈 權益高點：${status.state.equityPeak.toFixed(2)} USDT`);
  console.log('');

  const checks = status.checks;
  const icon = (triggered: boolean) => triggered ? '🔴' : '🟢';

  console.log(`  ${icon(checks.dailyLoss.triggered)} 單日損益：${checks.dailyLoss.current}（上限 ${checks.dailyLoss.limit}）`);
  console.log(`  ${icon(checks.drawdown.triggered)} 最大回撤：${checks.drawdown.current}（上限 ${checks.drawdown.limit}）`);
  console.log(`  ${icon(checks.dailyTrades.triggered)} 交易次數：${checks.dailyTrades.current}（上限 ${checks.dailyTrades.limit}）`);
  console.log(`  ${icon(checks.consecutiveLosses.triggered)} 連續虧損：${checks.consecutiveLosses.current}（上限 ${checks.consecutiveLosses.limit}）`);
  console.log('');
}

function handleConfig(subcommand?: string, arg1?: string, arg2?: string, arg3?: string) {
  const VALID_STRATEGIES: StrategyName[] = ['ma-cross', 'rsi', 'grid'];

  // config — 顯示所有策略設定
  if (!subcommand || subcommand === 'list') {
    const all = getAllStrategyConfigs();
    const defaults = getDefaultConfigs();

    console.log('\n⚙️ 策略參數設定：');
    console.log('═══════════════════════════════════════');

    for (const strategy of VALID_STRATEGIES) {
      const cfg = all[strategy];
      const def = defaults[strategy];
      console.log(`\n  📋 ${strategy}`);
      for (const [key, val] of Object.entries(cfg)) {
        const isDefault = (def as unknown as Record<string, unknown>)[key] === val;
        const marker = isDefault ? '' : ' ✏️';
        console.log(`     ${key.padEnd(14)} ${val}${marker}`);
      }
    }
    console.log('');
    console.log('  ✏️ = 已修改（與預設值不同）');
    console.log('');
    return;
  }

  // config set <策略> <參數> <值>
  if (subcommand === 'set') {
    if (!arg1 || !arg2 || !arg3) {
      console.log('❌ 用法：config set <策略> <參數> <值>');
      console.log('   範例：config set rsi oversold 25');
      return;
    }
    const strategy = arg1 as StrategyName;
    if (!VALID_STRATEGIES.includes(strategy)) {
      console.log(`❌ 未知策略：${arg1}`);
      console.log(`   可用策略：${VALID_STRATEGIES.join(', ')}`);
      return;
    }
    const param = arg2;
    const rawValue = arg3;
    const numValue = Number(rawValue);
    if (isNaN(numValue)) {
      console.log(`❌ 參數值必須是數字，得到：${rawValue}`);
      return;
    }

    try {
      // Fix R2-3: 先取 lock，再同時更新 envelope + legacy（避免 split-brain）
      const lock = acquireLock('config-set', 30);
      if (!lock) {
        console.log('❌ 無法取得 lock（另一個程序正在執行），操作已取消');
        return;
      }
      let updated: ReturnType<typeof updateStrategyConfig> | undefined;
      try {
        // Fix R6-1: 先驗證參數合法性（key + 值域），不合法直接 throw，不會寫入任何檔案
        validateStrategyParams(strategy, { [param]: numValue });
        // Fix R5-1: 調換寫入順序 — 先寫 envelope（受 lock 保護、有 snapshot），
        // 成功後再寫 legacy。若 envelope 寫入失敗，legacy 不會被修改，避免 split-brain。
        mutateEnvelope(
          lock.token,
          (env) => {
            const current = env.strategyConfigs[strategy] as unknown as Record<string, unknown>;
            current[param] = numValue;
          },
          `config set ${strategy}.${param}=${numValue}`,
        );
        // Fix R5-1: envelope 成功後再寫 legacy，確保來源一致
        updated = updateStrategyConfig(strategy, { [param]: numValue } as never);
      } finally {
        releaseLock(lock.token);
      }

      console.log(`\n✅ 已更新 ${strategy}.${param} = ${numValue}`);
      if (updated) {
        console.log(`   目前設定：${JSON.stringify(updated, null, 2).replace(/\n/g, '\n   ')}`);
      }
      console.log('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`❌ 更新失敗：${msg}`);
    }
    return;
  }

  // config reset [策略]
  if (subcommand === 'reset') {
    if (arg1) {
      const strategy = arg1 as StrategyName;
      if (!VALID_STRATEGIES.includes(strategy)) {
        console.log(`❌ 未知策略：${arg1}`);
        console.log(`   可用策略：${VALID_STRATEGIES.join(', ')}`);
        return;
      }

      // Fix R2-3: 先取 lock，再同時更新 envelope + legacy
      const lock = acquireLock('config-reset', 30);
      if (!lock) {
        console.log('❌ 無法取得 lock（另一個程序正在執行），操作已取消');
        return;
      }
      try {
        // Fix R5-1: 先寫 envelope，成功後再寫 legacy，避免 split-brain
        const defaults = getDefaultConfigs();
        mutateEnvelope(lock.token, (env) => {
          (env.strategyConfigs as unknown as Record<string, unknown>)[strategy] = defaults[strategy];
        }, `config reset ${strategy}`);
        // Fix R5-1: envelope 成功後再寫 legacy
        resetStrategyConfig(strategy);
      } finally {
        releaseLock(lock.token);
      }

      console.log(`\n✅ 已重置 ${strategy} 為預設值\n`);
    } else {
      // Fix R2-3: 先取 lock，再同時更新 envelope + legacy
      const lock = acquireLock('config-reset', 30);
      if (!lock) {
        console.log('❌ 無法取得 lock（另一個程序正在執行），操作已取消');
        return;
      }
      try {
        // Fix R5-1: 先寫 envelope，成功後再寫 legacy，避免 split-brain
        const defaults = getDefaultConfigs();
        mutateEnvelope(lock.token, (env) => {
          env.strategyConfigs = defaults;
        }, 'config reset all');
        // Fix R5-1: envelope 成功後再寫 legacy
        resetStrategyConfig();
      } finally {
        releaseLock(lock.token);
      }

      console.log('\n✅ 已重置所有策略為預設值\n');
    }
    return;
  }

  console.log(`❌ 未知子命令：${subcommand}`);
  console.log('   可用：config / config set / config reset');
}

async function handleRegime(symbol?: string) {
  const sym = symbol ?? 'BTCUSDT';
  const klines = await getKlines(sym, '1h', 100);
  const closedKlines = klines.slice(0, -1);
  const result = detectRegime(
    closedKlines.map((k) => k.close),
    closedKlines.map((k) => k.high),
    closedKlines.map((k) => k.low),
  );

  console.log(`\n🌍 ${sym} 市場狀態：`);
  console.log('═══════════════════════════════════════');
  console.log(`  ${result.description}`);
  console.log(`  ADX: ${result.adx.toFixed(1)} | +DI: ${result.plusDI.toFixed(1)} | -DI: ${result.minusDI.toFixed(1)}`);
  console.log(`  ATR/Price: ${result.atrRatio.toFixed(2)}%`);
  console.log('');
}

function handleJournal(count?: string) {
  const n = parseInt(count ?? '10', 10);
  const entries = getRecentJournalEntries(n);

  console.log(`\n📒 最近 ${n} 筆交易日誌：`);
  console.log('═══════════════════════════════════════');

  if (entries.length === 0) {
    console.log('  📭 尚無交易日誌');
  } else {
    for (const e of entries) {
      const time = new Date(e.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
      const emoji = e.action === 'BUY' ? '🟢' : e.action === 'SELL' ? '🔴' : '⏸️';
      const pnlStr = e.pnl !== undefined ? ` PnL: ${e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(2)}` : '';
      console.log(`  ${emoji} ${time} ${e.strategyId}/${e.symbol} ${e.action}${e.price ? ` @ ${e.price}` : ''}${pnlStr}`);
      console.log(`     ${e.reason}`);
    }
  }
  console.log('');
}

function handleReview(days?: string) {
  const d = parseInt(days ?? '7', 10);
  const result = reviewRecentTrades(d);
  console.log('\n' + formatReviewReport(result));
}

async function handleReport(subcommand?: string) {
  if (subcommand === 'daily') {
    const { generateDailyReport, formatDailyReport } = await import('../scripts/daily-report.js');
    const data = await generateDailyReport();
    console.log('\n' + formatDailyReport(data));
    return;
  }
  if (subcommand === 'weekly') {
    const { generateWeeklyReport, formatWeeklyReport } = await import('../scripts/weekly-report.js');
    const data = generateWeeklyReport();
    console.log('\n' + formatWeeklyReport(data));
    return;
  }
  console.log('❌ 用法：report daily / report weekly');
}

async function handleEvolve() {
  const { runEvolution } = await import('../scripts/evolve.js');
  await runEvolution();
}

async function main() {
  const command = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  if (!command) {
    showHelp();
    return;
  }

  try {
    switch (command) {
      case 'balance':
        await handleBalance();
        break;
      case 'price':
        await handlePrice(arg1?.toUpperCase());
        break;
      case 'strategy':
        await handleStrategy(arg1 ?? '', (arg2 ?? 'BTCUSDT').toUpperCase());
        break;
      case 'orders':
        await handleOrders(arg1?.toUpperCase());
        break;
      case 'history':
        if (!arg1) { console.log('❌ 請指定幣對，例如：BTCUSDT'); break; }
        await handleHistory(arg1.toUpperCase());
        break;
      case 'trades':
        await handleTrades();
        break;
      case 'performance':
        await handlePerformance();
        break;
      case 'backtest':
        if (!arg1) { console.log('❌ 請指定策略，例如：ma-cross'); break; }
        console.log(`\n💡 回測請使用獨立腳本以獲得完整功能：`);
        console.log(`   npx tsx scripts/backtest.ts ${arg1} ${arg2 ?? 'BTCUSDT'}`);
        break;
      case 'auto':
        await handleAuto(arg1, arg2, process.argv[5], process.argv[6]);
        break;
      case 'risk':
        handleRisk(arg1);
        break;
      case 'config':
        handleConfig(arg1, arg2, process.argv[5], process.argv[6]);
        break;
      case 'evolve':
        await handleEvolve();
        break;
      case 'regime':
        await handleRegime(arg1?.toUpperCase());
        break;
      case 'journal':
        handleJournal(arg1);
        break;
      case 'review':
        handleReview(arg1);
        break;
      case 'report':
        await handleReport(arg1);
        break;
      default:
        console.log(`❌ 未知命令：${command}`);
        showHelp();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${msg}\n`);
    process.exit(1);
  }
}

main();
