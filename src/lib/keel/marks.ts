import type { PriceSource, Quote } from "./engine.ts";

export type CurveLaunch = {
  lastPx?: number;
  event?: { vSolInBondingCurve?: number | string; vTokensInBondingCurve?: number | string };
  prints?: { t: number; px: number }[];
};

export type MidMark = {
  address: string;
  price: number;
  priceSource?: PriceSource;
  lastPrintAgeSec?: number;
  liq?: number;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function curvePxFromEvent(event: CurveLaunch["event"], solUsd: number): number {
  const vSol = n(event?.vSolInBondingCurve);
  const vTokens = n(event?.vTokensInBondingCurve);
  if (solUsd > 0 && vSol > 0 && vTokens > 0) {
    const px = (vSol / vTokens) * solUsd;
    return px > 0 && px < 1_000_000 ? px : 0;
  }
  return 0;
}

/** Latest mid from the live pump curve: newest trade print, else the curve snapshot. */
export function curveHeldMid(launch: CurveLaunch, solUsd: number, now: number): { price: number; lastPrintAgeSec?: number } {
  const prints = launch.prints ?? [];
  const last = prints[prints.length - 1];
  if (last && last.px > 0) {
    return { price: last.px, lastPrintAgeSec: Math.max(0, (now - last.t) / 1000) };
  }
  const live = curvePxFromEvent(launch.event, solUsd) || (launch.lastPx ?? 0);
  return { price: live > 0 ? live : 0 };
}

/** Gecko simple token_price payload → address -> usd. */
export function parseGeckoTokenPrices(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!body || typeof body !== "object") return out;
  const data = (body as { data?: unknown }).data;
  const bags: unknown[] = [];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const attrs = (data as { attributes?: { token_prices?: unknown } }).attributes;
    if (attrs?.token_prices) bags.push(attrs.token_prices);
  }
  if (Array.isArray(data)) {
    for (const row of data) {
      if (row && typeof row === "object") {
        const attrs = (row as { attributes?: { token_prices?: unknown; price_usd?: unknown } }).attributes;
        if (attrs?.token_prices) bags.push(attrs.token_prices);
        const id = String((row as { id?: unknown }).id ?? "").replace(/^solana_/i, "");
        const px = n(attrs?.price_usd);
        if (id && px > 0) out.set(id, px);
      }
    }
  }
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    for (const [addr, value] of Object.entries(bag as Record<string, unknown>)) {
      const mint = addr.replace(/^solana_/i, "");
      const px = n(value);
      if (mint && px > 0) out.set(mint, px);
    }
  }
  return out;
}

export function applySameSourceMarks(quotes: Quote[], marks: MidMark[]): Quote[] {
  const byAddress = new Map(quotes.map((quote) => [quote.address, { ...quote }]));
  for (const mark of marks) {
    if (!(mark.price > 0) || !mark.address) continue;
    const prev = byAddress.get(mark.address);
    if (!prev) {
      if ("venue" in mark && (mark as Quote).venue) byAddress.set(mark.address, { ...(mark as Quote) });
      continue;
    }
    if (prev.priceSource && mark.priceSource && prev.priceSource !== mark.priceSource && !allowsLiveCurveOverlay(prev.priceSource, mark.priceSource)) continue;
    byAddress.set(mark.address, {
      ...prev,
      price: mark.price,
      liq: mark.liq && mark.liq > 0 ? mark.liq : prev.liq,
      priceSource: mark.priceSource ?? prev.priceSource,
      lastPrintAgeSec: mark.lastPrintAgeSec ?? prev.lastPrintAgeSec,
    });
  }
  return [...byAddress.values()];
}

export function heldSourceOf(
  held: { address: string; priceSource?: PriceSource },
  quote?: { priceSource?: PriceSource },
  onCurve?: boolean,
): PriceSource | undefined {
  if (held.priceSource === "curve" || held.priceSource === "gecko" || held.priceSource === "dex") return held.priceSource;
  if (quote?.priceSource === "curve" || quote?.priceSource === "gecko" || quote?.priceSource === "dex") return quote.priceSource;
  if (onCurve) return "curve";
  return undefined;
}

/** Live pump prints / curve state may overlay a gecko (or dex) entry mid. Dex may not overlay either. */
export function allowsLiveCurveOverlay(prev?: PriceSource, mark?: PriceSource): boolean {
  return mark === "curve" && prev !== "curve";
}

export function hasTapePrint(tok: { lastPrintAgeSec?: number }): boolean {
  return typeof tok.lastPrintAgeSec === "number" && Number.isFinite(tok.lastPrintAgeSec);
}

/** Count a mid change, including the poll that closes the hold. */
export function countMidTick(prev: { last: number; ticks: number } | undefined, mid: number): { last: number; ticks: number } {
  if (!prev) return { last: mid > 0 ? mid : 0, ticks: 0 };
  if (mid > 0 && prev.last > 0 && Math.abs(mid / prev.last - 1) > 1e-9) return { last: mid, ticks: prev.ticks + 1 };
  return { last: prev.last, ticks: prev.ticks };
}
