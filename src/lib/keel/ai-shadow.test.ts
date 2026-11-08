import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type Quote, type Scan } from "./engine.ts";
import { emptyLearn, recordLane } from "./learn.ts";
import { advanceAiShadow, aiShadowStats, analyzeOpportunity, emptyAiShadow, executionSlippage, roundTripCost } from "./ai-shadow.ts";

const quote: Quote = {
  venue: "sol",
  address: "So11111111111111111111111111111111111111112",
  symbol: "TEST",
  title: "Test token",
  price: 100,
  liq: 50_000,
  vol1h: 40_000,
  change1h: 4,
  change5m: 8,
  buys: 40,
  sells: 12,
  dex: "raydium",
  side: "long",
  assetId: "",
  mins: 1,
  minutes: 0,
  edge: 0,
  fair: 0,
  endsAt: 0,
};

function scan(at: number, quotes: Quote[], regime: Scan["regime"] = "up"): Scan {
  return {
    at, regime, sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1.2, vol1m: 0.2,
    quotes, process: [], note: "",
  };
}

test("AI shadow execution costs increase as liquidity falls", () => {
  const deep = executionSlippage(5, 100_000);
  const thin = executionSlippage(5, 12_000);
  assert.ok(thin > deep);
  assert.ok(deep >= 0.003);
  assert.ok(thin <= 0.08);
  assert.equal(executionSlippage(5, 0), 0.08);
});

test("AI scorer identifies a strong candidate but labels decisions as paper-only", () => {
  const result = analyzeOpportunity(quote, DEFAULT_CONFIG, "up");
  assert.equal(result.decision, "PAPER_ENTRY");
  assert.ok(result.score >= 78);
  assert.equal(result.riskFlags.length, 0);
  assert.ok(result.unknowns.some((item) => item.includes("holder concentration")));
});

test("a clip whose round trip eats the target is not a paper entry", () => {
  const thin = analyzeOpportunity({ ...quote, liq: 150, pumpFun: true }, DEFAULT_CONFIG, "up");
  assert.ok(roundTripCost(5, 150) > 0.1);
  assert.notEqual(thin.decision, "PAPER_ENTRY");
  assert.ok(thin.riskFlags.some((flag) => flag.includes("eats")));
});

test("AI respects the configured baseline score floor", () => {
  const result = analyzeOpportunity(quote, { ...DEFAULT_CONFIG, scoreFloor: 95 }, "up");
  assert.notEqual(result.decision, "PAPER_ENTRY");
  assert.ok(result.riskFlags.some((flag) => flag.includes("configured floor")));
});

test("AI does not infer unique-wallet breadth from raw trade counts", () => {
  const unknown = analyzeOpportunity(quote, DEFAULT_CONFIG, "up");
  const verified = analyzeOpportunity({ ...quote, uniqueTraders: 20 }, DEFAULT_CONFIG, "up");
  assert.ok(verified.score > unknown.score);
  assert.ok(unknown.unknowns.some((item) => item.includes("trade counts are not a wallet-breadth proxy")));
});

test("pre-migration tokens without verified wallet breadth are rejected", () => {
  const result = analyzeOpportunity(
    { ...quote, pumpFun: true, preMigration: true, ageMin: 3, uniqueTraders: undefined },
    DEFAULT_CONFIG,
    "up",
  );
  assert.equal(result.decision, "REJECT");
  assert.ok(result.riskFlags.some((flag) => flag.includes("wallet breadth")));
});

test("AI shadow portfolio opens paper positions and never creates live execution data", () => {
  const next = advanceAiShadow(emptyAiShadow(), scan(1_000, [quote]), DEFAULT_CONFIG);
  assert.equal(next.mode, "shadow");
  assert.equal(next.positions.length, 1);
  assert.equal(next.positions[0]?.symbol, "TEST");
  assert.ok(next.cash < next.startingUsd);
  assert.ok(aiShadowStats(next).equity < next.startingUsd, "equity should include estimated exit impact and fees");
  assert.equal(next.positions[0]?.markLiquidityUsd, quote.liq);
  assert.equal("signature" in (next.positions[0] ?? {}), false);
  assert.equal(next.trades.length, 0);
});

test("AI shadow portfolio closes a paper position and records net outcome", () => {
  const opened = advanceAiShadow(emptyAiShadow(), scan(1_000, [quote]), DEFAULT_CONFIG);
  const closed = advanceAiShadow(opened, scan(2_000, [{ ...quote, price: 126 }]), DEFAULT_CONFIG);
  assert.equal(closed.positions.length, 0);
  assert.equal(closed.trades.length, 1);
  assert.equal(closed.trades[0]?.reason, "scalp");
  assert.ok((closed.trades[0]?.pnlUsd ?? 0) > 0);
  assert.ok(aiShadowStats(closed).closedTrades === 1);
});

test("AI shadow mode blocks new entries in a falling SOL regime", () => {
  const next = advanceAiShadow(emptyAiShadow(), scan(1_000, [quote], "down"), DEFAULT_CONFIG);
  assert.equal(next.positions.length, 0);
  assert.equal(next.signals[0]?.decision, "WATCH");
});

