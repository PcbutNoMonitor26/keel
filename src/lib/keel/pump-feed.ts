/** PumpPortal data-stream helpers. Pure — no sockets — so intake policy can be tested. */

export const PUMP_STREAM_BASE = "wss://pumpportal.fun/api/data";
export const TRADE_SUBSCRIBE_CHUNK = 200;

export type TapePrintStats = {
  names: number;
  missingPrint: number;
  stalePrint: number;
  freshPrint: number;
};

export function pumpStreamUrl(apiKey?: string, base = PUMP_STREAM_BASE): string {
  const key = apiKey?.trim();
  if (!key) return base;
  const url = new URL(base);
  url.searchParams.set("api-key", key);
  return url.toString();
}

export function canSubscribeTokenTrades(apiKey?: string, denied?: boolean): boolean {
  return Boolean(apiKey?.trim()) && !denied;
}

export function isTradeSubscribeDenied(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const message = String((body as { message?: unknown }).message ?? "");
  return message.includes("subscribeTokenTrade") && message.toLowerCase().includes("api key");
}

/** Held mints first, then every other tape mint. No 80-mint cap — PumpPortal accepts large key lists. */
export function tradeSubscribeKeys(tapeMints: string[], heldMints: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const mint of [...heldMints, ...tapeMints]) {
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    out.push(mint);
  }
  return out;
}

export function chunkKeys(keys: string[], size = TRADE_SUBSCRIBE_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
  return chunks;
}

export function newTradeSubscribeKeys(tapeMints: string[], heldMints: string[], already: Iterable<string>): string[] {
  const have = new Set(already);
  return tradeSubscribeKeys(tapeMints, heldMints).filter((mint) => !have.has(mint));
}

export function tapePrintStats(
  quotes: { lastPrintAgeSec?: number }[],
  freshSec: number,
): TapePrintStats {
  let missingPrint = 0;
  let stalePrint = 0;
  let freshPrint = 0;
  for (const quote of quotes) {
    const age = quote.lastPrintAgeSec;
    if (typeof age !== "number" || !Number.isFinite(age)) missingPrint += 1;
    else if (age > freshSec) stalePrint += 1;
    else freshPrint += 1;
  }
  return { names: quotes.length, missingPrint, stalePrint, freshPrint };
}
