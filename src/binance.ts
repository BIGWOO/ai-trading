/**
 * Binance API 封裝模組
 * 支援 HMAC SHA256 簽名，可切換 testnet/mainnet
 */

import { createHmac } from 'node:crypto';
import { config } from 'dotenv';

config();

// ===== 設定 =====

const API_KEY = process.env.BINANCE_API_KEY ?? '';
const SECRET_KEY = process.env.BINANCE_SECRET_KEY ?? '';
const BASE_URL = process.env.BINANCE_BASE_URL ?? 'https://testnet.binance.vision';
const IS_TESTNET = process.env.BINANCE_TESTNET === 'true';

if (!API_KEY || !SECRET_KEY) {
  console.error('❌ 請在 .env 中設定 BINANCE_API_KEY 和 BINANCE_SECRET_KEY');
  process.exit(1);
}

// ===== 工具函式 =====

/** 產生 HMAC SHA256 簽名 */
function sign(queryString: string): string {
  return createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
}

/** 取得當前時間戳（毫秒） */
function timestamp(): number {
  return Date.now();
}

/** 將物件轉為 query string */
function toQueryString(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// ===== API 請求封裝 =====

interface BinanceError {
  code: number;
  msg: string;
}

/** 發送公開 API 請求（不需簽名） */
async function publicRequest<T>(endpoint: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const qs = toQueryString(params);
  const url = `${BASE_URL}${endpoint}${qs ? '?' + qs : ''}`;

  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': API_KEY },
  });

  const data = await res.json() as T | BinanceError;

  if (!res.ok || (data as BinanceError).code) {
    const err = data as BinanceError;
    throw new Error(`❌ Binance API 錯誤 [${err.code}]: ${err.msg}`);
  }

  return data as T;
}

/** 發送需要簽名的私有 API 請求 */
async function signedRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  const allParams = { ...params, timestamp: timestamp(), recvWindow: 10000 };
  const qs = toQueryString(allParams);
  const signature = sign(qs);
  const fullQs = `${qs}&signature=${signature}`;

  const url = `${BASE_URL}${endpoint}?${fullQs}`;

  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY },
  });

  const data = await res.json() as T | BinanceError;

  if (!res.ok || (data as BinanceError).code) {
    const err = data as BinanceError;
    throw new Error(`❌ Binance API 錯誤 [${err.code}]: ${err.msg}`);
  }

  return data as T;
}

// ===== 型別定義 =====

export interface AccountInfo {
  makerCommission: number;
  takerCommission: number;
  balances: Array<{
    asset: string;
    free: string;
    locked: string;
  }>;
}

export interface PriceInfo {
  symbol: string;
  price: string;
}

export interface Kline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
}

export interface OrderResponse {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  type: string;
  side: string;
}

export interface OpenOrder {
  symbol: string;
  orderId: number;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  type: string;
  side: string;
  time: number;
}

export interface Trade {
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
}

// ===== 公開 API 函式 =====

/** 查詢帳戶餘額 */
export async function getAccountInfo(): Promise<AccountInfo> {
  return signedRequest<AccountInfo>('GET', '/api/v3/account');
}

/** 查詢即時價格 */
export async function getPrice(symbol: string): Promise<PriceInfo> {
  return publicRequest<PriceInfo>('/api/v3/ticker/price', { symbol: symbol.toUpperCase() });
}

/** 查詢所有交易對價格 */
export async function getAllPrices(): Promise<PriceInfo[]> {
  return publicRequest<PriceInfo[]>('/api/v3/ticker/price');
}

/** 查詢 K 線數據 */
export async function getKlines(
  symbol: string,
  interval: string = '1h',
  limit: number = 100,
): Promise<Kline[]> {
  const raw = await publicRequest<unknown[][]>('/api/v3/klines', {
    symbol: symbol.toUpperCase(),
    interval,
    limit,
  });

  // 將陣列格式轉為物件
  return raw.map((k) => ({
    openTime: k[0] as number,
    open: String(k[1]),
    high: String(k[2]),
    low: String(k[3]),
    close: String(k[4]),
    volume: String(k[5]),
    closeTime: k[6] as number,
    quoteVolume: String(k[7]),
    trades: k[8] as number,
  }));
}

/** 下單（支援 LIMIT 和 MARKET） */
export async function placeOrder(
  symbol: string,
  side: 'BUY' | 'SELL',
  type: 'LIMIT' | 'MARKET',
  quantity: string,
  price?: string,
): Promise<OrderResponse> {
  const params: Record<string, string | number | boolean> = {
    symbol: symbol.toUpperCase(),
    side,
    type,
    quantity,
    newOrderRespType: 'FULL',
  };

  if (type === 'LIMIT') {
    if (!price) throw new Error('❌ LIMIT 訂單必須指定價格');
    params.price = price;
    params.timeInForce = 'GTC';
  }

  return signedRequest<OrderResponse>('POST', '/api/v3/order', params);
}

/** 查詢未成交訂單 */
export async function getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
  const params: Record<string, string | number | boolean> = {};
  if (symbol) params.symbol = symbol.toUpperCase();
  return signedRequest<OpenOrder[]>('GET', '/api/v3/openOrders', params);
}

/** 取消訂單 */
export async function cancelOrder(symbol: string, orderId: number): Promise<OrderResponse> {
  return signedRequest<OrderResponse>('DELETE', '/api/v3/order', {
    symbol: symbol.toUpperCase(),
    orderId,
  });
}

/** 查詢成交歷史 */
export async function getTradeHistory(symbol: string, limit: number = 50): Promise<Trade[]> {
  return signedRequest<Trade[]>('GET', '/api/v3/myTrades', {
    symbol: symbol.toUpperCase(),
    limit,
  });
}

// ===== 工具函式匯出 =====

/** 取得環境資訊 */
export function getEnvInfo(): { isTestnet: boolean; baseUrl: string } {
  return { isTestnet: IS_TESTNET, baseUrl: BASE_URL };
}

/** 計算移動平均線 */
export function calculateMA(prices: string[], period: number): string[] {
  const result: string[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += parseFloat(prices[j]);
    }
    result.push((sum / period).toFixed(8));
  }
  return result;
}

/** 計算 RSI */
export function calculateRSI(prices: string[], period: number = 14): string[] {
  const result: string[] = [];
  const changes: number[] = [];

  // 計算價格變動
  for (let i = 1; i < prices.length; i++) {
    changes.push(parseFloat(prices[i]) - parseFloat(prices[i - 1]));
  }

  if (changes.length < period) return [];

  // 第一個 RSI：用簡單平均
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const firstRSI = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  result.push(firstRSI.toFixed(2));

  // 後續 RSI：用指數移動平均
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] >= 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    result.push(rsi.toFixed(2));
  }

  return result;
}
