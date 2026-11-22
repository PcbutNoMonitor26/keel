import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, FRESH_PRINT_SEC, MAX_IMPACT, PAPER_FEE, PUMP_CLIP_FRAC, emptyBook, planClip, scoreOf, equityOf, applyScan, marketBump, paperExit, manualClose, redeployClip, tapeFromCloses, keepScanPriceOverDex, quietTape } from "./engine.ts";
import { emptyLearn, recordOutcome } from "./learn.ts";

const token = {
  venue: "sol" as const, address: "So11111111111111111111111111111111111111112", symbol: "SOL", title: "Solana",
  price: 150, liq: 50000, vol1h: 40000, change1h: 2, change5m: 3, buys: 40, sells: 12,
  dex: "raydium", side: "long" as const, assetId: "", mins: 1, minutes: 0, edge: 0, fair: 0, endsAt: 0,
  lastPrintAgeSec: 1,
};

test("empty book starts with configured cash and no live positions", () => {
  const book = emptyBook();
  assert.equal(book.cash, DEFAULT_CONFIG.startingUsd);
  assert.equal(book.positions.length, 0);
  assert.equal(book.live, false);
  assert.equal(equityOf(book), DEFAULT_CONFIG.startingUsd);
});

test("open baseline paper positions are marked at net liquidation value", () => {
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1.2, vol1m: 0.2,
    quotes: [token], process: [], note: "",
  });
  assert.equal(opened.positions.length, 1);
  const position = opened.positions[0]!;
  assert.equal(position.markLiquidityUsd, token.liq);
  assert.ok(equityOf(opened) < opened.cash + position.sizeUsd,
    "open equity must include estimated exit impact and the 0.5% exit fee");
});

test("baseline realised PnL and learned outcomes include entry and exit fees", () => {
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1.2, vol1m: 0.2,
    quotes: [token], process: [], note: "",
  });
  const position = opened.positions[0]!;
  const exitOnly = paperExit(position.entry, position.mark, position.sizeUsd, position.markLiquidityUsd ?? 0);
  const closed = manualClose(opened, token.address);
  assert.ok(closed.realized < exitOnly.pnl, "realised PnL must also subtract the already-paid entry fee");
  assert.equal(closed.learn.netUsd, closed.realized);
  assert.equal(closed.learn.n, 1);
});

test("Solana token scoring uses liquidity and flow gates", () => {
  assert.ok(scoreOf(token, DEFAULT_CONFIG, "up").score >= 65);
  assert.equal(scoreOf({ ...token, liq: 10 }, DEFAULT_CONFIG, "up").score, 0);
});

test("clip plan respects reserve and position cap", () => {
  const book = emptyBook();
  const plan = planClip(book, token);
  assert.equal(plan.ok, true);
  if (plan.ok) assert.ok(book.cash - plan.clip - plan.clip * PAPER_FEE >= book.cash * 0.35 - 0.02);
  const full = { ...book, positions: Array.from({ length: book.config.maxPositions }, (_, i) => ({
    address: String(i), symbol: "X", venue: "sol" as const, side: "long" as const, sizeUsd: 1, entry: 1, mark: 1,
    score: 70, reasons: [], openedAt: 1, endsAt: 0, signature: "", rawOut: "", assetId: "",
  })) };
  assert.deepEqual(planClip(full, token), { ok: false, error: "book full" });
});

test("scan application updates SOL telemetry and Solana token tape", () => {
  const next = applyScan(emptyBook(), {
    at: 123, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1.2, vol1m: 0.2,
    quotes: [token], process: ["Solana scan"], note: "",
  });
  assert.equal(next.sol, 150);
  assert.equal(next.tokens.length, 1);
  assert.equal(next.tokens[0]?.venue, "sol");
});

