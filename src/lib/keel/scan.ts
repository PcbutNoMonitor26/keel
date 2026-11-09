import { createServerFn } from "@tanstack/react-start";
import pg from "pg";
import { SOL_MIN_USD, scoreOf, tapeFromCloses, DEFAULT_CONFIG, type Quote, type Regime, type Scan } from "@/lib/keel/engine";
import { cohortFromTape, settleTape, type TapePrint } from "@/lib/keel/trader-intel";

const UA = "Keel/1.0";
function processTapeCohort(quotes: { topTraderFlow?: { signal: string; reason: string } }[]): string {
  const reads = quotes.filter((quote) => quote.topTraderFlow);
  if (reads.length === 0) return "Tape cohort: watching wallets. A wallet counts after it has been right more than once. No paid feed.";
  const lead = reads[0]?.topTraderFlow;
  return `Tape cohort: ${reads.length} names. ${lead?.signal ?? "mixed"} · ${lead?.reason ?? "repeat wallets"}.`;
}
const PUMP_STREAM = "wss://pumpportal.fun/api/data";
const CACHE_MS = 1_200;
let cache: { at: number; scan: Scan } | null = null;
type Pair = {
  chainId?: string; dexId?: string; baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string; liquidity?: { usd?: number }; volume?: { h1?: number };
  priceChange?: { h1?: number; m5?: number };
  txns?: { h1?: { buys?: number; sells?: number }; m5?: { buys?: number; sells?: number } };
};
type PumpEvent = {
  mint?: string; name?: string; symbol?: string; uri?: string; txType?: string;
  marketCapSol?: number | string; vSolInBondingCurve?: number | string;
  vTokensInBondingCurve?: number | string; initialBuy?: number | string;
  traderPublicKey?: string; solAmount?: number | string;
  is_mayhem_mode?: boolean; pool?: string;
};
type PumpLaunch = {
  event: PumpEvent; seenAt: number; buys: number; sells: number; uniqueTraders: number;
  migrated: boolean; mayhem: boolean;
  traders?: Set<string>; buySol?: number; sellSol?: number; firstPx?: number; lastPx?: number;
  prints?: { t: number; px: number }[];
  flow?: TapePrint[];
};
type Held = { address: string };

let pumpSocket: WebSocket | null = null;
let pumpRetryAt = 0;
let pumpFails = 0;
let lastPumpMsgAt = 0;
let lastPrintAt = 0;
let pumpStatus = "Pump.fun launch feed is starting.";
let lastSolUsd = 0;
const pumpLaunches = new Map<string, PumpLaunch>();
const walletBook = new Map<string, { seen: number; good: number; bad: number }>();
const waitingPrints: TapePrint[] = [];
const watchedMints = new Set<string>();
const VIRTUAL_SOL = 30;
const feedPool = process.env.DATABASE_URL?.trim()
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 })
  : null;