test("AI shadow mode flattens once the paper ledger gives back $8", () => {
  const opened = advanceAiShadow(emptyAiShadow(), scan(1_000, [quote]), DEFAULT_CONFIG);
  opened.cash = 180;
  opened.peak = 200;
  const crashed = advanceAiShadow(opened, scan(2_000, [quote]), DEFAULT_CONFIG);
  assert.equal(crashed.halted, true);
  assert.equal(crashed.positions.length, 0);
  assert.equal(crashed.trades[0]?.reason, "session brake");
  assert.ok((crashed.trades[0]?.features.length ?? 0) > 0);
});

test("AI shadow mode stops opening positions after its drawdown guard trips", () => {
  const seed = {
    ...emptyAiShadow(),
    cash: 170,
    peak: 200,
    halted: true,
  };
  const next = advanceAiShadow(seed, scan(1_000, [quote]), DEFAULT_CONFIG);
  assert.equal(next.positions.length, 0);
  assert.equal(next.halted, true);
});

test("AI shadow never exits a position using a stale price when a quote is missing", () => {
  const opened = advanceAiShadow(emptyAiShadow(), scan(1_000, [quote]), DEFAULT_CONFIG);
  const stale = advanceAiShadow(opened, scan(1_000 + 30 * 60_000, []), DEFAULT_CONFIG);
  assert.equal(stale.positions.length, 1);
  assert.equal(stale.trades.length, 0);
});
test("fresh weekly/monthly top-trader buying adds only a small score bonus", () => {
  const topTraderFlow = {
    signal: "positive" as const, buyAccounts: 4, sellAccounts: 1, buyUsd: 900, sellUsd: 100,
    tradeCount: 5, eligibleAccounts: 8, boardAgeMs: 60_000, observedAtMs: Date.now(), reason: "4 cohort accounts buying",
  };
  const plain = analyzeOpportunity(quote, DEFAULT_CONFIG, "up");
  const informed = analyzeOpportunity({ ...quote, topTraderFlow }, DEFAULT_CONFIG, "up");
  assert.equal(informed.decision, "PAPER_ENTRY");
  assert.equal(informed.score, plain.score + 3);
  assert.ok(informed.reasons.some((reason) => reason.includes("top-trader cohort positive")));
});

test("fresh top-trader selling rejects the name instead of rotating to it", () => {
  const topTraderFlow = {
    signal: "negative" as const, buyAccounts: 1, sellAccounts: 4, buyUsd: 100, sellUsd: 900,
    tradeCount: 5, eligibleAccounts: 8, boardAgeMs: 60_000, observedAtMs: Date.now(), reason: "4 cohort accounts selling",
  };
  const result = analyzeOpportunity({ ...quote, topTraderFlow }, DEFAULT_CONFIG, "up");
  assert.equal(result.decision, "REJECT");
  assert.ok(result.riskFlags.some((flag) => flag.includes("top traders selling")));
});

test("learned weak lanes reduce paper clip size without increasing risk", () => {
  let learn = emptyLearn();
  for (let i = 0; i < 3; i++) learn = recordLane(learn, ["live", "bid"], -4);
  // Keep the candidate comfortably above the entry threshold after the learned
  // penalty, so this test isolates sizing rather than testing the score gate.
  const strongQuote = {
    ...quote,
    uniqueTraders: 20,
    topTraderFlow: {
      signal: "positive" as const, buyAccounts: 4, sellAccounts: 1, buyUsd: 900, sellUsd: 100,
      tradeCount: 5, eligibleAccounts: 8, boardAgeMs: 60_000, observedAtMs: 1_000, reason: "4 cohort accounts buying",
    },
  };
  const plain = advanceAiShadow(emptyAiShadow(), scan(1_000, [strongQuote]), DEFAULT_CONFIG);
  const informed = advanceAiShadow(emptyAiShadow(), scan(1_000, [strongQuote]), DEFAULT_CONFIG, learn);
  assert.equal(informed.positions.length, 1);
  assert.equal(plain.positions.length, 1);
  assert.ok(informed.positions[0]!.sizeUsd < plain.positions[0]!.sizeUsd);
  assert.ok(informed.positions[0]!.sizeUsd <= 3.5);
  assert.equal(plain.positions[0]!.sizeUsd, 5);
});

test("AI paper equity charges conservative 1.25% fees on both sides", () => {
  const opened = advanceAiShadow(emptyAiShadow(), scan(1_000, [quote]), DEFAULT_CONFIG);
  const position = opened.positions[0]!;
  assert.equal(position.entryFee, 5 * 0.0125);
  const closed = advanceAiShadow(opened, scan(2_000, [{ ...quote, price: 126 }]), DEFAULT_CONFIG);
  const trade = closed.trades[0]!;
  const grossExit = position.sizeUsd * (trade.exit / trade.entry);
  assert.ok(trade.pnlUsd < grossExit - position.sizeUsd, "net PnL must deduct entry and exit fees");
});