test("Pump.fun launch candidates must pass age, liquidity, and trade-flow gates", () => {
  const launch = {
    ...token, dex: "pump.fun", pumpFun: true, ageMin: 4, minutes: 4,
    liq: 12000, buys: 16, sells: 7, change5m: 8, preMigration: true, uniqueTraders: 8,
  };
  const scored = scoreOf(launch, DEFAULT_CONFIG, "up");
  assert.ok(scored.score >= 65);
  assert.ok(scored.reasons.includes("pump.fun"));
  assert.equal(scoreOf({ ...launch, buys: 2, sells: 4 }, DEFAULT_CONFIG, "up").score, 0);
  assert.equal(scoreOf({ ...launch, sells: 0 }, DEFAULT_CONFIG, "up").score, 0);
  assert.equal(scoreOf({ ...launch, uniqueTraders: 3 }, DEFAULT_CONFIG, "up").score, 0);
  assert.equal(scoreOf({ ...launch, uniqueTraders: undefined }, DEFAULT_CONFIG, "up").score, 0);
  assert.equal(scoreOf({ ...launch, preMigration: undefined, uniqueTraders: undefined }, DEFAULT_CONFIG, "up").score, 0);
  assert.ok(scoreOf({ ...launch, preMigration: false, uniqueTraders: undefined }, DEFAULT_CONFIG, "up").score >= 65);
  assert.ok(scoreOf({ ...launch, uniqueTraders: 8 }, DEFAULT_CONFIG, "up").score >= 65);
  assert.equal(scoreOf({ ...launch, ageMin: 60 }, DEFAULT_CONFIG, "up").score, 0);
});

test("mayhem waits without prints and a live fill is the worse price", () => {
  const mayhem = {
    ...token, symbol: "MAYHEM", dex: "pumpswap", pumpFun: true, mayhem: true, ageMin: 1.2, minutes: 1.2,
    liq: 20_000, buys: 18, sells: 7, change5m: 6, preMigration: false, uniqueTraders: 9,
  };
  assert.equal(scoreOf({ ...mayhem, buys: 1, sells: 0, uniqueTraders: 1 }, DEFAULT_CONFIG, "up").score, 0);
  const scored = scoreOf(mayhem, DEFAULT_CONFIG, "up");
  assert.ok(scored.score >= 65);
  assert.ok(scored.reasons.includes("mayhem"));
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [mayhem], process: [], note: "",
  });
  assert.equal(opened.positions.length, 1);
  assert.ok((opened.positions[0]?.entry ?? 0) > mayhem.price);
  const closed = applyScan(opened, {
    at: 20_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [{ ...mayhem, price: mayhem.price * 1.2 }], process: [], note: "",
  });
  assert.equal(closed.positions.length, 0);
  assert.equal(closed.learn.n, 1);
  assert.match(closed.logs.map((l) => l.text).join("\n"), /not a fill/);
});

test("a book already down like a parked $174 session is flattened, not left open", () => {
  const book = emptyBook();
  book.peak = 200;
  book.cash = 153;
  book.positions = [{
    address: token.address, symbol: "SCAM", venue: "sol", side: "long", sizeUsd: 30, entry: 1, mark: 0.7,
    score: 70, reasons: ["live"], openedAt: 1, endsAt: 0, signature: "", rawOut: "", assetId: "",
  }];
  const next = applyScan(book, {
    at: 5_000, regime: "chop", sol: 90, ret1: 0, ret5: 0, sol15: 0.3, vol1m: 0.2,
    quotes: [{ ...token, symbol: "SCAM", price: 0.7 }], process: [], note: "",
  });
  assert.equal(next.halted, true);
  assert.equal(next.running, false);
  assert.equal(next.positions.length, 0);
  assert.ok(equityOf(next) > 160);
});

test("logged mayhem losses make the next mayhem score harder", () => {
  const mayhem = {
    ...token, symbol: "MAYHEM", dex: "pumpswap", pumpFun: true, mayhem: true, ageMin: 1.2, minutes: 1.2,
    liq: 20_000, buys: 18, sells: 7, change5m: 6, preMigration: false, uniqueTraders: 9,
  };
  let learn = emptyBook().learn;
  for (let i = 0; i < 6; i++) learn = recordOutcome(learn, ["mayhem"], -10, -2);
  const raw = scoreOf(mayhem, DEFAULT_CONFIG, "up");
  const taught = scoreOf(mayhem, DEFAULT_CONFIG, "up", learn);
  assert.ok(taught.score < raw.score);
  assert.equal(emptyLearn().n, 0);
});

test("baseline paper exit includes the conservative 0.5% venue fee", () => {
  const exit = paperExit(100, 100, 10, 1_000_000);
  assert.ok(Math.abs(exit.proceeds - 10 * (1 - exit.impact) * (1 - PAPER_FEE)) < 1e-12);
  assert.equal(PAPER_FEE, 0.005);
  assert.equal(DEFAULT_CONFIG.scoreFloor, 54);
  assert.equal(DEFAULT_CONFIG.maxPositions, 6);
});

test("a paper profit enlarges the next clip without spending the book", () => {
  const clip = redeployClip(5, 5.31, 205);
  assert.ok(clip > 5);
  assert.ok(clip <= 205 * 0.08 + 1e-9);
  assert.ok(clip < 100);
});