async function getJson<T>(url: string, ms = 2500): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`Provider returned ${res.status}`);
  return (await res.json()) as T;
}
function n(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
let dexAt = 0;
let dexPairsCache: Pair[] = [];
let geckoCache: { at: number; value: { quotes: Quote[]; note: string } } | null = null;
let solCache: { at: number; tape: Awaited<ReturnType<typeof loadSolTape>> } | null = null;
async function loadSolTape() {
  let closes: number[] = [];
  try {
    const candles = await getJson<number[][]>("https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60", 2000);
    closes = candles.slice(0, 16).map((c) => n(c[4]));
  } catch {
    closes = [];
  }
  if (closes.filter((x) => x > 0).length < 6) {
    const rows = await getJson<unknown[]>("https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=16", 2000);
    closes = rows.slice(-16).reverse().map((row) => n(Array.isArray(row) ? row[4] : 0));
  }
  const tape = tapeFromCloses(closes);
  if (!tape) throw new Error("SOL tape failed the sanity check");
  return { ...tape, note: "" };
}
async function solTape() {
  const now = Date.now();
  if (solCache && now - solCache.at < 20_000) return solCache.tape;
  try {
    const tape = await loadSolTape();
    solCache = { at: now, tape };
    return tape;
  } catch {
    if (solCache) return solCache.tape;
    return { regime: "chop" as Regime, sol: 0, ret1: 0, ret5: 0, sol15: 0, vol1m: 0, note: "SOL reference feed unavailable; trend filter is neutral." };
  }
}
function validMint(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}
function pushPrint(launch: PumpLaunch, px: number, at = Date.now()) {
  if (!(px > 0)) return;
  const prints = launch.prints ?? [];
  launch.prints = prints;
  const last = prints[prints.length - 1];
  if (last && Math.abs(last.px - px) / px < 0.0001 && at - last.t < 800) return;
  prints.push({ t: at, px });
  lastPrintAt = at;
  if (prints.length > 24) prints.splice(0, prints.length - 24);
}
function windowShift(prints: { t: number; px: number }[] | undefined, now: number, windowMs: number): number {
  const recent = (prints ?? []).filter((p) => now - p.t <= windowMs && p.px > 0);
  if (recent.length < 2) return 0;
  const first = recent[0]?.px ?? 0;
  const last = recent[recent.length - 1]?.px ?? 0;
  return first > 0 ? ((last / first) - 1) * 100 : 0;
}
function tapeRead(prints: { t: number; px: number }[] | undefined, now: number): { shift1m?: number; heat: number } {
  const all = prints ?? [];
  const recent = all.filter((p) => now - p.t <= 20_000).length;
  const prior = all.filter((p) => now - p.t <= 40_000 && now - p.t > 20_000).length;
  const minute = all.filter((p) => now - p.t <= 60_000);
  const heat = prior === 0 ? (recent >= 2 ? 1.4 : 1) : recent / prior;
  const shift1m = minute.length >= 2 ? windowShift(minute, now, 60_000) : undefined;
  return { shift1m, heat };
}
function curvePx(event: PumpEvent, solUsd: number): number {
  const vSol = n(event.vSolInBondingCurve);
  const vTokens = n(event.vTokensInBondingCurve);
  if (solUsd > 0 && vSol > 0 && vTokens > 0) {
    const px = (vSol / vTokens) * solUsd;
    return px > 0 && px < 1_000_000 ? px : 0;
  }
  return 0;
}
function realCurveUsd(event: PumpEvent, solUsd: number): number {
  const vSol = n(event.vSolInBondingCurve);
  if (!(vSol > 0) || !(solUsd > 0)) return 0;
  const realSol = vSol > 20 ? Math.max(0, vSol - VIRTUAL_SOL) : vSol;
  return realSol * solUsd;
}
function noteTrade(launch: PumpLaunch, event: PumpEvent, solUsd: number) {
  const tx = (event.txType ?? "").toLowerCase();
  if (tx !== "buy" && tx !== "sell") return;
  if (tx === "buy") {
    launch.buys += 1;
    launch.buySol = (launch.buySol ?? 0) + n(event.solAmount);
  } else {
    launch.sells += 1;
    launch.sellSol = (launch.sellSol ?? 0) + n(event.solAmount);
  }
  const trader = event.traderPublicKey;
  if (trader && trader.length >= 32) {
    const traders = launch.traders ?? new Set<string>();
    launch.traders = traders;
    if (!traders.has(trader) && traders.size < 80) traders.add(trader);
    launch.uniqueTraders = traders.size;
  }
  const px = curvePx(event, solUsd);
  if (px > 0) {
    if (!(launch.firstPx && launch.firstPx > 0)) launch.firstPx = px;
    launch.lastPx = px;
    pushPrint(launch, px);
  }
  if (trader && trader.length >= 32 && px > 0) {
    const print: TapePrint = {
      wallet: trader, side: tx === "sell" ? "sell" : "buy", usd: Math.max(0, n(event.solAmount) * solUsd),
      at: Date.now(), px, mint: launch.mint,
    };
    const flow = launch.flow ?? [];
    launch.flow = flow;
    flow.push(print);
    if (flow.length > 40) flow.splice(0, flow.length - 40);
    waitingPrints.push(print);
    if (waitingPrints.length > 400) waitingPrints.splice(0, waitingPrints.length - 400);
  }
}
function settleWallets(now: number) {
  let write = 0;
  for (const print of waitingPrints) {
    if (now - print.at < 45_000) {
      waitingPrints[write] = print;
      write += 1;
      continue;
    }
    const later = pumpLaunches.get(print.mint)?.lastPx ?? 0;
    if (later > 0) settleTape(walletBook, print, later);
  }
  waitingPrints.length = write;
  if (walletBook.size > 2_000) {
    for (const key of walletBook.keys()) {
      if (walletBook.size <= 1_500) break;
      walletBook.delete(key);
    }
  }
}
function watchMint(socket: WebSocket, mint: string) {
  if (socket.readyState !== WebSocket.OPEN || watchedMints.has(mint)) return;
  watchedMints.add(mint);
  if (watchedMints.size > 80) {
    const drop = watchedMints.values().next().value;
    if (drop) {
      watchedMints.delete(drop);
      socket.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [drop] }));
    }
  }
  socket.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
}
function ensurePumpStream(now: number) {
  if (typeof WebSocket === "undefined") {
    pumpStatus = "Pump.fun stream unavailable in this server runtime; waiting for a WebSocket-capable Node runtime.";
    return;
  }
  if (pumpSocket?.readyState === WebSocket.OPEN) {
    if (lastPumpMsgAt > 0 && now - lastPumpMsgAt > 45_000) {
      try { pumpSocket.close(); } catch { /* already closing */ }
      pumpSocket = null;
      pumpStatus = "Pump.fun stream went quiet. Reconnecting.";
    } else return;
  }
  if (pumpSocket && pumpSocket.readyState !== WebSocket.CLOSED) {
    try { pumpSocket.close(); } catch { /* already closing */ }
    pumpSocket = null;
  }
  if (now < pumpRetryAt) return;
  try {
    const socket = new WebSocket(PUMP_STREAM);
    pumpSocket = socket;
    socket.addEventListener("open", () => {
      if (pumpSocket !== socket) return;
      pumpFails = 0;
      lastPumpMsgAt = Date.now();
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      socket.send(JSON.stringify({ method: "subscribeMigration" }));
      for (const mint of pumpLaunches.keys()) watchMint(socket, mint);
      pumpStatus = "Pump.fun launch, trade, and migration stream connected.";
    });
    socket.addEventListener("message", (message) => {
      lastPumpMsgAt = Date.now();
      try {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw || raw.length > 64_000) return;
        const event = JSON.parse(raw) as PumpEvent;
        if (!validMint(event.mint)) return;
        const previous = pumpLaunches.get(event.mint);
        const mayhem = Boolean(previous?.mayhem || event.is_mayhem_mode === true || event.pool === "mayhem");
        const tx = (event.txType ?? "").toLowerCase();
        if (previous && (tx === "buy" || tx === "sell")) {
          noteTrade(previous, event, lastSolUsd);
          previous.event = { ...previous.event, ...event };
          previous.mayhem = mayhem;
          watchMint(socket, event.mint);
          return;
        }
        const launch: PumpLaunch = previous ?? {
          event, seenAt: Date.now(), buys: 0, sells: 0, uniqueTraders: 0, migrated: false, mayhem,
          traders: new Set<string>(), buySol: 0, sellSol: 0, firstPx: 0, lastPx: 0,
        };
        launch.event = { ...launch.event, ...event };
        launch.mayhem = mayhem;
        launch.migrated = Boolean(launch.migrated || tx === "migrate" || tx === "migration");
        const px = curvePx(launch.event, lastSolUsd);
        if (px > 0 && !(launch.firstPx && launch.firstPx > 0)) launch.firstPx = px;
        if (px > 0) {
          launch.lastPx = px;
          pushPrint(launch, px);
        }
        pumpLaunches.set(event.mint, launch);
        watchMint(socket, event.mint);
        if (pumpLaunches.size > 400) {
          const oldest = [...pumpLaunches.entries()].sort((a, b) => {
            const at = a[1].prints?.[a[1].prints.length - 1]?.t ?? a[1].seenAt;
            const bt = b[1].prints?.[b[1].prints.length - 1]?.t ?? b[1].seenAt;
            return at - bt;
          }).slice(0, 80);
          for (const [mint] of oldest) pumpLaunches.delete(mint);
        }
      } catch {
        // Ignore malformed provider frames; keep the stream alive.
      }
    });
    socket.addEventListener("close", () => {
      if (pumpSocket !== socket) return;
      pumpSocket = null;
      pumpFails += 1;
      pumpRetryAt = Date.now() + Math.min(30_000, 1_500 * 2 ** Math.min(pumpFails, 4));
      pumpStatus = "Pump.fun stream disconnected. Reconnecting.";
    });
    socket.addEventListener("error", () => {
      if (pumpSocket !== socket) return;
      pumpStatus = "Pump.fun stream error. Reconnecting.";
      pumpRetryAt = Date.now() + 1_500;
      try { socket.close(); } catch { /* close handler reconnects */ }
    });
  } catch {
    pumpSocket = null;
    pumpRetryAt = now + 10_000;
    pumpStatus = "Pump.fun stream could not start; retrying shortly.";
  }
}
function pairQuote(address: string, p: Pair, extra: Partial<Quote> = {}): Quote | null {
  const price = n(p.priceUsd);
  const liq = n(p.liquidity?.usd);
  if (p.chainId !== "solana" || p.baseToken?.address !== address || !(price > 0) || price > 1_000_000) return null;
  if (liq < 0 || liq > 1e12) return null;
  return { venue: "sol", address, symbol: p.baseToken?.symbol || "?", title: p.baseToken?.name || "", price,
    liq, vol1h: n(p.volume?.h1), change1h: n(p.priceChange?.h1), change5m: n(p.priceChange?.m5),
    buys: n(p.txns?.m5?.buys), sells: n(p.txns?.m5?.sells),
    dex: p.dexId || "dex", side: "long", assetId: "", mins: SOL_MIN_USD, minutes: 0, edge: 0, fair: 0, endsAt: 0, ...extra };
}
async function persistedPumpLaunches(): Promise<{ launches: [string, PumpLaunch][]; status: string }> {
  if (!feedPool) return { launches: [], status: "" };
  const [tokens, health] = await Promise.all([
    feedPool.query(
      `SELECT t.mint, t.first_seen_at, t.event, t.migrated,
        COUNT(tr.signature) FILTER (WHERE tr.tx_type='buy' AND tr.block_time > now() - interval '5 minutes')::int AS buys,
        COUNT(tr.signature) FILTER (WHERE tr.tx_type='sell' AND tr.block_time > now() - interval '5 minutes')::int AS sells,
        COUNT(DISTINCT tr.trader_public_key) FILTER (WHERE tr.block_time > now() - interval '5 minutes')::int AS unique_traders
       FROM pump_tokens t
       LEFT JOIN pump_trades tr ON tr.mint=t.mint
       WHERE t.last_seen_at > now() - interval '45 minutes'
       GROUP BY t.mint,t.first_seen_at,t.last_seen_at,t.event
       ORDER BY t.last_seen_at DESC LIMIT 30`,
    ),
    feedPool.query("SELECT state,last_event_at,last_error,updated_at FROM pump_feed_status WHERE worker_key='pumpportal' LIMIT 1"),
  ]);
  const launches: [string, PumpLaunch][] = tokens.rows.map((row: { mint: string; first_seen_at: Date | string; event: PumpEvent; buys: number; sells: number; unique_traders: number; migrated: boolean }) => [
    row.mint,
    { event: row.event, seenAt: row.first_seen_at instanceof Date ? row.first_seen_at.getTime() : new Date(row.first_seen_at).getTime(), buys: Number(row.buys) || 0, sells: Number(row.sells) || 0, uniqueTraders: Number(row.unique_traders) || 0, migrated: Boolean(row.migrated), mayhem: row.event?.is_mayhem_mode === true || row.event?.pool === "mayhem" },
  ]);
  const worker = health.rows[0] as { state?: string; last_event_at?: Date | string | null; last_error?: string | null; updated_at?: Date | string | null } | undefined;
  const lastEvent = worker?.last_event_at ? new Date(worker.last_event_at).toLocaleTimeString() : "none yet";
  const heartbeat = worker?.updated_at ? (worker.updated_at instanceof Date ? worker.updated_at.getTime() : new Date(worker.updated_at).getTime()) : 0;
  const workerState = heartbeat > 0 && Date.now() - heartbeat > 120_000 ? "stale (heartbeat older than 2 minutes)" : worker?.state;
  const status = worker
    ? `Persistent Pump.fun worker: ${workerState}; last event ${lastEvent}.${worker.last_error ? ` Last error: ${worker.last_error}` : ""}`
    : "Persistent Pump.fun worker has not registered a heartbeat. Start scripts/pump-feed-worker.mjs.";
  const healthy = worker?.state === "connected" && heartbeat > 0 && Date.now() - heartbeat <= 120_000;
  // Do not score stale persisted launches when the dedicated feed is offline.
  return { launches: healthy ? launches : [], status };
}
async function pumpFunQuotes(now: number, solUsd: number): Promise<{ quotes: Quote[]; note: string }> {
  if (solUsd > 0) lastSolUsd = solUsd;
  if (!feedPool && process.env.NODE_ENV === "production") {
    return { quotes: [], note: "Persistent Pump.fun feed is not configured. Set DATABASE_URL, apply migrations, and run the dedicated feed worker." };
  }
  let feedNote = pumpStatus;
  let launches: [string, PumpLaunch][];
  if (feedPool) {
    try {
      const persisted = await persistedPumpLaunches();
      launches = persisted.launches;
      feedNote = persisted.status;
    } catch (error) {
      return { quotes: [], note: `Persistent Pump.fun feed database unavailable: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  } else {
    ensurePumpStream(now);
    settleWallets(now);
    for (const [mint, launch] of pumpLaunches) {
      if (now - launch.seenAt > 45 * 60_000) pumpLaunches.delete(mint);
    }
    launches = [...pumpLaunches.entries()].sort((a, b) => b[1].seenAt - a[1].seenAt);
  }
  if (!launches.length) return { quotes: [], note: feedNote };
  const hot = [...launches].sort((a, b) => {
    const at = a[1].prints?.[a[1].prints.length - 1]?.t ?? 0;
    const bt = b[1].prints?.[b[1].prints.length - 1]?.t ?? 0;
    return bt - at;
  });
  const dexMints = hot
    .filter(([, launch]) => now - (launch.prints?.[launch.prints.length - 1]?.t ?? 0) < 90_000)
    .slice(0, 20)
    .map(([mint]) => mint);
  const addresses = launches.map(([mint]) => mint);
  let pairs: Pair[] = dexPairsCache;
  if (dexMints.length && now - dexAt >= 8_000) {
    try {
      const body = await getJson<{ pairs?: Pair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${dexMints.join(",")}`, 600);
      dexPairsCache = body.pairs ?? [];
      dexAt = now;
      pairs = dexPairsCache;
    } catch {
      // Curve prices stay available when the market quote is slow.
    }
  }
  const best = new Map<string, Pair>();
  for (const pair of pairs) {
    const mint = pair.baseToken?.address;
    if (pair.chainId !== "solana" || !mint || !addresses.includes(mint)) continue;
    if (!best.has(mint) || n(pair.liquidity?.usd) > n(best.get(mint)?.liquidity?.usd)) best.set(mint, pair);
  }
  const quotes = launches.flatMap(([mint, launch]) => {
    const ageMin = Math.max(0, (now - launch.seenAt) / 60_000);
    const market = best.get(mint);
    if (market) {
      const quote = pairQuote(mint, market, { pumpFun: true, mayhem: launch.mayhem, preMigration: !launch.migrated, ageMin, minutes: ageMin, buys: launch.buys > 0 || launch.sells > 0 ? launch.buys : n(market.txns?.m5?.buys), sells: launch.buys > 0 || launch.sells > 0 ? launch.sells : n(market.txns?.m5?.sells), uniqueTraders: launch.uniqueTraders || undefined });
      if (!quote) return [];
      const read = tapeRead(launch.prints, now);
      const move = read.shift1m
        ?? (launch.firstPx && launch.lastPx && launch.firstPx > 0 ? ((launch.lastPx / launch.firstPx) - 1) * 100 : 0);
      if (quote.change5m === 0 && move !== 0) quote.change5m = move;
      if (read.shift1m !== undefined) quote.shift1m = read.shift1m;
      quote.heat = read.heat;
      const curve = realCurveUsd(launch.event, solUsd);
      if (quote.liq < 100 && curve > 0) quote.liq = curve;
      const traded = ((launch.buySol ?? 0) + (launch.sellSol ?? 0)) * solUsd;
      if (quote.vol1h <= 0 && traded > 0) quote.vol1h = traded;
      quote.topTraderFlow = cohortFromTape(walletBook, launch.flow ?? [], now) ?? undefined;
      return [quote];
    }
    const event = launch.event;
    const price = curvePx(event, solUsd) || (launch.lastPx ?? 0);
    if (price <= 0) return [];
    const symbol = typeof event.symbol === "string" && event.symbol.trim() ? event.symbol.trim().slice(0, 12) : mint.slice(0, 6);
    const title = typeof event.name === "string" ? event.name.slice(0, 80) : symbol;
    const read = tapeRead(launch.prints, now);
    const move = read.shift1m
      ?? (launch.firstPx && launch.lastPx && launch.firstPx > 0 ? ((launch.lastPx / launch.firstPx) - 1) * 100 : 0);
    const traded = ((launch.buySol ?? 0) + (launch.sellSol ?? 0)) * solUsd;
    return [{ venue: "sol" as const, address: mint, symbol, title, price, liq: realCurveUsd(event, solUsd),
      vol1h: traded, change1h: 0, change5m: move, buys: launch.buys, sells: launch.sells,
      dex: "pump.fun", side: "long" as const, assetId: "", mins: SOL_MIN_USD, minutes: ageMin,
      edge: 0, fair: 0, endsAt: 0, pumpFun: true, mayhem: launch.mayhem, preMigration: !launch.migrated, ageMin, uniqueTraders: launch.uniqueTraders,
      shift1m: read.shift1m, heat: read.heat,
      topTraderFlow: cohortFromTape(walletBook, launch.flow ?? [], now) ?? undefined }];
  });
  quotes.sort((a, b) => (b.buys - b.sells) - (a.buys - a.sells));
  return { quotes, note: `Pump.fun stream is watching ${launches.length} names. ${feedNote}` };
}
function readHeld(input: unknown): Held[] {
  const raw = input && typeof input === "object" ? (input as { held?: unknown }).held : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(row => {
    if (!row || typeof row !== "object") return [];
    const address = (row as { address?: unknown }).address;
    return validMint(address) ? [{ address }] : [];
  }).slice(0, 8);
}
async function heldQuotes(held: Held[], known: Set<string>): Promise<Quote[]> {
  const missing = held.map(h => h.address).filter(a => !known.has(a));
  if (!missing.length) return [];
  const body = await getJson<{ pairs?: Pair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${missing.join(",")}`, 1500);
  const best = new Map<string, Pair>();
  for (const p of body.pairs ?? []) {
    const a = p.baseToken?.address;
    if (p.chainId !== "solana" || !a || !missing.includes(a)) continue;
    if (!best.has(a) || n(p.liquidity?.usd) > n(best.get(a)?.liquidity?.usd)) best.set(a,p);
  }
  return missing.flatMap(a => { const p=best.get(a), q=p ? pairQuote(a,p) : null; return q ? [q] : []; });
}
let refreshing = false;

export const getScan = createServerFn({ method: "GET" }).validator(readHeld).handler(async ({ data: held }): Promise<Scan> => {
  if (!refreshing) {
    refreshing = true;
    const timer = setTimeout(() => { refreshing = false; }, 3_000);
    buildScan(held).finally(() => {
      clearTimeout(timer);
      refreshing = false;
    });
  }
  if (cache) return { ...cache.scan, at: Date.now() };
  return buildScan(held);
});

async function geckoLiveQuotes(now: number): Promise<{ quotes: Quote[]; note: string }> {
  if (geckoCache && now - geckoCache.at < 12_000) return geckoCache.value;
  try {
    const body = await getJson<{ data?: { attributes?: Record<string, unknown>; relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } } }[] }>(
      "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1",
      800,
    );
    const quotes: Quote[] = [];
    for (const row of body.data ?? []) {
      const attrs = row.attributes ?? {};
      const mint = String(row.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, "");
      if (!validMint(mint)) continue;
      const created = Date.parse(String(attrs.pool_created_at ?? ""));
      const ageMin = Number.isFinite(created) ? Math.max(0, (now - created) / 60_000) : 99;
      if (ageMin > 45) continue;
      const tx = (attrs.transactions ?? {}) as { m5?: { buys?: number; sells?: number; buyers?: number } };
      const vol = (attrs.volume_usd ?? {}) as { h1?: string | number };
      const chg = (attrs.price_change_percentage ?? {}) as { m5?: string | number; h1?: string | number };
      const liq = n(attrs.reserve_in_usd);
      const buys = n(tx.m5?.buys);
      const sells = n(tx.m5?.sells);
      const stream = pumpLaunches.get(mint);
      const dexId = String(row.relationships?.dex?.data?.id ?? "gecko");
      const pumpFun = Boolean(stream) || dexId.includes("pump");
      if (!stream && liq < 8_000 && buys + sells < 10) continue;
      const name = String(attrs.name ?? mint.slice(0, 6));
      const symbol = name.split("/")[0]?.trim().slice(0, 12) || mint.slice(0, 6);
      quotes.push({
        venue: "sol", address: mint, symbol, title: name, price: n(attrs.base_token_price_usd),
        liq, vol1h: n(vol.h1), change1h: n(chg.h1), change5m: n(chg.m5), buys, sells,
        dex: dexId, side: "long", assetId: "", mins: SOL_MIN_USD, minutes: ageMin, edge: 0, fair: 0, endsAt: 0,
        pumpFun, mayhem: Boolean(stream?.mayhem), preMigration: stream ? !stream.migrated : false,
        ageMin, uniqueTraders: n(tx.m5?.buyers) || stream?.uniqueTraders || undefined,
      });
    }
    const value = { quotes: quotes.filter((q) => q.price > 0).slice(0, 20), note: `GeckoTerminal: ${quotes.length} new Solana pools.` };
    geckoCache = { at: now, value };
    return value;
  } catch {
    return geckoCache?.value ?? { quotes: [], note: "GeckoTerminal new-pool feed is quiet. Launch stream still running." };
  }
}

function mergeQuotes(primary: Quote[], extra: Quote[]): Quote[] {
  const byAddress = new Map<string, Quote>();
  for (const quote of extra) byAddress.set(quote.address, quote);
  for (const quote of primary) {
    const prev = byAddress.get(quote.address);
    if (!prev) {
      byAddress.set(quote.address, quote);
      continue;
    }
    const richer = quote.buys + quote.sells >= prev.buys + prev.sells ? quote : prev;
    byAddress.set(quote.address, {
      ...richer,
      mayhem: Boolean(quote.mayhem || prev.mayhem),
      pumpFun: Boolean(quote.pumpFun || prev.pumpFun),
      uniqueTraders: richer.uniqueTraders || quote.uniqueTraders || prev.uniqueTraders,
      liq: Math.max(quote.liq, prev.liq),
    });
  }
  return [...byAddress.values()].filter((q) => q.price > 0);
}

async function buildScan(held: Held[]): Promise<Scan> {
  const now = Date.now();
  const tape = await solTape();
  const [pump, gecko] = await Promise.all([pumpFunQuotes(now, tape.sol), geckoLiveQuotes(now)]);
  let quotes = mergeQuotes(pump.quotes, gecko.quotes);
  const heldIds = new Set(held.map((row) => row.address));
  const ranked = quotes.map((q) => ({ q, scored: scoreOf(q, DEFAULT_CONFIG, tape.regime) }));
  const visible = ranked.filter((row) => row.scored.score > 0 || heldIds.has(row.q.address)).map((row) => row.q);
  const mayhem = quotes.filter((q) => q.mayhem);
  const lead = [...ranked].sort((a, b) => b.scored.score - a.scored.score)[0];
  const process = [
    `Watching ${quotes.length} names. ${ranked.filter((row) => row.scored.score > 0).length} scored above 0. The rest stay in the background.`,
    pump.note,
    gecko.note,
    `Mayhem on the tape: ${mayhem.length}. ${mayhem.filter((q) => q.buys >= 8 && q.sells >= 2).length} have two-sided prints.`,
    `Price shift, last minute: ${quotes.filter((q) => Math.abs(q.shift1m ?? q.change5m) >= 3 && q.buys + q.sells > 0).length} names moved. A seller blocks that name only.`,
    lead && lead.scored.score > 0 ? `Top candidate: ${lead.q.symbol} score ${lead.scored.score.toFixed(0)} · ${lead.scored.reasons[0] ?? "review gates"}` : "No name is above zero yet. The pump.fun stream is still being watched.",
    processTapeCohort(quotes),
  ];
  quotes = visible.slice(0, 24);
  let scan: Scan = { at: now, regime: tape.regime, sol: tape.sol, ret1: tape.ret1, ret5: tape.ret5, sol15: tape.sol15,
    vol1m: tape.vol1m, quotes, process, note: [tape.note].filter(Boolean).join(" ") };
  if (held.length) {
    try { const marks = await heldQuotes(held,new Set(quotes.map(q=>q.address))); scan={...scan,quotes:[...quotes,...marks]}; }
    catch { scan={...scan,note:[scan.note,"One or more held-token marks could not be refreshed."].filter(Boolean).join(" ")}; }
  }
  if (held.length === 0) cache = { at: now, scan };
  return scan;
}
