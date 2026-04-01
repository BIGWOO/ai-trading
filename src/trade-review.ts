/**
 * Trade Review — 交易覆盤
 *
 * 分析最近交易的事後表現，提供調參建議。
 *
 * Phase B-2: Self-Evolution Plan v7
 */

import { getJournalEntriesSince } from './trade-journal.js';
import type { JournalEntry } from './trade-journal.js';

// ===== 型別定義 =====

export interface TradeReviewEntry {
  /** 原始日誌 */
  entry: JournalEntry;
  /** 事後分析 */
  analysis: string;
}

export interface TradeReviewResult {
  /** 覆盤期間 */
  periodDays: number;
  /** 覆盤條目 */
  reviews: TradeReviewEntry[];
  /** 統計摘要 */
  summary: {
    totalTrades: number;
    buyCount: number;
    sellCount: number;
    holdCount: number;
    totalPnl: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    avgPnl: number;
  };
  /** 建議 */
  suggestions: string[];
}

// ===== 公開 API =====

/**
 * 覆盤最近 N 天的交易
 *
 * @param days - 覆盤天數
 * @returns TradeReviewResult
 */
export function reviewRecentTrades(days: number): TradeReviewResult {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = getJournalEntriesSince(since);

  // 分析每筆交易
  const reviews: TradeReviewEntry[] = [];
  const buyEntries: JournalEntry[] = [];
  const sellEntries: JournalEntry[] = [];

  for (const entry of entries) {
    let analysis: string;

    if (entry.action === 'BUY') {
      buyEntries.push(entry);
      // 找後續是否有對應的 SELL
      const followingSell = entries.find(
        (e) =>
          e.action === 'SELL' &&
          e.strategyId === entry.strategyId &&
          e.symbol === entry.symbol &&
          e.timestamp > entry.timestamp,
      );

      if (followingSell && followingSell.pnl !== undefined) {
        if (followingSell.pnl > 0) {
          analysis = `✅ 買入後獲利 ${followingSell.pnl.toFixed(2)} USDT（賣出價 ${followingSell.price}）`;
        } else {
          analysis = `❌ 買入後虧損 ${followingSell.pnl.toFixed(2)} USDT（賣出價 ${followingSell.price}）`;
        }
      } else {
        analysis = `⏳ 尚未平倉`;
      }
    } else if (entry.action === 'SELL') {
      sellEntries.push(entry);
      if (entry.pnl !== undefined) {
        analysis = entry.pnl > 0
          ? `✅ 賣出獲利 ${entry.pnl.toFixed(2)} USDT`
          : `❌ 賣出虧損 ${entry.pnl.toFixed(2)} USDT`;
      } else {
        analysis = `📊 無損益數據`;
      }
    } else {
      analysis = `⏸️ 持觀望態度`;
    }

    reviews.push({ entry, analysis });
  }

  // 統計摘要
  const totalTrades = entries.length;
  const buyCount = buyEntries.length;
  const sellCount = sellEntries.length;
  const holdCount = entries.filter((e) => e.action === 'HOLD').length;

  const pnlTrades = sellEntries.filter((e) => e.pnl !== undefined);
  const totalPnl = pnlTrades.reduce((sum, e) => sum + (e.pnl ?? 0), 0);
  const winCount = pnlTrades.filter((e) => (e.pnl ?? 0) > 0).length;
  const lossCount = pnlTrades.filter((e) => (e.pnl ?? 0) < 0).length;
  const winRate = pnlTrades.length > 0 ? (winCount / pnlTrades.length) * 100 : 0;
  const avgPnl = pnlTrades.length > 0 ? totalPnl / pnlTrades.length : 0;

  // 建議
  const suggestions: string[] = [];

  if (totalTrades === 0) {
    suggestions.push('📭 覆盤期間無任何交易，可能需要調整策略靈敏度');
  } else {
    if (winRate < 40) {
      suggestions.push('⚠️ 勝率偏低（< 40%），建議考慮調整進場條件或切換策略');
    }
    if (winRate > 70) {
      suggestions.push('✅ 勝率優秀（> 70%），當前參數表現良好');
    }
    if (totalPnl < 0) {
      suggestions.push('📉 總損益為負，建議進行參數優化或考慮暫停該策略');
    }
    if (holdCount > buyCount + sellCount) {
      suggestions.push('⏸️ HOLD 訊號過多，策略可能過於保守');
    }
    if (buyCount > 0 && sellCount === 0) {
      suggestions.push('⚠️ 有買入但無賣出，可能需要檢查賣出條件');
    }

    // 策略別分析
    const strategyIds = [...new Set(entries.map((e) => e.strategyId))];
    for (const sid of strategyIds) {
      const stratTrades = pnlTrades.filter((e) => e.strategyId === sid);
      if (stratTrades.length >= 3) {
        const stratPnl = stratTrades.reduce((sum, e) => sum + (e.pnl ?? 0), 0);
        const stratWinRate = stratTrades.filter((e) => (e.pnl ?? 0) > 0).length / stratTrades.length * 100;
        if (stratPnl < 0 && stratWinRate < 40) {
          suggestions.push(`📊 ${sid} 策略表現不佳（PnL: ${stratPnl.toFixed(2)}, 勝率: ${stratWinRate.toFixed(0)}%），建議調參`);
        }
      }
    }
  }

  return {
    periodDays: days,
    reviews,
    summary: {
      totalTrades,
      buyCount,
      sellCount,
      holdCount,
      totalPnl,
      winCount,
      lossCount,
      winRate,
      avgPnl,
    },
    suggestions,
  };
}

/**
 * 格式化覆盤結果為文字報告
 */
export function formatReviewReport(result: TradeReviewResult): string {
  const lines: string[] = [];

  lines.push(`📋 交易覆盤（過去 ${result.periodDays} 天）`);
  lines.push('═══════════════════════════════════════');
  lines.push(`  📊 總交易次數：${result.summary.totalTrades}`);
  lines.push(`  🟢 買入：${result.summary.buyCount}  🔴 賣出：${result.summary.sellCount}  ⏸️ 觀望：${result.summary.holdCount}`);
  lines.push(`  💰 總損益：${result.summary.totalPnl >= 0 ? '+' : ''}${result.summary.totalPnl.toFixed(2)} USDT`);
  lines.push(`  🎯 勝率：${result.summary.winRate.toFixed(1)}%`);
  lines.push(`  📈 平均損益：${result.summary.avgPnl >= 0 ? '+' : ''}${result.summary.avgPnl.toFixed(2)} USDT`);
  lines.push('');

  if (result.reviews.length > 0) {
    lines.push('📝 交易明細：');
    for (const r of result.reviews.slice(-20)) {
      const time = new Date(r.entry.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
      const emoji = r.entry.action === 'BUY' ? '🟢' : r.entry.action === 'SELL' ? '🔴' : '⏸️';
      lines.push(`  ${emoji} ${time} ${r.entry.strategyId}/${r.entry.symbol} ${r.entry.action}`);
      lines.push(`     ${r.analysis}`);
    }
    lines.push('');
  }

  if (result.suggestions.length > 0) {
    lines.push('💡 建議：');
    for (const s of result.suggestions) {
      lines.push(`  ${s}`);
    }
  }

  return lines.join('\n');
}
