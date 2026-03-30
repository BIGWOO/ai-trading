/**
 * Binance API 封裝模組
 * 支援 HMAC SHA256 簽名，可切換 testnet/mainnet
 * 含延遲載入 API Key、URL 白名單、timeout/retry、Exchange Info 快取
 */

import { createHmac } from 'node:crypto';
import { config } from 'dotenv';

config();

// ===== 設定 =====

/** Testnet URL 白名單 */
const TESTNET_DOMAINS = ['testnet.binance.vision'];

/** Mainnet URL 白名單 */
const MAINNET_DOMAINS = ['api.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com', 'api4.binance.com'];

/** 允許的 BASE_URL 白名單 */
const ALLOWED_BASE_URLS = [
  ...TESTNET_DOMAINS.map((d) => `https://${d}`),
  ...MAINNET_DOMAINS.map((d) => `https://${d}`),
];

const BASE_URL = process.env.BINANCE_BASE_URL ?? 'https://testnet.binance.vision';
const IS_TESTNET = process.env.BINANCE_TESTNET === 'true';

/** 從 URL 中擷取 domain */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 啟動時交叉驗證 BINANCE_TESTNET 與 BINANCE_BASE_URL 的一致性 */
function validateEnvConsistency(): void {
  // 先檢查白名單
  if (!ALLOWED_BASE_URLS.includes(BASE_URL)) {
    throw new Error(
      `❌ BASE_URL 不在白名單中：${BASE_URL}\n` +
      `   允許的 URL：${ALLOWED_BASE_URLS.join(', ')}`,
    );
  }

  const domain = extractDomain(BASE_URL);
  const isTestnetUrl = TESTNET_DOMAINS.includes(domain);
  const isMainnetUrl = MAINNET_DOMAINS.includes(domain);

  // BINANCE_TESTNET 未設定或為空 → 視為主網
  const envTestnet = process.env.BINANCE_TESTNET;
  const effectiveTestnet = envTestnet === 'true';

  if (effectiveTestnet && isMainnetUrl) {
    throw new Error(
      `❌ 環境變數不一致：BINANCE_TESTNET=true 但 BASE_URL 指向主網 (${domain})\n` +
      `   請修正 .env：若要使用測試網，BASE_URL 應為 https://testnet.binance.vision`,
    );
  }

  if (!effectiveTestnet && isTestnetUrl) {
    throw new Error(
      `❌ 環境變數不一致：BINANCE_TESTNET 不是 true 但 BASE_URL 指向測試網 (${domain})\n` +
      `   請修正 .env：若要使用測試網，請設定 BINANCE_TESTNET=true`,
    );
  }
}

// 模組載入時執行交叉驗證
validateEnvConsistency();

/** Mainnet 安全確認 */
const LIVE_TRADING_CONFIRM = process.env.LIVE_TRADING_CONFIRM ?? '';
const MAX_ORDER_USDT = parseFloat(process.env.MAX_ORDER_USDT ?? '100');

/** 延遲載入 API Key — 只在需要簽名時才檢查 */
function getApiKey(): string {
  const key = process.env.BINANCE_API_KEY ?? '';
  if (!key) {
    throw new Error('❌ 請在 .env 中設定 BINANCE_API_KEY');
  }
  return key;
}

function getSecretKey(): string {
  const key = process.env.BINANCE_SECRET_KEY ?? '';
  if (!key) {
    throw new Error('❌ 請在 .env 中設定 BINANCE_SECRET_KEY');
  }
  return key;
}

// ===== Mainnet 安全檢查 =====

/** 檢查 mainnet 下單是否已確認 */
function assertMainnetSafe(): void {
  if (IS_TESTNET) return;
  if (LIVE_TRADING_CONFIRM !== 'yes-i-know-what-i-am-doing') {
    throw new Error(
      '❌ 非測試網環境，但未設定 LIVE_TRADING_CONFIRM=yes-i-know-what-i-am-doing\n' +
      '   如果你確定要在主網下單，請在 .env 中加入此設定',
    );
  }
}

