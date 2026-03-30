/**
 * 自動交易單次執行入口
 * 被 OpenClaw cron 呼叫：npx tsx scripts/auto-trade.ts [--json]
 *
 * 流程：
 * 1. 取得 lock file 防止重疊執行
 * 2. 讀取 auto-trading.json 中 enabled=true 的項目
 * 3. 檢查各項目距離上次執行是否已過 interval
 * 4. 對到期的項目：先 checkRisk() → 通過才 execute()
 * 5. 更新 auto-trading.json 和 risk-state
 * 6. 輸出 JSON 結果（方便 Skill 推送通知）
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import { openSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cleanupTmpFiles } from '../src/utils/atomic-write.js';
import { getEnvInfo, getAccountInfo } from '../src/binance.js';
import { maCrossStrategy } from '../src/strategies/ma-cross.js';
import { rsiStrategy } from '../src/strategies/rsi.js';
import { gridStrategy } from '../src/strategies/grid.js';
import type { Strategy, StrategyResult } from '../src/strategies/base.js';
import { getAutoTrades, isDue, updateAutoTradeResult } from '../src/scheduler.js';
import { syncInitialCapital } from '../src/risk-control.js';
import { executeWithRisk } from '../src/trade-executor.js';

const STRATEGIES: Record<string, Strategy> = {
  'ma-cross': maCrossStrategy,
  'rsi': rsiStrategy,
  'grid': gridStrategy,
};

// ===== Lock file 機制 =====

const DATA_DIR = join(__dirname, '..', 'data');
const LOCK_FILE = join(DATA_DIR, '.auto-trade.lock');
const LOCK_MAX_AGE_MS = 30 * 60 * 1000; // 30 分鐘

interface LockFileContent {
  pid: number;
  startedAt: number;
  token: string;
}

/** 本次執行的唯一 token，用於 releaseLock 驗證 ownership */
const lockToken = randomUUID();

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 嘗試用 O_WRONLY | O_CREAT | O_EXCL (wx) 原子建立 lock 檔 */
function tryCreateLock(lockData: string): boolean {
  try {
    const fd = openSync(LOCK_FILE, 'wx');
    writeFileSync(fd, lockData, 'utf-8');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  ensureDataDir();

  const lockData = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: lockToken });

  // 嘗試原子建檔
  if (tryCreateLock(lockData)) return true;

  // Lock 已存在，檢查是否為 orphan
  try {
    const existing = JSON.parse(readFileSync(LOCK_FILE, 'utf-8')) as LockFileContent;
    const isAlive = isPidAlive(existing.pid);
    const isStale = Date.now() - existing.startedAt > LOCK_MAX_AGE_MS;

    if (isAlive && !isStale) {
      console.log(`⚠️ 另一個 auto-trade 正在執行中（PID: ${existing.pid}），跳過本次執行`);
      return false;
    }

    // Orphan lock：PID 已死或超時
    console.log(`🔓 清除過期 lock（PID: ${existing.pid}, 啟動於 ${new Date(existing.startedAt).toLocaleString('zh-TW')}）`);
    unlinkSync(LOCK_FILE);

    // 重試一次原子建檔
    return tryCreateLock(lockData);
  } catch {
    // Lock 檔損壞，嘗試刪除重建
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    return tryCreateLock(lockData);
  }
}

function releaseLock(): void {
  try {
    const content = readFileSync(LOCK_FILE, 'utf-8');
    const data = JSON.parse(content) as LockFileContent;
    // 只刪除自己建立的 lock（驗證 token ownership）
    if (data.token === lockToken) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // 忽略清理失敗
  }
}

// 確保任何情況下都清除 lock
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

// ===== 主要邏輯 =====

interface AutoTradeRunResult {
  key: string;
  strategy: string;
  symbol: string;
  status: 'executed' | 'skipped' | 'risk-blocked' | 'error';
  result?: StrategyResult | StrategyResult[];
  reason?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const results: AutoTradeRunResult[] = [];

