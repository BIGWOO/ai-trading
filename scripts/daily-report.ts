/**
 * Daily Report — 日報
 *
 * 用法：npx tsx scripts/daily-report.ts [--json]
 *
 * - 讀取 trade-journal 過去 24h 的交易
 * - 計算：交易次數、勝率、總 PnL、最大回撤
 * - 偵測市場狀態
 * - 輸出格式化 Discord 報告
 *
 * Phase C-3: Self-Evolution Plan v7
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv';
config({ path: join(__dirname, '..', '.env') });

import { getJournalEntriesSince } from '../src/trade-journal.js';
import type { JournalEntry } from '../src/trade-journal.js';
import { getKlines } from '../src/binance.js';
import { detectRegime, formatRegime } from '../src/market-regime.js';
import { getConfigEnvelope } from '../src/utils/config-envelope.js';

// ===== 型別定義 =====

export interface DailyReportData {
  timestamp: number;
  periodHours: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  totalPnl: number;
  winRate: number;
  winCount: number;
  lossCount: number;
  maxDrawdown: number;
  regime: string;
  regimeDescription: string;
  configVersion: number;
  entries: JournalEntry[];
}

// ===== 主函式 =====

export async function generateDailyReport(): Promise<DailyReportData> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const entries = getJournalEntriesSince(since);

  // 統計
  const buyEntries = entries.filter((e) => e.action === 'BUY');
  const sellEntries = entries.filter((e) => e.action === 'SELL');
  const pnlTrades = sellEntries.filter((e) => e.pnl !== undefined);

  const totalPnl = pnlTrades.reduce((sum, e) => sum + (e.pnl ?? 0), 0);
  const winCount = pnlTrades.filter((e) => (e.pnl ?? 0) > 0).length;
  const lossCount = pnlTrades.filter((e) => (e.pnl ?? 0) < 0).length;
  const winRate = pnlTrades.length > 0 ? (winCount / pnlTrades.length) * 100 : 0;

  // 計算最大回撤（基於 PnL 累計曲線）
  let cumPnl = 0;
  let peak = 0;
  let maxDD = 0;
  for (const e of pnlTrades) {
    cumPnl += e.pnl ?? 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // 市場狀態
  let regime = 'unknown';
  let regimeDescription = '未知';
  try {
    const klines = await getKlines('BTCUSDT', '1h', 100);
    const closedKlines = klines.slice(0, -1);
    const result = detectRegime(
      closedKlines.map((k) => k.close),
      closedKlines.map((k) => k.high),
      closedKlines.map((k) => k.low),
    );
    regime = result.regime;
    regimeDescription = result.description;
  } catch { /* ignore */ }

  // Config version
  let configVersion = 0;
  try {
    const envelope = getConfigEnvelope();
    configVersion = envelope.configVersion;
  } catch { /* ignore */ }

  return {
    timestamp: Date.now(),
    periodHours: 24,
    tradeCount: entries.filter((e) => e.action !== 'HOLD').length,
    buyCount: buyEntries.length,
    sellCount: sellEntries.length,
    totalPnl,
    winRate,
    winCount,
    lossCount,
    maxDrawdown: maxDD,
    regime,
    regimeDescription,
    configVersion,
    entries,
  };
}

/**
 * 格式化 Discord 報告（emoji + 項目符號）
 */
export function formatDailyReport(data: DailyReportData): string {
  const lines: string[] = [];
  const date = new Date(data.timestamp).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });

  lines.push(`📊 **日報** — ${date}`);
  lines.push('');
  lines.push(`🌍 市場狀態：${formatRegime(data.regime as import('../src/market-regime.js').MarketRegime)}`);
  lines.push(`⚙️ Config Version: v${data.configVersion}`);
  lines.push('');
  lines.push('**📈 交易摘要**');
  lines.push(`• 交易次數：${data.tradeCount}（🟢 ${data.buyCount} 買 / 🔴 ${data.sellCount} 賣）`);
  lines.push(`• 總損益：${data.totalPnl >= 0 ? '📈' : '📉'} ${data.totalPnl >= 0 ? '+' : ''}${data.totalPnl.toFixed(2)} USDT`);
  lines.push(`• 勝率：${data.winRate.toFixed(1)}%（✅ ${data.winCount} 勝 / ❌ ${data.lossCount} 敗）`);
  lines.push(`• 最大回撤：${data.maxDrawdown.toFixed(2)} USDT`);

  if (data.entries.length > 0) {
    lines.push('');
    lines.push('**📝 交易明細**');
    const recentTrades = data.entries.filter((e) => e.action !== 'HOLD').slice(-10);
    for (const e of recentTrades) {
      const time = new Date(e.timestamp).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' });
      const emoji = e.action === 'BUY' ? '🟢' : '🔴';
      const pnlStr = e.pnl !== undefined ? ` (${e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(2)})` : '';
      lines.push(`• ${emoji} ${time} ${e.strategyId}/${e.symbol} ${e.action} @ ${e.price}${pnlStr}`);
    }
  } else {
    lines.push('');
    lines.push('📭 過去 24 小時無交易');
  }

  return lines.join('\n');
}

// ===== CLI =====

async function main() {
  const jsonMode = process.argv.includes('--json');

  const data = await generateDailyReport();

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatDailyReport(data));
  }
}

main().catch((err) => {
  console.error(`\n❌ 日報生成失敗：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
