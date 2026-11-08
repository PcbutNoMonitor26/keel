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

export const DEFAULT_CONFIG: Config = {
  pollSec: 4,
  maxPositions: 4,
  buyUsd: 5,
  minLiq: 8_000,
  slPct: -20,
  tpPct: 40,
  scoreFloor: 62,
  startingUsd: 200,
  autoSize: true,
};

type BandName = "pocket" | "keel" | "desk";

function bandOf(eq: number): { name: BandName; sl: number; tp: number; heat: number; risk: number } {
  if (eq < 40) return { name: "pocket", sl: -8, tp: 12, heat: 0.22, risk: 0.2 };
  if (eq < 2_000) return { name: "keel", sl: -12, tp: 18, heat: 0.04, risk: 0.04 };
  return { name: "desk", sl: -10, tp: 16, heat: 0.04, risk: 0.03 };
}

export function emptyBook(config: Config = DEFAULT_CONFIG): Book {
  return {
    config: { ...config },
    cash: config.startingUsd,
    realized: 0,
    peak: config.startingUsd,
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
  return p.entry > 0 ? ((p.mark / p.entry) - 1) * 100 : 0;
}

export function coinMin(quotes: { mins: number }[]): number {
  const lots = quotes.map((q) => q.mins).filter((n) => n > 0);
  if (lots.length === 0) return SOL_MIN_USD;
  return Math.min(...lots);
}

export function riskFor(eq: number): { minLot: number; heat: number; brake: number; slots: number; floorBump: number } {
  if (eq < 40) {
    const minLot = Math.min(SOL_MIN_USD, Math.max(0.5, Math.round(eq * 0.2 * 100) / 100));
    return { minLot, heat: 0.22, brake: 0.2, slots: 1, floorBump: 6 };
  }
  return { minLot: SOL_MIN_USD, heat: SESSION_BRAKE, brake: SESSION_BRAKE, slots: 1, floorBump: 0 };
}

export function redeployClip(base: number, profit: number, eq: number): number {
  const grown = base + Math.max(0, profit) * 0.5;
  const ceiling = Math.max(base, Math.max(0, eq) * 0.08);
  return Math.min(Math.max(base, grown), ceiling);
}

export function marketBump(regime: Regime): number {
  if (regime === "down") return 8;
  if (regime === "chop") return 4;
  return 0;
}

export function stopsFor(eq: number, cfg: Config): { sl: number; tp: number; band: BandName; heat: number; risk: number; clip: number } {
  const band = bandOf(eq);
  const risk = riskFor(eq);
  const sl = band.name === "keel" ? cfg.slPct : eq < 40 ? -8 : band.sl;
  const tp = band.name === "keel" ? cfg.tpPct : eq < 40 ? 12 : band.tp;
  const riskBudget = eq < 40 ? risk.minLot : Math.min(eq * band.risk, eq * SESSION_BRAKE);
  const base = cfg.autoSize === false ? Math.min(cfg.buyUsd, riskBudget) : riskBudget;
  const clip = redeployClip(base, eq - cfg.startingUsd, eq);
  return { sl, tp, band: band.name, heat: risk.heat, risk: band.risk, clip };
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
  if (q.mayhem) {
    const age = q.ageMin ?? q.minutes;
    const move = liveMove(q);
    if (q.buys + q.sells === 0) return { score: 0, reasons: ["no prints yet"] };
    if (cooled(q)) return { score: 0, reasons: ["tape cooled"] };
    if (age < 0.25 || age > 8) return { score: 0, reasons: [`mayhem ${age.toFixed(1)}m`] };
    if (q.liq < 300) return { score: 0, reasons: [`mayhem curve ${fmtUsd(q.liq)}`] };
    if (q.change5m >= 22) return { score: 0, reasons: [`mayhem late +${q.change5m.toFixed(0)}%`] };
    if (move <= -12) return { score: 0, reasons: [`mayhem dump ${move.toFixed(0)}%`] };
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
  const impact = liq > 0 ? impactOf(sizeUsd, liq) : 0.01;
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
  const open = book.positions.reduce((sum, p) => {
    const exit = paperExit(p.entry, p.mark, p.sizeUsd, p.markLiquidityUsd ?? 0);
    return sum + exit.proceeds;
  }, 0);
  return book.cash + open;
}

export function planClip(book: Book, tok: Token): { ok: true; clip: number } | { ok: false; error: string } {
  const eq = equityOf(book);
  const risk = riskFor(eq);
  if (book.positions.some((p) => p.address === tok.address)) return { ok: false, error: "already open" };
  if (book.positions.length >= Math.min(book.config.maxPositions, risk.slots)) return { ok: false, error: "book full" };
  const floor = Math.max(risk.minLot, tok.mins > 0 ? tok.mins : SOL_MIN_USD);
  const reserveCash = eq * (eq < 40 ? 0.2 : RESERVE);
  const budget = Math.max(0, (book.cash - reserveCash) / 1.0125);
  if (budget + 1e-9 < floor) return { ok: false, error: `${eq < 40 ? 20 : Math.round(RESERVE * 100)}% reserve holds ${fmtUsd(reserveCash)}` };
  const open = book.positions.reduce((s, p) => s + p.sizeUsd, 0);
  const budgeted = stopsFor(eq, book.config).clip;
  const heatCap = Math.max(risk.heat, Math.min(0.08, budgeted / Math.max(eq, 1)));
  const heatRoom = heatCap * eq - open;
  if (heatRoom + 1e-9 < floor) return { ok: false, error: `heat cap ${Math.round(heatCap * 100)}%` };
  const peak = Math.max(book.peak, eq);
  const lossRoom = Math.max(eq - peak * (1 - risk.brake), Math.min(budgeted, eq * 0.08));
  if (lossRoom + 1e-9 < floor) return { ok: false, error: "session brake" };
  const room = Math.min(budget, heatRoom, lossRoom);
  let clip = Math.min(budgeted, room, book.cash);
  if (book.positions.length >= 2) clip *= 0.5;
  if (clip < floor) {
    if (room + 1e-9 >= floor) clip = Math.min(floor, room);
    else return { ok: false, error: `min lot ${fmtUsd(floor)}` };
  }
  if (clip <= 0 || book.cash - clip - fee(clip) < reserveCash - 0.02) {
    return { ok: false, error: `would spend the ${Math.round(RESERVE * 100)}% reserve` };
  }
  if (book.cash < clip + fee(clip)) return { ok: false, error: `cash under ${fmtUsd(floor)}` };
  return { ok: true, clip };
}

function close(book: Book, address: string, why: string, liq: number) {
  const p = book.positions.find((item) => item.address === address);
  if (!p || p.signature) return;
  const exit = paperExit(p.entry, p.mark, p.sizeUsd, liq || p.markLiquidityUsd || 0);
  const entryFee = p.entryFee ?? fee(p.sizeUsd);
  const pnl = exit.pnl - entryFee;
  book.cash += exit.proceeds;
  book.realized += pnl;
  book.positions = book.positions.filter((item) => item.address !== address);
  if (!book.seen.includes(address)) book.seen.push(address);
  book.learn = recordOutcome(book.learn, p.features ?? [], exit.pct, pnl);
  if (p.readings?.length) {
    const pct = p.sizeUsd > 0 ? (pnl / p.sizeUsd) * 100 : 0;
    book.model = noteSample(book.model ?? emptyModel(), p.readings, pct, book.now);
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
  if (next.positions.length >= 12) {
    noted(next, "skip", "Book is holding 12 names. Close one before adding another.");
    return next;
  }
  const reserve = Math.max(0, equityOf(next) * 0.2);
  const room = Math.max(0, (next.cash - reserve) / 1.0125);
  const clip = Math.min(5, room);
  if (clip < 1) {
    noted(next, "skip", `${tok.symbol} stays on the tape. Cash is inside the reserve.`);
    return next;
  }
  const slip = impactOf(clip, tok.liq);
  if (!(tok.liq > 0) || slip >= 0.03 || !scalpPays(clip, tok.liq)) {
    noted(next, "skip", `${tok.symbol} stays on the tape. The curve cannot pay a scalp.`);
    return next;
  }
  const entryFee = fee(clip);
  next.cash -= clip + entryFee;
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
  book.cash -= clip + entryFee;
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
      const age = p.openedAt > 0 ? next.now - p.openedAt : 0;
      if (!p.signature && age >= 8_000 && p.mark > 0) {
        const stale = paperExit(p.entry, p.mark, p.sizeUsd, p.markLiquidityUsd || 0);
        if (stale.pnl <= 0) close(next, p.address, "no quote", p.markLiquidityUsd || 0);
      }
      continue;
    }
    const exit = paperExit(p.entry, p.mark, p.sizeUsd, tok.liq);
    const midChg = p.entryMid && p.entryMid > 0 ? ((tok.price / p.entryMid) - 1) * 100 : exit.pct;
    const age = p.openedAt > 0 ? next.now - p.openedAt : 0;
    const green = exit.pnl > 0;
    const failed = exit.pnl < 0 && (age >= 4_000 || exit.impact >= 0.04 || midChg <= -0.8);
    if (!green && !failed) continue;
    const why = green ? "vitality" : age >= 4_000 ? "no lift" : "scratch";
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
  const brake = riskFor(eqMarked).brake;
  const dd = next.peak > 0 ? (next.peak - eqMarked) / next.peak : 0;
  if (dd >= brake) {
    for (const p of [...next.positions]) {
      if (p.signature) continue;
      const tok = byAddr.get(p.address);
      close(next, p.address, "session brake", tok?.liq ?? 0);
    }
    next.running = false;
    next.halted = true;
    noted(next, "info", `Session brake ${Math.round(dd * 100)}%. Book flattened.`);
  }

  if (next.regime === "down") {
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
      const need = next.config.scoreFloor + riskFor(equityOf(next)).floorBump + marketBump(next.regime);
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