test("a five dollar book can take one clip and a soft market demands more", () => {
  const book = emptyBook();
  book.cash = 5;
  book.peak = 5;
  book.config = { ...book.config, startingUsd: 5 };
  const plan = planClip(book, token);
  assert.equal(plan.ok, true);
  if (plan.ok) assert.ok(plan.clip <= 1.01 && plan.clip >= 0.5);
  const opened = applyScan(book, {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [token], process: [], note: "",
  });
  const soft = applyScan({ ...book, regime: "down" }, {
    at: 1_000, regime: "down", sol: 150, ret1: -0.4, ret5: -1, sol15: -1, vol1m: 0.2,
    quotes: [token], process: [], note: "",
  });
  assert.ok(opened.positions.length >= soft.positions.length);
  assert.equal(marketBump("down"), 8);
});

test("a blank launch is named as having no prints, and a real early curve can be a trench", () => {
  const blank = {
    ...token, dex: "pump.fun", pumpFun: true, ageMin: 0.2, minutes: 0.2,
    liq: 0, buys: 0, sells: 0, change5m: 0, preMigration: true,
  };
  assert.deepEqual(scoreOf(blank, DEFAULT_CONFIG, "up").reasons, ["no prints yet"]);
  const trench = {
    ...token, dex: "pump.fun", pumpFun: true, ageMin: 1.2, minutes: 1.2,
    liq: 800, buys: 7, sells: 2, change5m: 9, preMigration: true, uniqueTraders: 5,
  };
  const scored = scoreOf({ ...trench, liq: 20_000 }, DEFAULT_CONFIG, "up");
  assert.ok(scored.score >= 65);
  assert.ok(scored.reasons.includes("trench"));
  // $800 is below the $1,400 floor, the old 1.25% scalpPays boundary for a $5 clip.
  // The 0.5% fee must not reopen that thinner path.
  assert.equal(scoreOf(trench, DEFAULT_CONFIG, "up").score, 0);
  assert.equal(scoreOf({ ...trench, liq: 1_200 }, DEFAULT_CONFIG, "up").score, 0);
  assert.equal(scoreOf({ ...trench, change5m: 80 }, DEFAULT_CONFIG, "up").score, 0);
});

test("one seller blocks that name, not the rest of the tape", () => {
  const dumped = {
    ...token,
    symbol: "DUMP",
    topTraderFlow: {
      signal: "negative" as const,
      buyAccounts: 0, sellAccounts: 4, buyUsd: 0, sellUsd: 900, tradeCount: 4,
      eligibleAccounts: 4, boardAgeMs: 1_000, observedAtMs: 1_000, reason: "net selling",
    },
  };
  const other = { ...token, address: "B11111111111111111111111111111111111111112", symbol: "OTHER" };
  assert.equal(scoreOf(dumped, DEFAULT_CONFIG, "up").score, 0);
  const next = applyScan(emptyBook(), {
    at: 5_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [dumped, other], process: [], note: "",
  });
  assert.equal(next.positions.length, 1);
  assert.equal(next.positions[0]?.symbol, "OTHER");
  assert.match(next.logs.map((l) => l.text).join("\n"), /top traders selling/);
});

test("the last minute can kill a name the longer move still likes", () => {
  const hot = {
    ...token, dex: "pump.fun", pumpFun: true, ageMin: 2, minutes: 2,
    liq: 20_000, buys: 20, sells: 6, change5m: 12, uniqueTraders: 8, preMigration: false,
  };
  assert.ok(scoreOf(hot, DEFAULT_CONFIG, "up").score > 0);
  assert.equal(scoreOf({ ...hot, shift1m: -16 }, DEFAULT_CONFIG, "up").score, 0);
  assert.equal(scoreOf({ ...hot, heat: 0.2 }, DEFAULT_CONFIG, "up").score, 0);
});

function pinned(mark: number, openedAt: number) {
  return {
    address: token.address, symbol: "FNUT", venue: "sol" as const, side: "long" as const, sizeUsd: 5, entry: 1, mark,
    score: 70, reasons: ["pinned"], openedAt, endsAt: 0, signature: "", rawOut: "", assetId: "",
    entryMid: 1, markLiquidityUsd: 50_000,
  };
}

