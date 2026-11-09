import { laneAdjust, featuresOf, type LearnState } from "./learn.ts";
import { redeployClip, scoreOf, type Config, type Quote, type Regime, type Scan } from "./engine.ts";
import { predict, readingsOf, type Weights } from "./model.ts";

export type AiDecision = "PAPER_ENTRY" | "WATCH" | "REJECT";
export type AiSignal = {
  at: number;
  address: string;
  symbol: string;
  score: number;
  decision: AiDecision;
  reasons: string[];
  riskFlags: string[];
  unknowns: string[];
};
export type AiPosition = {
  address: string;
  symbol: string;
  sizeUsd: number;
  entry: number;
  mark: number;
  score: number;
  openedAt: number;
  entryFee: number;
  markLiquidityUsd: number;
  features: string[];
};
export type AiTrade = {
  address: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  entry: number;
  exit: number;
  sizeUsd: number;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
  score: number;
  features: string[];
};
export type AiShadowState = {
  enabled: true;
  mode: "shadow";
  startingUsd: number;
  cash: number;
  realized: number;
  peak: number;
  halted: boolean;
  scans: number;
  lastAt: number;
  positions: AiPosition[];
  trades: AiTrade[];
  signals: AiSignal[];
};

// Conservative worst-case Pump.fun bonding-curve fee estimate per side.
const ENTRY_FEE = 0.0125;
const EXIT_FEE = 0.0125;
const BASE_SLIPPAGE = 0.003;
const MAX_EXECUTION_SLIPPAGE = 0.08;
const PAPER_CLIP_USD = 5;
const MAX_POSITIONS = 1;
const MIN_SCORE = 78;
const PAPER_LOSS_USD = 8;
const STOP_PCT = -10;
const TARGET_PCT = 18;
const MAX_HOLD_MS = 20 * 60_000;
const REENTRY_COOLDOWN_MS = 10 * 60_000;
const RESERVE_PCT = 0.35;

export function emptyAiShadow(startingUsd = 200): AiShadowState {
  return {
    enabled: true,
    mode: "shadow",
    startingUsd,
    cash: startingUsd,
    realized: 0,
    peak: startingUsd,
    halted: false,
    scans: 0,
    lastAt: 0,
    positions: [],
    trades: [],
    signals: [],
  };
}