/** 檢查主網下單金額限制 */
function assertOrderSize(quantity: string, price: string): void {
  if (IS_TESTNET) return;
  const notional = parseFloat(quantity) * parseFloat(price);
  if (notional > MAX_ORDER_USDT) {
    throw new Error(
      `❌ 單筆下單金額 ${notional.toFixed(2)} USDT 超過上限 ${MAX_ORDER_USDT} USDT\n` +
      `   可在 .env 中調整 MAX_ORDER_USDT`,
    );
  }
}

// ===== 工具函式 =====

/** 產生 HMAC SHA256 簽名 */
function sign(queryString: string): string {
  return createHmac('sha256', getSecretKey()).update(queryString).digest('hex');
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

/** 帶 timeout 的 fetch */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 判斷是否應該 retry（含 5xx 伺服器錯誤） */
function shouldRetry(status: number): boolean {
  return status === 429 || status === 418 || (status >= 500 && status < 600);
}

/** 判斷是否為可重試的網路錯誤 */
function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      err.name === 'AbortError';
  }
  return false;
}

/** 安全解析 JSON 回應 */
async function safeParseJson<T>(res: Response): Promise<T | BinanceError> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T | BinanceError;
  } catch {
    throw new Error(`❌ Binance API 回傳非 JSON 格式：${text.slice(0, 200)}`);
  }
}