test("a red clip on an unchanged mid is not fee-scratched at four seconds", () => {
  const book = emptyBook();
  book.running = true;
  book.realized = -1.59;
  book.cash = 198;
  book.positions = [pinned(1, 1_000)];
  const still = applyScan(book, {
    at: 6_000, regime: "chop", sol: 89, ret1: 0, ret5: 0, sol15: 0, vol1m: 0.2,
    quotes: [{ ...token, symbol: "FNUT", price: 1, liq: 50_000 }], process: [], note: "",
  });
  assert.equal(still.positions.length, 1, "stale mid at 5s is not a no-lift");
  assert.equal(still.running, true);
  const later = applyScan(still, {
    at: 22_000, regime: "chop", sol: 89, ret1: 0, ret5: 0, sol15: 0, vol1m: 0.2,
    quotes: [{ ...token, symbol: "FNUT", price: 1, liq: 50_000 }], process: [], note: "",
  });
  assert.equal(later.positions.length, 0, "unchanged mid still exits after 20s");
  assert.equal(later.running, true);
  assert.equal(later.halted, false);
});

test("a mid that has actually dropped is sold on the next pass", () => {
  const book = emptyBook();
  book.running = true;
  book.cash = 198;
  book.positions = [pinned(1, 1_000)];
  const next = applyScan(book, {
    at: 6_000, regime: "chop", sol: 89, ret1: 0, ret5: 0, sol15: 0, vol1m: 0.2,
    quotes: [{ ...token, symbol: "FNUT", price: 0.99, liq: 50_000 }], process: [], note: "",
  });
  assert.equal(next.positions.length, 0);
});

test("a mid that is up but still fee-red is held past four seconds", () => {
  const book = emptyBook();
  book.running = true;
  book.cash = 198;
  book.positions = [pinned(1, 1_000)];
  const next = applyScan(book, {
    at: 6_000, regime: "chop", sol: 89, ret1: 0, ret5: 0, sol15: 0, vol1m: 0.2,
    quotes: [{ ...token, symbol: "FNUT", price: 1.003, liq: 50_000 }], process: [], note: "",
  });
  assert.equal(next.positions.length, 1);
  const exit = paperExit(1, 1.003, 5, 50_000);
  assert.ok(exit.pnl - 5 * PAPER_FEE < 0, "precondition: 0.3% mid lift does not clear the 0.5% fee");
});

test("a curve whose impact would eat the 4% target is refused", () => {
  const pump = {
    ...token, dex: "pump.fun", pumpFun: true, ageMin: 4, minutes: 4,
    liq: 12_000, buys: 16, sells: 7, change5m: 8, uniqueTraders: 8, preMigration: true,
  };
  assert.ok(scoreOf(pump, DEFAULT_CONFIG, "up").score > 0);
  // $5 / $1,800 * 2 = 0.56% impact, above the 0.4% cap, still above the $1,400 trench floor.
  const tight = scoreOf({ ...pump, liq: 1_800 }, DEFAULT_CONFIG, "up");
  assert.equal(tight.score, 0);
  assert.match(tight.reasons.join(" "), /impact/);
  assert.ok(MAX_IMPACT === 0.004);
});

test("a name with no recent print is not bought", () => {
  const pump = {
    ...token, dex: "pump.fun", pumpFun: true, ageMin: 4, minutes: 4,
    liq: 12_000, buys: 16, sells: 7, change5m: 8, uniqueTraders: 8, preMigration: true,
    lastPrintAgeSec: 5,
  };
  assert.ok(scoreOf(pump, DEFAULT_CONFIG, "up").score > 0);
  assert.equal(scoreOf({ ...pump, lastPrintAgeSec: FRESH_PRINT_SEC + 1 }, DEFAULT_CONFIG, "up").score, 0);
  const missing = scoreOf({ ...pump, lastPrintAgeSec: undefined }, DEFAULT_CONFIG, "up");
  assert.equal(missing.score, 0, "a missing print age is a quiet tape");
  assert.equal(missing.reasons[0], quietTape({}));
  assert.equal(quietTape({}), "no print in 15s");
  assert.equal(quietTape({ lastPrintAgeSec: 5 }), null);
  assert.equal(quietTape({ lastPrintAgeSec: FRESH_PRINT_SEC + 1 }), "no print in 16s");
});

