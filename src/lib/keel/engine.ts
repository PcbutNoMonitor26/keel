import { emptyLearn, featuresOf, laneAdjust, recordOutcome, type LearnState } from "./learn.ts";
import { emptyModel, modelAllows, noteSample, readingsOf, type ModelMemory } from "./model.ts";
import type { TopTraderFlow } from "./trader-intel.ts";

export type Regime = "up" | "down" | "chop";

export type Config = {
  pollSec: number;
  maxPositions: number;
  buyUsd: number;
  minLiq: number;
  slPct: number;
  tpPct: number;
  scoreFloor: number;
  startingUsd: number;
  autoSize: boolean;
};

export type Quote = {
  venue: "sol";
  address: string;
  symbol: string;
  title: string;
  price: number;
  liq: number;
  vol1h: number;
  change1h: number;
  change5m: number;
  buys: number;
  sells: number;
  dex: string;
  side: "long";
  assetId: string;
  mins: number;
  minutes: number;
  edge: number;
  fair: number;
  endsAt: number;
  pumpFun?: boolean;
  mayhem?: boolean;
  preMigration?: boolean;
  ageMin?: number;
  uniqueTraders?: number;
  topTraderFlow?: TopTraderFlow;
  shift1m?: number;
  heat?: number;
};

export type Token = Quote;

export type Position = {
  address: string;
  symbol: string;
  venue: "sol";
  side: "long";
  sizeUsd: number;
  entry: number;
  mark: number;
  score: number;
  reasons: string[];
  openedAt: number;
  endsAt: number;
  signature: string;
  rawOut: string;
  assetId: string;
  entryMid?: number;
  bestMid?: number;
  impactPct?: number;
  markLiquidityUsd?: number;
  entryFee?: number;
  features?: string[];
  readings?: number[];
};

export type LogLine = { t: number; kind: "info" | "skip" | "buy" | "sell"; text: string };
export type Staged = { action: "buy" | "sell"; address: string; symbol: string; why: string; user?: boolean };

export type Book = {
  config: Config;
  cash: number;
  realized: number;
  peak: number;
  positions: Position[];
  tokens: Token[];
  seen: string[];
  blocked: string[];
  logs: LogLine[];
  equity: { t: number; eq: number }[];
  staged: Staged[];
  process: string[];
  learn: LearnState;
  model: ModelMemory;
  now: number;
  regime: Regime;
  sol: number;
  ret1: number;
  ret5: number;
  sol15: number;
  vol1m: number;
  running: boolean;
  halted: boolean;
  live: boolean;
};

export type Scan = {
  at: number;
  regime: Regime;
  sol: number;
  ret1: number;
  ret5: number;
  sol15: number;
  vol1m: number;
  quotes: Quote[];
  process: string[];
  note: string;
};

export const SOL_MIN_USD = 1;
export const RESERVE = 0.35;
export const SESSION_BRAKE = 0.04;
export const MAX_SESSION_LOSS_USD = 8;
export const MAX_PAPER_CLIP_USD = 5;
export const MAX_PAPER_EXPOSURE_USD = 20;
const MAX_PAPER_HOLD_MS = 20 * 60_000;

export const DEFAULT_CONFIG: Config = {
  pollSec: 4,
  maxPositions: 4,
  buyUsd: 5,
  minLiq: 8_000,
  slPct: -20,
  tpPct: 40,
  scoreFloor: 62,
  startingUsd: 0,
  autoSize: true,
};

export function emptyBook(config: Config = DEFAULT_CONFIG): Book {
  return {
    config: { ...config },
    // cash is realized paper P&L, not spendable capital.
    cash: 0,
    realized: 0,
    peak: 0,
    positions: [],
    tokens: [],
    seen: [],
    blocked: [],
    logs: [],
    equity: [],
    staged: [],
    process: [],
    learn: emptyLearn(),
    model: emptyModel(),
    now: 0,
    regime: "chop",
    sol: 0,
    ret1: 0,
    ret5: 0,
    sol15: 0,
    vol1m: 0,
    running: true,
    halted: false,
    live: false,
  };
}

export function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const body = abs >= 1000 ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${n < 0 ? "-" : ""}$${body}`;
}

export function fmtSigned(n: number): string {
  const abs = Math.abs(n);
  const body = abs >= 1000 ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}$${body}`;
}