  try {
    // 取得 lock
    if (!acquireLock()) {
      if (jsonMode) {
        console.log(JSON.stringify({ results: [], message: '另一個實例正在執行中' }));
      }
      process.exit(0);
    }

    // 啟動時清理可能的 .tmp 殘留檔案
    const tmpCleaned = cleanupTmpFiles(DATA_DIR);
    if (tmpCleaned > 0) {
      console.log(`🧹 已清理 ${tmpCleaned} 個殘留 .tmp 檔案`);
    }

    const env = getEnvInfo();

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(`  🤖 自動交易  ${env.isTestnet ? '【測試網】' : '【主網 ⚠️】'}`);
    console.log('═══════════════════════════════════════');
    console.log('');

    // 首次啟動時同步 initialCapital
    try {
      const STATE_FILE = join(__dirname, '..', 'data', 'risk-state.json');
      const isNewState = !existsSync(STATE_FILE);
      if (isNewState) {
        const accountInfo = await getAccountInfo();
        const usdtBalance = accountInfo.balances.find((b) => b.asset === 'USDT');
        const balance = parseFloat(usdtBalance?.free ?? '0') + parseFloat(usdtBalance?.locked ?? '0');
        if (balance > 0) {
          syncInitialCapital(balance);
          console.log(`💰 已同步初始資金：${balance.toFixed(2)} USDT`);
        }
      }
    } catch (err) {
      console.log(`⚠️ 同步初始資金失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    const autoTrades = getAutoTrades();
    const entries = Object.entries(autoTrades);
    const enabledEntries = entries.filter(([, e]) => e.enabled);

    if (enabledEntries.length === 0) {
      console.log('📭 沒有啟用中的自動交易');
      if (jsonMode) {
        console.log(JSON.stringify({ results: [], message: '沒有啟用中的自動交易' }));
      }
      return;
    }

    console.log(`📋 啟用中：${enabledEntries.length} 項`);
    console.log('');

    for (const [key, entry] of enabledEntries) {
      console.log(`─── ${key} ───`);

      // 檢查是否到達執行時間
      if (!isDue(entry)) {
        const lastRunStr = entry.lastRun ? new Date(entry.lastRun).toLocaleString('zh-TW') : '未執行';
        console.log(`  ⏭️ 尚未到期（上次：${lastRunStr}，間隔：${entry.interval}）`);
        results.push({
          key,
          strategy: entry.strategy,
          symbol: entry.symbol,
          status: 'skipped',
          reason: `尚未到期（間隔 ${entry.interval}）`,
        });
        continue;
      }

      // 取得策略
      const strategy = STRATEGIES[entry.strategy];
      if (!strategy) {
        console.log(`  ❌ 未知策略：${entry.strategy}`);
        results.push({
          key,
          strategy: entry.strategy,
          symbol: entry.symbol,
          status: 'error',
          reason: `未知策略：${entry.strategy}`,
        });
        continue;
      }

      // 透過風控包裝器執行（風控 + 分析 + 交易 + 風控記錄）
      try {
        console.log(`  📊 分析 + 風控檢查中...`);
        const strategyResult = await executeWithRisk({ strategy, symbol: entry.symbol });

        // 檢查是否被風控攔截（用 flag 判斷，不靠字串比對）
        const resultArray = Array.isArray(strategyResult) ? strategyResult : [strategyResult];
        const isRiskBlocked = resultArray.some((r) => r.riskBlocked === true);

        // 更新自動交易狀態
        updateAutoTradeResult(key, strategyResult);

        if (isRiskBlocked) {
          console.log(`  ${resultArray[0].reason}`);
          results.push({
            key,
            strategy: entry.strategy,
            symbol: entry.symbol,
            status: 'risk-blocked',
            reason: resultArray[0].reason,
          });
        } else {
          console.log(`  ✅ 完成`);
          results.push({
            key,
            strategy: entry.strategy,
            symbol: entry.symbol,
            status: 'executed',
            result: strategyResult,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ❌ 錯誤：${msg}`);
        updateAutoTradeResult(key, {
          action: 'HOLD',
          symbol: entry.symbol,
          strategy: entry.strategy,
          reason: `錯誤: ${msg}`,
          timestamp: Date.now(),
        }, true);
        results.push({
          key,
          strategy: entry.strategy,
          symbol: entry.symbol,
          status: 'error',
          reason: msg,
        });
      }

      console.log('');
    }

    // 摘要
    const executed = results.filter((r) => r.status === 'executed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const blocked = results.filter((r) => r.status === 'risk-blocked').length;
    const errors = results.filter((r) => r.status === 'error').length;

    console.log('═══════════════════════════════════════');
    console.log(`  📊 結果：執行 ${executed} / 跳過 ${skipped} / 風控 ${blocked} / 錯誤 ${errors}`);
    console.log('═══════════════════════════════════════');
    console.log('');

    if (jsonMode) {
      console.log(JSON.stringify({ results }));
    }
  } catch (err) {
    // 最外層 crash 保護
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ 未預期的錯誤：${msg}\n`);
    if (jsonMode) {
      console.log(JSON.stringify({ results, error: msg }));
    }
  }
}

main();