test("a chased pump or live tape of 18% or more is refused", () => {
  const pump = {
    ...token, dex: "pump.fun", pumpFun: true, ageMin: 4, minutes: 4,
    liq: 12_000, buys: 16, sells: 7, change5m: 8, uniqueTraders: 8, preMigration: true,
  };
  assert.ok(scoreOf(pump, DEFAULT_CONFIG, "up").score > 0);
  assert.equal(scoreOf({ ...pump, change5m: 18 }, DEFAULT_CONFIG, "up").score, 0);
  assert.equal(scoreOf({ ...pump, change5m: 8, shift1m: 25 }, DEFAULT_CONFIG, "up").score, 0);
  assert.ok(scoreOf({ ...pump, change5m: 12 }, DEFAULT_CONFIG, "up").score > 0);
  assert.equal(scoreOf({ ...token, change5m: 25 }, DEFAULT_CONFIG, "up").score, 0);
  assert.ok(scoreOf({ ...token, change5m: 8 }, DEFAULT_CONFIG, "up").score > 0);
});

test("a flat tape and a lane that already lost its fees are not taken", () => {
  const pump = {
    ...token, dex: "pump.fun", pumpFun: true, ageMin: 2, minutes: 2,
    liq: 20_000, buys: 20, sells: 6, change5m: 1, uniqueTraders: 8, preMigration: false,
  };
  assert.equal(scoreOf(pump, DEFAULT_CONFIG, "up").score, 0);
  const moving = { ...pump, change5m: 8 };
  assert.ok(scoreOf(moving, DEFAULT_CONFIG, "up").score > 0);
  let learn = emptyLearn();
  for (let i = 0; i < 8; i++) learn = recordOutcome(learn, ["pump"], -2.2, -0.3);
  assert.equal(scoreOf(moving, DEFAULT_CONFIG, "up", learn).score, 0);
});

test("a nonsense SOL print is refused and a real dip is a down day", () => {
  assert.equal(tapeFromCloses([0, 0, 0]), null);
  assert.equal(tapeFromCloses([1_000_000, 90, 90, 90, 90, 90]), null);
  const soft = tapeFromCloses([89, 89.2, 89.2, 89.2, 89.2, 89.4]);
  assert.equal(soft?.regime, "chop");
  const down = tapeFromCloses([88, 89, 89, 89, 89, 90]);
  assert.equal(down?.regime, "down");
});

test("a pump-lane clip is capped so one rug is about 1% of book", () => {
  const book = emptyBook();
  const pump = {
    ...token, symbol: "GTA6", dex: "pump.fun", pumpFun: true, ageMin: 4, minutes: 4,
    liq: 12000, buys: 16, sells: 7, change5m: 8, preMigration: true, uniqueTraders: 8,
  };
  const livePlan = planClip(book, token);
  const pumpPlan = planClip(book, pump);
  assert.equal(livePlan.ok, true);
  assert.equal(pumpPlan.ok, true);
  if (livePlan.ok) assert.ok(livePlan.clip > book.cash * PUMP_CLIP_FRAC, "live clips stay on the existing size path");
  if (pumpPlan.ok) {
    const cap = equityOf(book) * PUMP_CLIP_FRAC;
    assert.ok(pumpPlan.clip <= cap + 1e-9);
    const wiped = paperExit(1, 0.18, pumpPlan.clip, pump.liq);
    const entryFee = pumpPlan.clip * PAPER_FEE;
    assert.ok(-(wiped.pnl - entryFee) <= equityOf(book) * 0.01 + entryFee + 1e-6);
  }
  const tiny = emptyBook();
  tiny.cash = 50;
  tiny.peak = 50;
  tiny.config = { ...tiny.config, startingUsd: 50 };
  const refused = planClip(tiny, pump);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, "pump clip cap");
});

test("a first mark from a different venue re-anchors instead of scratching", () => {
  const live = { ...token, symbol: "MEME", price: 1.4837374893369056e-5, priceSource: "gecko" as const };
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [live], process: [], note: "",
  });
  assert.equal(opened.positions.length, 1);
  assert.equal(opened.positions[0]?.entrySource, "gecko");
  const dex = { ...live, price: live.price * 0.93, priceSource: "dex" as const };
  const marked = applyScan(opened, {
    at: 2_500, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [dex], process: [], note: "",
  });
  assert.equal(marked.positions.length, 1, "a gecko-to-dex basis gap is not a dump");
  assert.equal(marked.positions[0]?.sourceAnchored, true);
  assert.equal(marked.positions[0]?.entrySource, "dex");
  assert.equal(marked.positions[0]?.entryMid, dex.price);
  const later = applyScan(marked, {
    at: 4_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [{ ...dex, price: dex.price * 0.98 }], process: [], note: "",
  });
  assert.equal(later.positions.length, 0, "a later same-source drop still scratches");
});