export function fmtRet(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function fmtPx(n: number): string {
  if (!(n > 0)) return "—";
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

export function fmtClock(t: number): string {
  if (!(t > 1e11)) return "—";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function pnlPct(p: Position): number {
  if (!(p.entry > 0) || !(p.sizeUsd > 0)) return 0;
  const exit = paperExit(p.entry, p.mark, p.sizeUsd, p.markLiquidityUsd ?? 0);
  const net = exit.pnl - (p.entryFee ?? fee(p.sizeUsd));
  return (net / p.sizeUsd) * 100;
}

export function coinMin(quotes: { mins: number }[]): number {
  const lots = quotes.map((q) => q.mins).filter((n) => n > 0);
  if (lots.length === 0) return SOL_MIN_USD;
  return Math.min(...lots);
}

export function riskFor(_eq: number): { minLot: number; heat: number; brake: number; slots: number; floorBump: number } {
  // P&L-only paper has no bankroll to size against; use fixed notional controls.
  return { minLot: SOL_MIN_USD, heat: 0.04, brake: SESSION_BRAKE, slots: 4, floorBump: 0 };
}

export function tapeFromCloses(closes: number[]): { regime: Regime; sol: number; ret1: number; ret5: number; sol15: number; vol1m: number } | null {
  const xs = closes.map((v) => Number(v)).filter((x) => Number.isFinite(x) && x > 0).slice(0, 16);
  const sol = xs[0] ?? 0;
  if (xs.length < 6 || !(sol > 5 && sol < 10_000)) return null;
  const pct = (now: number, prev: number) => (prev > 0 ? ((now - prev) / prev) * 100 : 0);
  const ret1 = pct(sol, xs[1] ?? sol);
  const ret5 = pct(sol, xs[5] ?? sol);
  const sol15 = pct(sol, xs[Math.min(15, xs.length - 1)] ?? sol);
  const rets = xs.slice(0, -1).map((x, i) => pct(x, xs[i + 1] ?? x));
  const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
  const vol1m = rets.length < 2 ? 0 : Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
  const regime: Regime = ret5 >= 0.8 ? "up" : ret5 <= -1.2 || ret1 <= -0.6 ? "down" : "chop";
  return { regime, sol, ret1, ret5, sol15, vol1m };
}

export function marketBump(regime: Regime): number {
  if (regime === "down") return 8;
  if (regime === "chop") return 4;
  return 0;
}

export function stopsFor(_eq: number, cfg: Config): { sl: number; tp: number; band: BandName; heat: number; risk: number; clip: number } {
  const requested = cfg.autoSize === false ? cfg.buyUsd : MAX_PAPER_CLIP_USD;
  const clip = Math.max(SOL_MIN_USD, Math.min(MAX_PAPER_CLIP_USD, Number.isFinite(requested) ? requested : MAX_PAPER_CLIP_USD));
  return { sl: cfg.slPct, tp: cfg.tpPct, band: "pocket", heat: 0.04, risk: 0.01, clip };
}

function liveMove(q: Quote): number {
  return typeof q.shift1m === "number" ? q.shift1m : q.change5m;
}

function cooled(q: Quote): boolean {
  return typeof q.heat === "number" && q.heat < 0.5 && (q.ageMin ?? q.minutes) > 1;
}

export function scoreOf(
  q: Quote,
  cfg: Config,
  regime: Regime,
  learn?: LearnState,
): { score: number; reasons: string[] } {
  if (!(q.price > 0) || !Number.isFinite(q.price) || q.price > 1_000_000) return { score: 0, reasons: ["bad quote"] };
  if (!Number.isFinite(q.liq) || q.liq < 0 || q.liq > 1e12) return { score: 0, reasons: ["bad quote"] };
  if (q.mayhem) {
    const age = q.ageMin ?? q.minutes;
    const move = liveMove(q);
    if (q.buys + q.sells === 0) return { score: 0, reasons: ["no prints yet"] };
    if (cooled(q)) return { score: 0, reasons: ["tape cooled"] };
    if (age < 0.25 || age > 8) return { score: 0, reasons: [`mayhem ${age.toFixed(1)}m`] };
    if (q.liq < 300) return { score: 0, reasons: [`mayhem curve ${fmtUsd(q.liq)}`] };
    if (q.change5m >= 22) return { score: 0, reasons: [`mayhem late +${q.change5m.toFixed(0)}%`] };
    if (move <= -12) return { score: 0, reasons: [`mayhem dump ${move.toFixed(0)}%`] };
    if (move < 3) return { score: 0, reasons: ["flat tape, the fee would take it"] };
    const wallets = (q.uniqueTraders ?? 0) >= 6 && q.buys >= 8 && q.sells >= 1 && q.buys > q.sells;
    const dexFlow = q.dex !== "pump.fun" && q.buys >= 8 && q.sells >= 2 && q.buys > q.sells;
    if (!wallets && !dexFlow) return { score: 0, reasons: ["mayhem waiting on wallet prints"] };
    let score = 64;
    const reasons = ["mayhem", `${age.toFixed(1)}m`];
    if ((q.uniqueTraders ?? 0) >= 6) {
      score += 10;
      reasons.push(`${q.uniqueTraders} wallets`);
    } else {
      score -= 6;
      reasons.push("wallet breadth unverified");
    }
    if (q.buys / Math.max(1, q.sells) >= 1.4) score += 8;
    if (age >= 0.5 && age <= 3) score += 6;
    if (move > 1 && move < 16) score += 6;
    if (q.liq >= 10_000) score += 4;
    return finish(Math.min(88, score), reasons, q, learn, cfg.buyUsd);
  }

  if (q.pumpFun) {
    const age = q.ageMin ?? q.minutes;
    const move = liveMove(q);
    if (q.buys + q.sells === 0) return { score: 0, reasons: ["no prints yet"] };
    if (cooled(q)) return { score: 0, reasons: ["tape cooled"] };
    if (age < 0.25 || age > 45) return { score: 0, reasons: [`${age < 1 ? Math.round(age * 60) + "s" : age.toFixed(0) + "m"} old`] };
    const trench = age <= 6
      && (q.uniqueTraders ?? 0) >= 4
      && q.buys >= 6
      && q.sells >= 1
      && q.buys > q.sells
      && move > -8
      && move < 22
      && q.liq >= 250
      && q.liq <= 40_000;
    if (q.liq < 2200 && !trench) return { score: 0, reasons: [`curve ${fmtUsd(q.liq)}`] };
    if (q.liq > 150000) return { score: 0, reasons: ["launch liquidity above discovery range"] };
    if (move >= 70) return { score: 0, reasons: [`blow-off +${move.toFixed(0)}%`] };
    if (move <= -15) return { score: 0, reasons: [`dump ${move.toFixed(0)}%`] };
    if (move < 3) return { score: 0, reasons: ["flat tape, the fee would take it"] };
    if (q.buys < 8 || q.sells < 2 || q.buys <= q.sells) {
      if (!trench) return { score: 0, reasons: [`flow ${q.buys}/${q.sells}`] };
    }
    if (q.preMigration !== false && (q.uniqueTraders ?? 0) < 5 && !trench) return { score: 0, reasons: [`wallet breadth ${q.uniqueTraders ?? 0}/5`] };
    let score = trench ? 72 : 60;
    const reasons = trench ? ["trench", "pump.fun", `${age < 1 ? Math.round(age * 60) + "s" : Math.round(age) + "m"}`] : ["pump.fun", `${Math.round(age)}m old`];
    if (q.buys >= 12) score += 10;
    if (q.sells > 0 && q.buys / q.sells >= 1.4) {
      score += 8;
      reasons.push(`${q.buys} buys`);
    }
    if (age >= 1 && age <= 18) score += 8;
    if (move > 3 && move < 22) {
      score += 8;
      reasons.push(`${typeof q.shift1m === "number" ? "last minute" : "from open"} +${move.toFixed(0)}%`);
    } else if (trench && move <= 2) {
      reasons.push("dip");
    }
    if (q.liq >= 8000) score += 6;
    return finish(score, reasons, q, learn, cfg.buyUsd);
  }

  if (cooled(q)) return { score: 0, reasons: ["tape cooled"] };
  const move = liveMove(q);
  if (q.liq < cfg.minLiq) return { score: 0, reasons: [`liq ${fmtUsd(q.liq)}`] };
  if (q.vol1h < 5000 && q.buys + q.sells < 40) return { score: 0, reasons: ["thin tape"] };
  if (move <= -8) return { score: 0, reasons: [`5m ${move.toFixed(0)}%`] };
  if (move < 3) return { score: 0, reasons: ["flat tape, the fee would take it"] };
  if (move >= 35) return { score: 0, reasons: [`blow-off +${move.toFixed(0)}%`] };
  if (q.sells > q.buys * 1.35 && q.sells > 20) return { score: 0, reasons: ["distribution"] };

  let score = 46;
  const reasons: string[] = [];
  if (q.buys > q.sells) {
    score += 14;
    reasons.push(`${q.buys} buys`);
  }
  if (move > 1 && move < 30) {
    score += 12;
    reasons.push(`${typeof q.shift1m === "number" ? "1m" : "5m"} +${move.toFixed(0)}%`);
  }
  if (q.vol1h > 20000) score += 8;
  if (q.dex === "pumpswap" || q.dex === "raydium") {
    score += 8;
    reasons.push(q.dex);
  }
  if (regime === "down") {
    score -= 8;
    reasons.push("SOL soft");
  }
  return finish(score, reasons, q, learn, cfg.buyUsd);
}

function finish(score: number, reasons: string[], q: Quote, learn: LearnState | undefined, sizeUsd: number): { score: number; reasons: string[] } {
  if (q.topTraderFlow?.signal === "negative") {
    return { score: 0, reasons: [`top traders selling · ${q.topTraderFlow.sellAccounts} accounts`] };
  }
  if (score > 0 && !scalpPays(sizeUsd, q.liq)) {
    return { score: 0, reasons: [`a 4% scalp does not clear costs on ${fmtUsd(q.liq)}`] };
  }
  let next = Math.max(0, Math.min(100, score));
  if (learn && next > 0) {
    const adj = laneAdjust(learn, featuresOf(q));
    if (adj.block) return { score: 0, reasons: [`${adj.note || "lane"} is not paying after fees`] };
    if (adj.penalty !== 0) {
      next = Math.max(0, Math.min(100, next - adj.penalty));
      reasons.push(`learned ${adj.penalty > 0 ? "+" : ""}${adj.penalty}`);
    }
  }
  return { score: next, reasons };
}

export function impactOf(sizeUsd: number, liq: number): number {
  if (!(liq > 0) || !(sizeUsd > 0)) return 0.08;
  return Math.min(0.08, (sizeUsd / liq) * 2);
}

export function paperExit(
  entry: number,
  mark: number,
  sizeUsd: number,
  liq: number,
): { exitPx: number; proceeds: number; pnl: number; pct: number; impact: number } {
  const impact = impactOf(sizeUsd, liq);
  const exitPx = mark > 0 ? mark * (1 - impact) : 0;
  const gross = entry > 0 ? sizeUsd * (exitPx / entry) : 0;
  const proceeds = Math.max(0, gross * 0.9875);
  const pnl = proceeds - sizeUsd;
  const pct = sizeUsd > 0 ? (pnl / sizeUsd) * 100 : 0;
  return { exitPx, proceeds, pnl, pct, impact };
}

export function scalpPays(sizeUsd: number, liq: number): boolean {
  if (!(sizeUsd > 0) || !(liq > 0)) return false;
  const impact = impactOf(sizeUsd, liq);
  const entry = 1 + impact;
  const exit = paperExit(entry, 1.04, sizeUsd, liq);
  return exit.pnl - sizeUsd * 0.0125 > 0;
}

function fee(size: number): number {
  return size * 0.0125;
}

function noted(book: Book, kind: LogLine["kind"], text: string) {
  if (book.logs.slice(0, 12).some((l) => l.text === text)) return;
  book.logs.unshift({ t: book.now, kind, text });
  if (book.logs.length > 80) book.logs.length = 80;
}

export function equityOf(book: Book): number {
  // Realized net P&L plus estimated net liquidation P&L for open positions.
  const open = book.positions.reduce((sum, p) => {
    const exit = paperExit(p.entry, p.mark, p.sizeUsd, p.markLiquidityUsd ?? 0);
    return sum + exit.pnl - (p.entryFee ?? fee(p.sizeUsd));
  }, 0);
  return book.cash + open;
}

export function planClip(book: Book, tok: Token): { ok: true; clip: number } | { ok: false; error: string } {
  if (!(tok.price > 0)) return { ok: false, error: "fresh positive price unavailable" };
  if (book.positions.some((p) => p.address === tok.address)) return { ok: false, error: "already open" };
  const maxPositions = Math.max(1, Math.min(4, Math.floor(book.config.maxPositions)));
  if (book.positions.length >= maxPositions) return { ok: false, error: "book full" };
  const floor = Math.max(SOL_MIN_USD, tok.mins > 0 ? tok.mins : SOL_MIN_USD);
  const requested = book.config.autoSize === false ? book.config.buyUsd : MAX_PAPER_CLIP_USD;
  const clip = Math.min(MAX_PAPER_CLIP_USD, Number.isFinite(requested) ? requested : MAX_PAPER_CLIP_USD);
  if (!(clip >= floor)) return { ok: false, error: `minimum lot ${fmtUsd(floor)} exceeds the ${fmtUsd(MAX_PAPER_CLIP_USD)} paper clip cap` };
  const openNotional = book.positions.reduce((sum, position) => sum + position.sizeUsd, 0);
  if (openNotional + clip > MAX_PAPER_EXPOSURE_USD + 1e-9) return { ok: false, error: "paper exposure cap reached" };
  if (!scalpPays(clip, tok.liq)) return { ok: false, error: "estimated impact and fees exceed the scalp hurdle" };
  return { ok: true, clip };
}

function close(book: Book, address: string, why: string, liq: number) {
  const p = book.positions.find((item) => item.address === address);
  if (!p || p.signature) return;
  const exit = paperExit(p.entry, p.mark, p.sizeUsd, liq || p.markLiquidityUsd || 0);
  const entryFee = p.entryFee ?? fee(p.sizeUsd);
  const pnl = exit.pnl - entryFee;
  book.cash += pnl;
  book.realized += pnl;
  book.positions = book.positions.filter((item) => item.address !== address);
  if (!book.seen.includes(address)) book.seen.push(address);
  const netPct = p.sizeUsd > 0 ? (pnl / p.sizeUsd) * 100 : 0;
  book.learn = recordOutcome(book.learn, p.features ?? [], netPct, pnl);
  if (p.readings?.length) {
    book.model = noteSample(book.model ?? emptyModel(), p.readings, netPct, book.now);
  }
  noted(book, "sell", `Closed ${p.symbol} · ${why}. Paper, not a fill.`);
}

export function blockName(book: Book, address: string, symbol: string): Book {
  const blocked = book.blocked ?? [];
  if (blocked.includes(address)) return book;
  const next: Book = {
    ...book,
    blocked: [...blocked, address].slice(-80),
    positions: book.positions.map((p) => ({ ...p, reasons: [...p.reasons] })),
    logs: book.logs.map((l) => ({ ...l })),
    seen: [...book.seen],
    now: book.now > 1e11 ? book.now : Date.now(),
  };
  const held = next.positions.find((p) => p.address === address);
  if (held && !held.signature) close(next, address, "blocked", held.markLiquidityUsd ?? 0);
  noted(next, "skip", `${symbol} blocked. It stays off the book.`);
  return next;
}

export function pinToBook(book: Book, tok: Token): Book {
  if (book.positions.some((p) => p.address === tok.address)) return book;
  const next: Book = {
    ...book,
    positions: book.positions.map((p) => ({ ...p, reasons: [...p.reasons] })),
    logs: book.logs.map((l) => ({ ...l })),
    seen: [...book.seen],
    tokens: book.tokens.some((t) => t.address === tok.address) ? book.tokens : [tok, ...book.tokens].slice(0, 40),
    blocked: (book.blocked ?? []).filter((address) => address !== tok.address),
    now: book.now > 1e11 ? book.now : Date.now(),
  };
  if (next.positions.length >= Math.max(1, Math.min(4, next.config.maxPositions))) {
    noted(next, "skip", "Paper book position cap reached. Close one before adding another.");
    return next;
  }
  if (!(next.sol > 0)) {
    noted(next, "skip", "SOL reference unavailable. Manual paper pin blocked.");
    return next;
  }
  const requested = next.config.autoSize === false ? next.config.buyUsd : MAX_PAPER_CLIP_USD;
  const clip = Math.min(MAX_PAPER_CLIP_USD, Number.isFinite(requested) ? requested : MAX_PAPER_CLIP_USD);
  const floor = Math.max(SOL_MIN_USD, tok.mins > 0 ? tok.mins : SOL_MIN_USD);
  if (clip < floor) {
    noted(next, "skip", `${tok.symbol} stays on the tape. Minimum lot exceeds the paper clip cap.`);
    return next;
  }
  if (next.positions.reduce((sum, position) => sum + position.sizeUsd, 0) + clip > MAX_PAPER_EXPOSURE_USD) {
    noted(next, "skip", `${tok.symbol} stays on the tape. Paper exposure cap reached.`);
    return next;
  }
  const slip = impactOf(clip, tok.liq);
  if (!(tok.liq > 0) || slip >= 0.03 || !scalpPays(clip, tok.liq)) {
    noted(next, "skip", `${tok.symbol} stays on the tape. The curve cannot pay a scalp.`);
    return next;
  }
  const entryFee = fee(clip);
  // Simulated notional is tracked on the position; cash is realized P&L only.
  next.positions.push({
    address: tok.address,
    symbol: tok.symbol,
    venue: tok.venue,
    side: tok.side,
    sizeUsd: clip,
    entry: tok.price > 0 ? tok.price * (1 + slip) : 0,
    mark: tok.price,
    score: 0,
    reasons: ["pinned"],
    openedAt: next.now,
    endsAt: 0,
    signature: "",
    rawOut: "",
    assetId: tok.assetId,
    entryMid: tok.price,
    bestMid: tok.price,
    impactPct: slip * 100,
    markLiquidityUsd: tok.liq,
    entryFee,
    features: featuresOf(tok),
    readings: readingsOf(tok, next.ret1, clip),
  });
  noted(next, "buy", `${tok.symbol} is in the book. It stays until you close it, or the mark turns green or fades.`);
  return next;
}

function tryBuy(book: Book, tok: Token, score: number, reasons: string[]) {
  const plan = planClip(book, tok);
  if (!plan.ok) {
    noted(book, "skip", `${tok.symbol} — ${plan.error}`);
    return;
  }
  const clip = plan.clip;
  const slip = impactOf(clip, tok.liq);
  if (!(tok.liq > 0) || slip >= 0.03 || !scalpPays(clip, tok.liq)) {
    noted(book, "skip", `${tok.symbol} — impact ${(slip * 100).toFixed(1)}% would eat the clip`);
    return;
  }
  const entryFee = fee(clip);
  // Simulated notional is tracked on the position; cash is realized P&L only.
  book.positions.push({
    address: tok.address,
    symbol: tok.symbol,
    venue: tok.venue,
    side: tok.side,
    sizeUsd: clip,
    entry: tok.price * (1 + slip),
    mark: tok.price,
    score,
    reasons,
    openedAt: book.now,
    endsAt: tok.endsAt,
    signature: "",
    rawOut: "",
    assetId: tok.assetId,
    entryMid: tok.price,
    bestMid: tok.price,
    impactPct: slip * 100,
    markLiquidityUsd: tok.liq,
    entryFee,
    features: featuresOf(tok),
    readings: readingsOf(tok, book.ret1, clip),
  });
  if (!book.seen.includes(tok.address)) book.seen.push(tok.address);
  noted(book, "buy", `${tok.symbol} ${fmtUsd(clip)} · ${score.toFixed(0)} · ${reasons.slice(0, 3).join(", ")}`);
}

export function applyScan(book: Book, scan: Scan): Book {
  const next: Book = {
    ...book,
    config: { ...book.config },
    tokens: scan.quotes.map((q) => ({ ...q })),
    positions: book.positions.map((p) => ({ ...p, reasons: [...p.reasons] })),
    seen: [...book.seen],
    blocked: [...(book.blocked ?? [])],
    logs: book.logs.map((l) => ({ ...l })),
    equity: book.equity.map((p) => ({ ...p })),
    staged: book.staged.filter((s) => s.user).map((s) => ({ ...s })),
    process: (scan.process ?? []).slice(0, 6),
    learn: book.learn?.buckets ? { ...book.learn, buckets: { ...book.learn.buckets } } : emptyLearn(),
    model: {
      samples: [...(book.model?.samples ?? [])],
      weights: book.model?.weights ?? null,
    },
    now: scan.at,
    regime: scan.regime,
    sol: scan.sol,
    ret1: scan.ret1,
    ret5: scan.ret5,
    sol15: scan.sol15,
    vol1m: scan.vol1m,
    live: book.live,
  };

  const byAddr = new Map(next.tokens.map((t) => [t.address, t]));
  for (const p of next.positions) {
    const tok = byAddr.get(p.address);
    if (tok && tok.price > 0) {
      p.mark = tok.price;
      p.markLiquidityUsd = tok.liq;
      p.bestMid = Math.max(p.bestMid ?? tok.price, tok.price);
    }
  }

  for (const p of [...next.positions]) {
    const tok = byAddr.get(p.address);
    if (!tok || tok.price <= 0) {
      noted(next, "skip", `${p.symbol} quote unavailable. Keeping the paper position open until a fresh mark arrives.`);
      continue;
    }
    const exit = paperExit(p.entry, p.mark, p.sizeUsd, tok.liq);
    const midChg = p.entryMid && p.entryMid > 0 ? ((tok.price / p.entryMid) - 1) * 100 : exit.pct;
    const age = p.openedAt > 0 ? next.now - p.openedAt : 0;
    const entryFee = p.entryFee ?? fee(p.sizeUsd);
    const netPnl = exit.pnl - entryFee;
    const netPct = p.sizeUsd > 0 ? (netPnl / p.sizeUsd) * 100 : 0;
    const target = netPct >= next.config.tpPct;
    const stopped = netPct <= next.config.slPct;
    const timedOut = age >= MAX_PAPER_HOLD_MS;
    const failed = exit.pnl < 0 && (age >= 4_000 || exit.impact >= 0.04 || midChg <= -0.8);
    if (!target && !stopped && !timedOut && !failed) continue;
    const why = target ? "target" : stopped ? "stop" : timedOut ? "time stop" : age >= 4_000 ? "no lift" : "scratch";
    if (p.signature) {
      if (!next.staged.some((s) => s.action === "sell" && s.address === p.address)) {
        next.staged.push({ action: "sell", address: p.address, symbol: p.symbol, why });
      }
      continue;
    }
    close(next, p.address, why, tok.liq);
  }

  const eqMarked = equityOf(next);
  if (eqMarked > next.peak) next.peak = eqMarked;
  const drawdownUsd = next.peak - eqMarked;
  if (drawdownUsd >= MAX_SESSION_LOSS_USD) {
    for (const p of [...next.positions]) {
      if (p.signature) continue;
      const tok = byAddr.get(p.address);
      if (!tok || !(tok.price > 0)) continue;
      close(next, p.address, "session brake", tok.liq);
    }
    next.running = false;
    next.halted = true;
    noted(next, "info", `Session brake: ${MAX_SESSION_LOSS_USD.toFixed(2)} peak-to-trough P&L loss. Book flattened.`);
  }

  if (!(next.sol > 0)) {
    noted(next, "skip", "SOL reference unavailable. New paper entries are paused.");
  } else if (next.regime === "down") {
    noted(next, "skip", "SOL is down hard. No scalp.");
  } else if (next.running && !next.halted && !next.staged.some((s) => s.action === "buy")) {
    const ranked: { tok: Token; score: number; reasons: string[] }[] = [];
    let modelBlock = "";
    let blockedSeller = "";
    for (const tok of next.tokens) {
      if (tok.price <= 0) continue;
      if (next.positions.some((p) => p.address === tok.address)) continue;
      if ((next.blocked ?? []).includes(tok.address)) continue;
      if (next.seen.includes(tok.address)) continue;
      if (next.staged.some((s) => s.address === tok.address)) continue;
      const scored = scoreOf(tok, next.config, next.regime, next.learn);
      const need = next.config.scoreFloor + marketBump(next.regime);
      if (scored.score < need) {
        if (!blockedSeller && scored.reasons.some((reason) => reason.includes("top traders selling"))) blockedSeller = tok.symbol;
        continue;
      }
      const call = modelAllows(next.model, readingsOf(tok, next.ret1, next.config.buyUsd));
      if (!call.ok) {
        if (!modelBlock) modelBlock = `${tok.symbol} model ${(call.p * 100).toFixed(0)}% against a scalp`;
        continue;
      }
      ranked.push({ tok, ...scored });
    }
    ranked.sort((a, b) => b.score - a.score);
    if (ranked.length === 0 && modelBlock) noted(next, "skip", modelBlock);
    if (blockedSeller) noted(next, "skip", `${blockedSeller} — top traders selling. That name only.`);
    for (const pick of ranked) {
      tryBuy(next, pick.tok, pick.score, pick.reasons);
      break;
    }
  }

  if (scan.note) noted(next, "info", scan.note);
  next.equity.push({ t: next.now, eq: equityOf(next) });
  if (next.equity.length > 240) next.equity.splice(0, next.equity.length - 240);
  return next;
}

export function manualClose(book: Book, address: string): Book {
  const next: Book = {
    ...book,
    positions: book.positions.map((p) => ({ ...p, reasons: [...p.reasons] })),
    logs: book.logs.map((l) => ({ ...l })),
    learn: book.learn?.buckets ? { ...book.learn, buckets: { ...book.learn.buckets } } : emptyLearn(),
    seen: [...book.seen],
    equity: book.equity.map((p) => ({ ...p })),
  };
  const tok = next.tokens.find((t) => t.address === address);
  close(next, address, "manual", tok?.liq ?? 0);
  return next;
}

export function manualBuy(book: Book, address: string): Book {
  const tok = book.tokens.find((t) => t.address === address);
  if (!tok) return book;
  const next: Book = {
    ...book,
    positions: book.positions.map((p) => ({ ...p, reasons: [...p.reasons] })),
    logs: book.logs.map((l) => ({ ...l })),
    seen: [...book.seen],
    learn: book.learn?.buckets ? { ...book.learn, buckets: { ...book.learn.buckets } } : emptyLearn(),
  };
  if (!(next.sol > 0)) {
    noted(next, "skip", "SOL reference unavailable. Manual paper buy blocked.");
    return next;
  }
  const scored = scoreOf(tok, next.config, next.regime, next.learn);
  if (scored.score < next.config.scoreFloor) {
    noted(next, "skip", `${tok.symbol} blocked · ${scored.reasons[0] ?? "gate"}`);
    return next;
  }
  tryBuy(next, tok, scored.score, scored.reasons);
  return next;
}

export function flatten(book: Book): Book {
  const next: Book = {
    ...book,
    positions: book.positions.map((p) => ({ ...p, reasons: [...p.reasons] })),
    logs: book.logs.map((l) => ({ ...l })),
    staged: book.staged.map((s) => ({ ...s })),
    seen: [...book.seen],
    learn: book.learn?.buckets ? { ...book.learn, buckets: { ...book.learn.buckets } } : emptyLearn(),
  };
  for (const p of [...next.positions]) {
    if (p.signature) {
      if (!next.staged.some((s) => s.action === "sell" && s.address === p.address)) {
        next.staged.push({ action: "sell", address: p.address, symbol: p.symbol, why: "flatten", user: true });
      }
      continue;
    }
    const tok = next.tokens.find((t) => t.address === p.address);
    close(next, p.address, "flatten", tok?.liq ?? p.markLiquidityUsd ?? 0);
  }
  next.running = false;
  return next;
}

export function commitLiveBuy(book: Book, address: string, signature: string, rawOut: string, _spent?: number): Book {
  const next: Book = {
    ...book,
    positions: book.positions.map((p) => ({ ...p, reasons: [...p.reasons] })),
    logs: book.logs.map((l) => ({ ...l })),
    staged: book.staged.filter((s) => !(s.action === "buy" && s.address === address)),
  };
  const p = next.positions.find((item) => item.address === address);
  if (p) {
    p.signature = signature;
    p.rawOut = rawOut;
    noted(next, "info", `Filled ${signature.slice(0, 8)}`);
  }
  return next;
}