// Include a base routing/price uncertainty allowance plus size-dependent
// price impact. This remains a paper estimate, not a guaranteed executable quote.
export function executionSlippage(sizeUsd: number, liquidityUsd: number): number {
  if (!(sizeUsd > 0) || !(liquidityUsd > 0)) return MAX_EXECUTION_SLIPPAGE;
  return Math.min(MAX_EXECUTION_SLIPPAGE, BASE_SLIPPAGE + (sizeUsd / liquidityUsd) * 2);
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

export function roundTripCost(sizeUsd: number, liquidityUsd: number): number {
  return ENTRY_FEE + EXIT_FEE + executionSlippage(sizeUsd, liquidityUsd) * 2;
}

export function analyzeOpportunity(
  q: Quote,
  cfg: Config,
  regime: Regime,
  learn?: LearnState,
  weights?: Weights | null,
  sol1m = 0,
): AiSignal {
  const baseline = scoreOf(q, cfg, regime);
  const riskFlags: string[] = [];
  if (baseline.score <= 0) riskFlags.push(...baseline.reasons);
  else if (baseline.score < cfg.scoreFloor) riskFlags.push(`baseline below configured floor (${baseline.score}/${cfg.scoreFloor})`);
  const trench = Boolean(q.pumpFun)
    && q.liq >= 250
    && q.liq < 12_000
    && (q.uniqueTraders ?? 0) >= 4
    && q.buys >= 6
    && q.sells >= 1
    && q.buys > q.sells
    && q.change5m > -8
    && q.change5m < 22;
  if (q.liq < 12_000 && !trench) riskFlags.push("liquidity below AI minimum ($12k)");
  if (q.preMigration === true && (q.uniqueTraders ?? 0) < 5) {
    riskFlags.push("pre-migration wallet breadth unverified (<5 unique traders)");
  }
  if (q.buys < 8 || q.sells < 2 || q.buys <= q.sells) riskFlags.push("insufficient verified buy-side flow");
  if (q.change5m <= -8) riskFlags.push("short-term momentum is deteriorating");
  if (q.change5m >= 35) riskFlags.push("overheated 5m move / blow-off risk");
  if (regime === "down") riskFlags.push("SOL market regime is down");
  if (q.topTraderFlow?.signal === "negative") {
    riskFlags.push(`weekly/monthly top-trader cohort is net selling (${q.topTraderFlow.sellAccounts} accounts)`);
  }
  const costPct = roundTripCost(PAPER_CLIP_USD, q.liq) * 100;
  const scalpPct = 4;
  if (!(scalpPct > costPct + 0.4)) riskFlags.push(`round trip ${costPct.toFixed(1)}% eats a ${scalpPct}% scalp`);

  const traderAdjustment = q.topTraderFlow?.signal === "positive" ? 3
    : q.topTraderFlow?.signal === "negative" ? -8
    : q.topTraderFlow?.signal === "mixed" ? -2 : 0;
  // One read of the tape. Liquidity, flow, and momentum already sit inside the baseline,
  // so they are not added again.
  const breadth = q.uniqueTraders == null ? 0 : q.uniqueTraders >= 8 ? 3 : 0;
  let score = baseline.score <= 0 ? 0 : Math.round(clamp(baseline.score + traderAdjustment + breadth));

  const reasons = [
    `baseline ${baseline.score}/100`,
    `after costs a ${scalpPct}% scalp versus ${costPct.toFixed(1)}% round trip`,
    `wallet breadth ${q.uniqueTraders == null ? "unverified" : q.uniqueTraders}`,
    `SOL regime ${regime}`,
    ...(q.topTraderFlow ? [`top-trader cohort ${q.topTraderFlow.signal}: ${q.topTraderFlow.reason}`] : ["top-trader cohort unavailable"]),
  ];
  if (learn && score > 0) {
    const adj = laneAdjust(learn, featuresOf(q));
    if (adj.block) {
      score = 0;
      riskFlags.push(`${adj.note || "lane"} is not paying after fees`);
    } else if (adj.penalty !== 0) {
      score = Math.round(clamp(score - adj.penalty));
      reasons.push(`learned ${adj.penalty > 0 ? "+" : ""}${adj.penalty}`);
    }
  }
  if (weights) {
    const p = predict(weights, readingsOf(q, sol1m, PAPER_CLIP_USD));
    if (p < 0.6) riskFlags.push(`model ${(p * 100).toFixed(0)}% against a scalp`);
  }
  if (score < MIN_SCORE) riskFlags.push("AI score below paper-entry threshold (78)");
  const decision: AiDecision = riskFlags.length > 0
    ? (baseline.score > 0 ? "WATCH" : "REJECT")
    : "PAPER_ENTRY";
  return {
    at: Date.now(),
    address: q.address,
    symbol: q.symbol,
    score,
    decision,
    reasons: decision === "PAPER_ENTRY" ? reasons : [...riskFlags, ...reasons].slice(0, 6),
    riskFlags,
    unknowns: [
      q.uniqueTraders == null
        ? "unique trader count unavailable; trade counts are not a wallet-breadth proxy"
        : "unique trader count is provider-reported and not independently verified",
      ...(!q.topTraderFlow ? ["repeat-wallet cohort has not formed on this name yet"] : []),
      "holder concentration and mint/freeze authority are not supplied by the public trade stream",
      "repeat-wallet reads come from Keel's own tape, not a paid leaderboard",
    ],
  };
}

function equityOf(state: AiShadowState): number {
  return state.cash + state.positions.reduce((sum, p) => {
    const exitHaircut = executionSlippage(p.sizeUsd, p.markLiquidityUsd);
    return sum + p.sizeUsd * (p.mark / p.entry) * (1 - exitHaircut) * (1 - EXIT_FEE);
  }, 0);
}

function recordSignal(state: AiShadowState, signal: AiSignal) {
  const previous = state.signals[0];
  if (
    previous &&
    previous.address === signal.address &&
    previous.decision === signal.decision &&
    Math.abs(previous.score - signal.score) < 3 &&
    signal.at - previous.at < 60_000
  ) return;
  state.signals.unshift(signal);
  if (state.signals.length > 30) state.signals.length = 30;
}

function closePosition(state: AiShadowState, p: AiPosition, at: number, reason: string, liquidityUsd: number) {
  const exit = p.mark * (1 - executionSlippage(p.sizeUsd, liquidityUsd));
  const proceeds = p.sizeUsd * (exit / p.entry) * (1 - EXIT_FEE);
  const pnlUsd = proceeds - p.sizeUsd - p.entryFee;
  state.cash += proceeds;
  state.realized += pnlUsd;
  state.positions = state.positions.filter((item) => item.address !== p.address);
  state.trades.unshift({
    address: p.address,
    symbol: p.symbol,
    openedAt: p.openedAt,
    closedAt: at,
    entry: p.entry,
    exit,
    sizeUsd: p.sizeUsd,
    pnlUsd,
    pnlPct: p.sizeUsd > 0 ? (pnlUsd / p.sizeUsd) * 100 : 0,
    reason,
    score: p.score,
    features: p.features ?? [],
  });
  if (state.trades.length > 200) state.trades.length = 200;
}

function recentlyClosed(state: AiShadowState, address: string, at: number): boolean {
  const trade = state.trades.find((item) => item.address === address);
  return Boolean(trade && at - trade.closedAt < REENTRY_COOLDOWN_MS);
}

export function advanceAiShadow(
  previous: AiShadowState,
  scan: Scan,
  cfg: Config,
  learn?: LearnState,
  weights?: Weights | null,
): AiShadowState {
  const state: AiShadowState = {
    ...previous,
    positions: previous.positions.map((p) => ({ ...p })),
    trades: [...previous.trades],
    signals: [...previous.signals],
    scans: previous.scans + 1,
    lastAt: scan.at,
  };
  const byAddress = new Map(scan.quotes.map((q) => [q.address, q]));
  for (const p of state.positions) {
    const quote = byAddress.get(p.address);
    if (quote && quote.price > 0) p.mark = quote.price;
  }

  for (const p of [...state.positions]) {
    // Never infer an exit from a stale mark. A fresh quote is required.
    if (!byAddress.has(p.address)) continue;
    const quote = byAddress.get(p.address);
    if (!quote || !(quote.price > 0)) continue;
    p.markLiquidityUsd = quote.liq;
    const slip = executionSlippage(p.sizeUsd, quote.liq);
    const midPaid = p.entry / (1 + slip);
    const change = midPaid > 0 ? (p.mark / midPaid - 1) * 100 : 0;
    const age = scan.at - p.openedAt;
    const proceeds = p.sizeUsd * (p.mark / p.entry) * (1 - slip) * (1 - EXIT_FEE);
    const pnl = proceeds - p.sizeUsd - p.entryFee;
    if (pnl > 0) closePosition(state, p, scan.at, "scalp", quote.liq);
    else if (pnl < 0 && (age >= 4_000 || slip >= 0.04 || change <= -0.8)) closePosition(state, p, scan.at, age >= 4_000 ? "no lift" : "scratch", quote.liq);
  }

  const equity = equityOf(state);
  if (equity > state.peak) state.peak = equity;
  const giveback = state.peak - equity;
  if (giveback >= PAPER_LOSS_USD) {
    for (const p of [...state.positions]) {
      const quote = byAddress.get(p.address);
      if (!quote || !(quote.price > 0)) continue;
      closePosition(state, p, scan.at, "session brake", quote.liq);
    }
    state.halted = true;
  }

  const ranked = scan.quotes
    .filter((q) => q.price > 0 && !state.positions.some((p) => p.address === q.address) && !recentlyClosed(state, q.address, scan.at))
    .map((q) => ({ ...analyzeOpportunity(q, cfg, scan.regime, learn, weights, scan.ret1), at: scan.at }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best) recordSignal(state, best);

  const net = equityOf(state) - state.startingUsd;
  if (!state.halted && net < -1) state.halted = true;

  if (!state.halted && best?.decision === "PAPER_ENTRY" && state.positions.length < MAX_POSITIONS) {
    const quote = byAddress.get(best.address);
    if (quote && quote.price > 0) {
      const markedEquity = equityOf(state);
      const reserve = markedEquity * RESERVE_PCT;
      const laneSizeMul = learn ? laneAdjust(learn, featuresOf(quote)).sizeMul : 1;
      const busy = state.positions.length >= 2;
      if (!(busy && best.score < MIN_SCORE + 8)) {
      const netNow = markedEquity - state.startingUsd;
      const base = state.startingUsd < 40 ? Math.min(1, Math.max(0.5, state.startingUsd * 0.2)) : PAPER_CLIP_USD;
      const clipCap = redeployClip(base, netNow, markedEquity);
      let clip = Math.min(clipCap * laneSizeMul, Math.max(0, (state.cash - reserve) / (1 + ENTRY_FEE)));
      if (busy) clip *= 0.5;
      const minClip = state.startingUsd < 40 ? clipCap : 1;
      if (clip + 1e-9 >= minClip && state.cash - clip * (1 + ENTRY_FEE) >= reserve - 0.01) {
        const slip = executionSlippage(clip, quote.liq);
        if (slip + 1e-9 < MAX_EXECUTION_SLIPPAGE) {
          const entryFee = clip * ENTRY_FEE;
          state.cash -= clip + entryFee;
          state.positions.push({
            address: quote.address,
            symbol: quote.symbol,
            sizeUsd: clip,
            entry: quote.price * (1 + slip),
            mark: quote.price,
            score: best.score,
            openedAt: scan.at,
            entryFee,
            markLiquidityUsd: quote.liq,
            features: featuresOf(quote),
          });
        }
      }
      }
    }
  }
  return state;
}

export function aiShadowStats(state: AiShadowState) {
  const wins = state.trades.filter((trade) => trade.pnlUsd > 0).length;
  const losses = state.trades.length - wins;
  const equity = equityOf(state);
  const winRate = state.trades.length > 0 ? (wins / state.trades.length) * 100 : 0;
  return {
    equity,
    netPnl: equity - state.startingUsd,
    winRate,
    wins,
    losses,
    closedTrades: state.trades.length,
    openTrades: state.positions.length,
    drawdownPct: state.peak > 0 ? ((state.peak - equity) / state.peak) * 100 : 0,
  };
}