test("a same-source mid drop still scratches immediately", () => {
  const live = { ...token, symbol: "MEME", price: 1.5e-5, priceSource: "curve" as const, lastPrintAgeSec: 0.4 };
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [live], process: [], note: "",
  });
  assert.equal(opened.positions.length, 1);
  const dropped = applyScan(opened, {
    at: 2_500, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [{ ...live, price: live.price * 0.93, lastPrintAgeSec: 0.2 }], process: [], note: "",
  });
  assert.equal(dropped.positions.length, 0);
});

test("a first unprinted gecko mid jump re-anchors instead of scratching or taking profit", () => {
  const live = { ...token, symbol: "MEME", price: 1.5e-5, priceSource: "gecko" as const };
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [live], process: [], note: "",
  });
  assert.equal(opened.positions.length, 1);
  const dump = applyScan(opened, {
    at: 2_500, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [{ ...live, price: live.price * 0.93, lastPrintAgeSec: undefined }], process: [], note: "",
  });
  assert.equal(dump.positions.length, 1, "an unprinted gecko drop is not a scratch");
  assert.equal(dump.positions[0]?.sourceAnchored, true);
  assert.equal(dump.positions[0]?.entryMid, live.price * 0.93);
  assert.equal(dump.positions[0]?.entrySource, "gecko");
  const pump = applyScan(opened, {
    at: 2_500, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [{ ...live, price: live.price * 1.35, lastPrintAgeSec: undefined }], process: [], note: "",
  });
  assert.equal(pump.positions.length, 1, "an unprinted gecko jump is not vitality");
  assert.equal(pump.positions[0]?.sourceAnchored, true);
  assert.equal(pump.positions[0]?.entryMid, live.price * 1.35);
});

test("a confirmed print drop still scratches after a gecko re-anchor", () => {
  const live = { ...token, symbol: "MEME", price: 1.5e-5, priceSource: "gecko" as const };
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [live], process: [], note: "",
  });
  const anchored = applyScan(opened, {
    at: 2_500, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [{ ...live, price: live.price * 0.99, lastPrintAgeSec: undefined }], process: [], note: "",
  });
  assert.equal(anchored.positions.length, 1);
  const printed = applyScan(anchored, {
    at: 4_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [{ ...live, price: live.price * 0.99 * 0.93, priceSource: "curve", lastPrintAgeSec: 0.3 }], process: [], note: "",
  });
  // First curve mark is a source switch, so it re-anchors if not already anchored.
  // Already sourceAnchored from the gecko jump, so a printed 7% drop must scratch.
  assert.equal(printed.positions.length, 0, "a confirmed print drop still scratches");
});

test("a gecko entry marked from a live curve re-anchors, then a printed 6% dump still scratches", () => {
  const gecko = { ...token, symbol: "HYPE", price: 3.48e-5, priceSource: "gecko" as const };
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [gecko], process: [], note: "",
  });
  assert.equal(opened.positions.length, 1);
  const curve = { ...gecko, price: gecko.price * 0.97, priceSource: "curve" as const, lastPrintAgeSec: 0.2, pumpFun: true, dex: "pump.fun" };
  const marked = applyScan(opened, {
    at: 3_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [curve], process: [], note: "",
  });
  assert.equal(marked.positions.length, 1, "first curve mark after a gecko entry re-anchors");
  assert.equal(marked.positions[0]?.sourceAnchored, true);
  assert.equal(marked.positions[0]?.entrySource, "curve");
  assert.equal(marked.positions[0]?.entryMid, curve.price);
  const dumped = applyScan(marked, {
    at: 5_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [{ ...curve, price: curve.price * 0.93, lastPrintAgeSec: 0.1 }], process: [], note: "",
  });
  assert.equal(dumped.positions.length, 0, "a confirmed print down 6%+ still scratches");
});

test("a fresh curve mid is not replaced by a DexScreener mark", () => {
  assert.equal(keepScanPriceOverDex({ price: 7.314736615855998e-6, priceSource: "curve" }, { priceSource: "dex" }), true);
  assert.equal(keepScanPriceOverDex({ price: 1.48e-5, priceSource: "gecko" }, { priceSource: "dex" }), true);
  assert.equal(keepScanPriceOverDex({ price: 1.45e-5, priceSource: "dex" }, { priceSource: "dex" }), false);
  assert.equal(keepScanPriceOverDex({ price: 1, priceSource: "curve" }, { priceSource: "curve" }), false);
});

