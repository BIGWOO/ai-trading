/**
 * Weekly Report — 週報
 *
 * 用法：npx tsx scripts/weekly-report.ts [--json]
 *
 * - 過去 7 天的彙總
 * - 每日 PnL 曲線（emoji bar chart）
 * - 策略比較
 * - 參數變化紀錄
 *
 * Phase C-4: Self-Evolution Plan v7
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import { getJournalEntriesSince } from '../src/trade-journal.js';
import type { JournalEntry } from '../src/trade-journal.js';
import { queryEvolutionLog } from '../src/utils/evolution-log.js';
import type { EvolutionLogEntry } from '../src/utils/evolution-log.js';
import { getConfigEnvelope } from '../src/utils/config-envelope.js';

// ===== 型別定義 =====

export interface DailyPnl {
  date: string;
  pnl: number;
  trades: number;
}

export interface StrategyStats {
  strategyId: string;
  trades: number;
  pnl: number;
  winRate: number;
}

export interface WeeklyReportData {
  timestamp: number;
  periodDays: number;
  totalTrades: number;
  totalPnl: number;
  winRate: number;
  dailyPnls: DailyPnl[];
  strategyStats: StrategyStats[];
  evolutionEvents: EvolutionLogEntry[];
  configVersion: number;
}

// ===== 主函式 =====

export function generateWeeklyReport(): WeeklyReportData {
  const now = Date.now();
  const since = now - 7 * 24 * 60 * 60 * 1000;
  const entries = getJournalEntriesSince(since);

  // 每日 PnL
  const dailyMap = new Map<string, { pnl: number; trades: number }>();
  for (let d = 0; d < 7; d++) {
    const date = new Date(now - (6 - d) * 24 * 60 * 60 * 1000);
    const key = date.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' });
    dailyMap.set(key, { pnl: 0, trades: 0 });
  }

  const sellEntries = entries.filter((e) => e.action === 'SELL' && e.pnl !== undefined);
  const allTradeEntries = entries.filter((e) => e.action !== 'HOLD');

  for (const e of sellEntries) {
    const date = new Date(e.timestamp).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' });
    const day = dailyMap.get(date);
    if (day) {
      day.pnl += e.pnl ?? 0;
      day.trades += 1;
    }
  }

  // 也計算 BUY 的交易次數
  for (const e of allTradeEntries) {
    if (e.action === 'BUY') {
      const date = new Date(e.timestamp).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' });
      const day = dailyMap.get(date);
      if (day) {
        day.trades += 1;
      }
    }
  }

  const dailyPnls: DailyPnl[] = [];
  for (const [date, data] of dailyMap) {
    dailyPnls.push({ date, pnl: data.pnl, trades: data.trades });
  }

  // 策略比較
  const strategyMap = new Map<string, { trades: number; pnl: number; wins: number; total: number }>();
  for (const e of entries) {
    if (e.action === 'HOLD') continue;
    if (!strategyMap.has(e.strategyId)) {
      strategyMap.set(e.strategyId, { trades: 0, pnl: 0, wins: 0, total: 0 });
    }
    const stats = strategyMap.get(e.strategyId)!;
    stats.trades += 1;
    if (e.action === 'SELL' && e.pnl !== undefined) {
      stats.pnl += e.pnl;
      stats.total += 1;
      if (e.pnl > 0) stats.wins += 1;
    }
  }

  const strategyStats: StrategyStats[] = [];
  for (const [strategyId, data] of strategyMap) {
    strategyStats.push({
      strategyId,
      trades: data.trades,
      pnl: data.pnl,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
    });
  }

  // 進化事件
  const evolutionEvents = queryEvolutionLog({ since, limit: 20 });

  // Config version
  let configVersion = 0;
  try {
    const envelope = getConfigEnvelope();
    configVersion = envelope.configVersion;
  } catch { /* ignore */ }

  // 總計
  const totalPnl = sellEntries.reduce((sum, e) => sum + (e.pnl ?? 0), 0);
  const winCount = sellEntries.filter((e) => (e.pnl ?? 0) > 0).length;
  const winRate = sellEntries.length > 0 ? (winCount / sellEntries.length) * 100 : 0;

  return {
    timestamp: now,
    periodDays: 7,
    totalTrades: allTradeEntries.length,
    totalPnl,
    winRate,
    dailyPnls,
    strategyStats,
    evolutionEvents,
    configVersion,
  };
}

/**
 * 格式化 Discord 週報
 */
export function formatWeeklyReport(data: WeeklyReportData): string {
  const lines: string[] = [];
  const dateEnd = new Date(data.timestamp).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  const dateStart = new Date(data.timestamp - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });

  lines.push(`📊 **週報** — ${dateStart} ~ ${dateEnd}`);
  lines.push('');

  // 總覽
  lines.push('**📈 一週概覽**');
  lines.push(`• 總交易次數：${data.totalTrades}`);
  lines.push(`• 總損益：${data.totalPnl >= 0 ? '📈' : '📉'} ${data.totalPnl >= 0 ? '+' : ''}${data.totalPnl.toFixed(2)} USDT`);
  lines.push(`• 勝率：${data.winRate.toFixed(1)}%`);
  lines.push(`• Config Version: v${data.configVersion}`);
  lines.push('');

  // 每日 PnL 曲線
  lines.push('**📅 每日 PnL**');
  const maxAbsPnl = Math.max(...data.dailyPnls.map((d) => Math.abs(d.pnl)), 1);
  for (const day of data.dailyPnls) {
    const barLen = Math.round((Math.abs(day.pnl) / maxAbsPnl) * 8);
    const bar = day.pnl >= 0
      ? '🟩'.repeat(Math.max(barLen, day.pnl > 0 ? 1 : 0))
      : '🟥'.repeat(Math.max(barLen, 1));
    const pnlStr = `${day.pnl >= 0 ? '+' : ''}${day.pnl.toFixed(2)}`;
    lines.push(`• ${day.date} ${bar} ${pnlStr} (${day.trades} 筆)`);
  }
  lines.push('');

  // 策略比較
  if (data.strategyStats.length > 0) {
    lines.push('**🤖 策略比較**');
    for (const s of data.strategyStats) {
      const emoji = s.pnl >= 0 ? '✅' : '❌';
      lines.push(`• ${emoji} ${s.strategyId}: ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)} USDT | ${s.trades} 筆 | 勝率 ${s.winRate.toFixed(1)}%`);
    }
    lines.push('');
  }

  // 進化事件
  if (data.evolutionEvents.length > 0) {
    lines.push('**🧬 進化事件**');
    for (const e of data.evolutionEvents.slice(0, 5)) {
      const time = new Date(e.timestamp).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' });
      const emoji = e.type === 'optimization' ? '🔬' : e.type === 'rollback' ? '🔙' : e.type === 'graduation' ? '🎓' : '📝';
      lines.push(`• ${emoji} ${time} [${e.type}] ${e.strategyId}: ${e.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ===== CLI =====

async function main() {
  const jsonMode = process.argv.includes('--json');

  const data = generateWeeklyReport();

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatWeeklyReport(data));
  }
}

main().catch((err) => {
  console.error(`\n❌ 週報生成失敗：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