/** 發送公開 API 請求（不需簽名、不送 API Key） */
async function publicRequest<T>(endpoint: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const qs = toQueryString(params);
  const url = `${BASE_URL}${endpoint}${qs ? '?' + qs : ''}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url);

      if (shouldRetry(res.status)) {
        const wait = Math.pow(2, attempt) * 1000;
        console.log(`⏳ API 限流 (${res.status})，${wait / 1000} 秒後重試...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      const data = await safeParseJson<T>(res);

      if (!res.ok || (data as BinanceError).code) {
        const err = data as BinanceError;
        throw new Error(`❌ Binance API 錯誤 [${err.code}]: ${err.msg}`);
      }

      return data as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === 'AbortError') {
        lastError = new Error('❌ Binance API 請求超時（10 秒）');
      }
      // 可重試的網路/超時錯誤（含 5xx、連線重置等）
      if (attempt < 2 && (isRetryableNetworkError(err) || lastError.message.includes('超時'))) {
        const wait = Math.pow(2, attempt) * 1000;
        console.log(`⏳ 網路錯誤，${wait / 1000} 秒後重試...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error('❌ Binance API 請求失敗');
}

/** 發送需要簽名的私有 API 請求（每次 retry 都重新簽名） */
async function signedRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  const apiKey = getApiKey();

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // 每次都重新產生 timestamp 和簽名（避免 -1021 timestamp 過期）
    const allParams = { ...params, timestamp: timestamp(), recvWindow: 10000 };
    const qs = toQueryString(allParams);
    const sig = sign(qs);
    const url = `${BASE_URL}${endpoint}?${qs}&signature=${sig}`;

    try {
      const res = await fetchWithTimeout(url, {
        method,
        headers: { 'X-MBX-APIKEY': apiKey },
      });

      if (shouldRetry(res.status)) {
        // POST /order 不重試，避免重複下單
        if (method === 'POST' && endpoint.includes('/order')) {
          const data = await safeParseJson<T>(res);
          const err = data as BinanceError;
          throw new Error(`❌ Binance API 限流 [${err.code}]: ${err.msg}（下單請求不自動重試）`);
        }
        const wait = Math.pow(2, attempt) * 1000;
        console.log(`⏳ API ${res.status}，${wait / 1000} 秒後重試...`);
        await new Promise((r) => setTimeout(r, wait));
        continue; // 回到 loop 頂端重新簽名
      }

      const data = await safeParseJson<T>(res);

      if (!res.ok || (data as BinanceError).code) {
        const err = data as BinanceError;
        throw new Error(`❌ Binance API 錯誤 [${err.code}]: ${err.msg}`);
      }

      return data as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === 'AbortError') {
        lastError = new Error('❌ Binance API 請求超時（10 秒）');
      }
      // 下單請求不重試
      if (method === 'POST' && endpoint.includes('/order')) {
        throw lastError;
      }
      if (attempt < 2 && (isRetryableNetworkError(err) || lastError.message.includes('超時'))) {
        const wait = Math.pow(2, attempt) * 1000;
        console.log(`⏳ 網路錯誤，${wait / 1000} 秒後重試...`);
        await new Promise((r) => setTimeout(r, wait));
        continue; // 回到 loop 頂端重新簽名
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error('❌ Binance API 請求失敗');
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

export interface OrderFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
}

export interface OrderResponse {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  type: string;
  side: string;
  fills?: OrderFill[];
}

/** 計算扣除手續費後的淨數量（BUY 時基礎幣手續費扣除） */
export function getNetQuantity(order: OrderResponse, baseAsset: string): string {
  if (!order.fills || order.fills.length === 0) return order.executedQty;
  let totalQty = 0;
  let totalCommissionInBase = 0;
  for (const fill of order.fills) {
    totalQty += parseFloat(fill.qty);
    if (fill.commissionAsset === baseAsset) {
      totalCommissionInBase += parseFloat(fill.commission);
    }
  }
  return (totalQty - totalCommissionInBase).toFixed(8);
}

/** 計算總手續費 */
export function getTotalCommission(order: OrderResponse): { amount: number; asset: string } {
  if (!order.fills || order.fills.length === 0) return { amount: 0, asset: 'UNKNOWN' };
  let total = 0;
  const asset = order.fills[0].commissionAsset;
  for (const fill of order.fills) {
    total += parseFloat(fill.commission);
  }
  return { amount: total, asset };
}

/** 從 symbol 中擷取 baseAsset（如 BTCUSDT → BTC） */
export function extractBaseAsset(symbol: string): string {
  const quoteAssets = ['USDT', 'BUSD', 'USDC', 'BTC', 'ETH', 'BNB'];
  const upper = symbol.toUpperCase();
  for (const quote of quoteAssets) {
    if (upper.endsWith(quote)) {
      return upper.slice(0, -quote.length);
    }
  }
  return upper;
}

/** 從 FULL 回應計算實際成交均價 */
export function getAvgFillPrice(order: OrderResponse): string {
  if (order.fills && order.fills.length > 0) {
    let totalQty = 0;
    let totalCost = 0;
    for (const fill of order.fills) {
      const qty = parseFloat(fill.qty);
      totalQty += qty;
      totalCost += qty * parseFloat(fill.price);
    }
    return totalQty > 0 ? (totalCost / totalQty).toFixed(8) : order.price;
  }
  // fallback：用 cummulativeQuoteQty / executedQty
  const execQty = parseFloat(order.executedQty);
  const quoteQty = parseFloat(order.cummulativeQuoteQty ?? '0');
  if (execQty > 0 && quoteQty > 0) {
    return (quoteQty / execQty).toFixed(8);
  }
  return order.price;
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

// ===== Exchange Info 快取（下單精度） =====

interface SymbolFilter {
  filterType: string;
  stepSize?: string;
  tickSize?: string;
  minNotional?: string;
  notional?: string;
  minQty?: string;
  maxQty?: string;
  minPrice?: string;
  maxPrice?: string;
}

interface SymbolInfo {
  symbol: string;
  filters: SymbolFilter[];
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
}

interface ExchangeInfoResponse {
  symbols: SymbolInfo[];
}

/** Exchange Info 快取 */
const exchangeInfoCache = new Map<string, { info: SymbolInfo; cachedAt: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 小時

/** 取得交易對的 Exchange Info */
export async function getExchangeInfo(symbol: string): Promise<SymbolInfo> {
  const upperSymbol = symbol.toUpperCase();
  const cached = exchangeInfoCache.get(upperSymbol);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached.info;
  }

  const data = await publicRequest<ExchangeInfoResponse>('/api/v3/exchangeInfo', { symbol: upperSymbol });
  const info = data.symbols.find((s) => s.symbol === upperSymbol);
  if (!info) {
    throw new Error(`❌ 找不到交易對 ${upperSymbol} 的資訊`);
  }

  exchangeInfoCache.set(upperSymbol, { info, cachedAt: Date.now() });
  return info;
}

/** 根據 stepSize 調整數量精度 */
export function adjustQuantity(stepSize: string, qty: number): string {
  const step = parseFloat(stepSize);
  if (step === 0) return String(qty);
  // 計算小數位數
  const decimals = stepSize.indexOf('.') === -1 ? 0 : stepSize.replace(/0+$/, '').split('.')[1]?.length ?? 0;
  const adjusted = Math.floor(qty / step) * step;
  return adjusted.toFixed(decimals);
}

/** 根據 tickSize 調整價格精度 */
export function adjustPrice(tickSize: string, price: number): string {
  const tick = parseFloat(tickSize);
  if (tick === 0) return String(price);
  const decimals = tickSize.indexOf('.') === -1 ? 0 : tickSize.replace(/0+$/, '').split('.')[1]?.length ?? 0;
  const adjusted = Math.floor(price / tick) * tick;
  return adjusted.toFixed(decimals);
}

/** 取得交易對的精度參數 */
export async function getSymbolPrecision(symbol: string): Promise<{
  stepSize: string;
  tickSize: string;
  minNotional: number;
  minQty: number;
}> {
  const info = await getExchangeInfo(symbol);
  let stepSize = '0.00001';
  let tickSize = '0.01';
  let minNotional = 10;
  let minQty = 0;

  for (const f of info.filters) {
    if (f.filterType === 'LOT_SIZE') {
      stepSize = f.stepSize ?? stepSize;
      minQty = parseFloat(f.minQty ?? '0');
    } else if (f.filterType === 'PRICE_FILTER') {
      tickSize = f.tickSize ?? tickSize;
    } else if (f.filterType === 'MIN_NOTIONAL') {
      minNotional = parseFloat(f.minNotional ?? '10');
    } else if (f.filterType === 'NOTIONAL') {
      minNotional = parseFloat(f.minNotional ?? '10');
    }
  }

  return { stepSize, tickSize, minNotional, minQty };
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

/** 下單（支援 LIMIT 和 MARKET），自動調整精度 */
export async function placeOrder(
  symbol: string,
  side: 'BUY' | 'SELL',
  type: 'LIMIT' | 'MARKET',
  quantity: string,
  price?: string,
): Promise<OrderResponse> {
  // Mainnet 安全檢查
  assertMainnetSafe();

  const upperSymbol = symbol.toUpperCase();

  // 取得精度資訊並調整
  const precision = await getSymbolPrecision(upperSymbol);
  const adjustedQty = adjustQuantity(precision.stepSize, parseFloat(quantity));

  if (parseFloat(adjustedQty) < precision.minQty) {
    throw new Error(`❌ 下單數量 ${adjustedQty} 低於最小值 ${precision.minQty}`);
  }

  const params: Record<string, string | number | boolean> = {
    symbol: upperSymbol,
    side,
    type,
    quantity: adjustedQty,
    newOrderRespType: 'FULL',
  };

  if (type === 'LIMIT') {
    if (!price) throw new Error('❌ LIMIT 訂單必須指定價格');
    const adjustedPrice = adjustPrice(precision.tickSize, parseFloat(price));
    params.price = adjustedPrice;
    params.timeInForce = 'GTC';

    // Mainnet 金額檢查
    assertOrderSize(adjustedQty, adjustedPrice);
  } else {
    // MARKET 單用估計價格檢查金額
    if (price) {
      assertOrderSize(adjustedQty, price);
    }
  }

  // 檢查 MIN_NOTIONAL
  const estimatePrice = price ? parseFloat(price) : 0;
  if (estimatePrice > 0) {
    const notional = parseFloat(adjustedQty) * estimatePrice;
    if (notional < precision.minNotional) {
      throw new Error(`❌ 下單金額 ${notional.toFixed(2)} USDT 低於最低要求 ${precision.minNotional} USDT`);
    }
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
