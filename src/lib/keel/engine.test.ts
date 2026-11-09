import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, emptyBook, planClip, scoreOf, equityOf, applyScan, marketBump, paperExit, manualClose, tapeFromCloses } from "./engine.ts";
import { emptyLearn, recordOutcome } from "./learn.ts";

const token = {
  venue: "sol" as const, address: "So11111111111111111111111111111111111111112", symbol: "SOL", title: "Solana",
  price: 150, liq: 50000, vol1h: 40000, change1h: 2, change5m: 3, buys: 40, sells: 12,
  dex: "raydium", side: "long" as const, assetId: "", mins: 1, minutes: 0, edge: 0, fair: 0, endsAt: 0,
};

test("empty paper book starts at zero P&L and no live positions", () => {
  const book = emptyBook();
  assert.equal(DEFAULT_CONFIG.startingUsd, 0);
  assert.equal(book.cash, 0);
  assert.equal(book.positions.length, 0);
  assert.equal(book.live, false);
  assert.equal(equityOf(book), 0);
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
    "open equity must include estimated exit impact and the 1.25% exit fee");
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

test("zero-seeded paper clip plan respects notional and position caps", () => {
  const book = emptyBook();
  assert.deepEqual(planClip(book, token), { ok: true, clip: 5 });
  assert.equal(book.cash, 0);
  const full = { ...book, positions: Array.from({ length: book.config.maxPositions }, (_, i) => ({
    address: String(i), symbol: "X", venue: "sol" as const, side: "long" as const, sizeUsd: 5, entry: 1, mark: 1,
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
    quotes: [{ ...mayhem, price: mayhem.price * 1.5 }], process: [], note: "",
  });
  assert.equal(closed.positions.length, 0);
  assert.equal(closed.learn.n, 1);
  assert.match(closed.logs.map((l) => l.text).join("\n"), /not a fill/);
});

test("a paper ledger past its absolute loss limit is flattened", () => {
  const book = emptyBook();
  book.cash = -10;
  book.realized = -10;
  book.positions = [{
    address: token.address, symbol: "SCAM", venue: "sol", side: "long", sizeUsd: 5, entry: 1, mark: 0.7,
    score: 70, reasons: ["live"], openedAt: 1, endsAt: 0, signature: "", rawOut: "", assetId: "",
    entryFee: 0.0625, markLiquidityUsd: 50,
  }];
  const next = applyScan(book, {
    at: 5_000, regime: "chop", sol: 90, ret1: 0, ret5: 0, sol15: 0.3, vol1m: 0.2,
    quotes: [{ ...token, symbol: "SCAM", price: 0.7 }], process: [], note: "",
  });
  assert.equal(next.halted, true);
  assert.equal(next.running, false);
  assert.equal(next.positions.length, 0);
  assert.ok(equityOf(next) < -8);
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

test("baseline paper exit includes the conservative 1.25% venue fee", () => {
  const exit = paperExit(100, 100, 10, 1_000_000);
  assert.ok(Math.abs(exit.proceeds - 10 * (1 - exit.impact) * 0.9875) < 1e-12);
});

test("paper notional does not compound with profit", () => {
  const book = emptyBook();
  book.cash = 50;
  book.realized = 50;
  assert.deepEqual(planClip(book, token), { ok: true, clip: 5 });
});

test("zero-seeded paper clip opens and down SOL blocks entries", () => {
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [token], process: [], note: "",
  });
  const soft = applyScan(emptyBook(), {
    at: 1_000, regime: "down", sol: 150, ret1: -0.4, ret5: -1, sol15: -1, vol1m: 0.2,
    quotes: [token], process: [], note: "",
  });
  assert.equal(opened.positions.length, 1);
  assert.equal(soft.positions.length, 0);
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
  assert.equal(scoreOf(trench, DEFAULT_CONFIG, "up").score, 0);
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

test("a red clip is sold once it has had four seconds and the host stays on", () => {
  const book = emptyBook();
  book.running = true;
  book.realized = -1.59;
  book.cash = -1.59;
  book.peak = 0;
  book.positions = [{
    address: token.address, symbol: "FNUT", venue: "sol", side: "long", sizeUsd: 5, entry: 1, mark: 1,
    score: 70, reasons: ["pinned"], openedAt: 1_000, endsAt: 0, signature: "", rawOut: "", assetId: "",
    entryMid: 1, markLiquidityUsd: 400,
  }];
  const next = applyScan(book, {
    at: 6_000, regime: "chop", sol: 89, ret1: 0, ret5: 0, sol15: 0, vol1m: 0.2,
    quotes: [{ ...token, symbol: "FNUT", price: 1, liq: 400 }], process: [], note: "",
  });
  assert.equal(next.positions.length, 0);
  assert.equal(next.running, true);
  assert.equal(next.halted, false);
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

test("missing SOL reference blocks paper entries", () => {
  const next = applyScan(emptyBook(), {
    at: 1_000, regime: "chop", sol: 0, ret1: 0, ret5: 0, sol15: 0, vol1m: 0,
    quotes: [token], process: [], note: "SOL reference unavailable",
  });
  assert.equal(next.positions.length, 0);
});

test("baseline keeps open positions when fresh quote is missing", () => {
  const opened = applyScan(emptyBook(), {
    at: 1_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [token], process: [], note: "",
  });
  const missing = applyScan(opened, {
    at: 20_000, regime: "up", sol: 150, ret1: 0.1, ret5: 0.4, sol15: 1, vol1m: 0.2,
    quotes: [], process: [], note: "held quote unavailable",
  });
  assert.equal(missing.positions.length, 1);
  assert.equal(missing.learn.n, 0);
});

test("a nonsense SOL print is refused and a real dip is a down day", () => {
  assert.equal(tapeFromCloses([0, 0, 0]), null);
  assert.equal(tapeFromCloses([1_000_000, 90, 90, 90, 90, 90]), null);
  const soft = tapeFromCloses([89, 89.2, 89.2, 89.2, 89.2, 89.4]);
  assert.equal(soft?.regime, "chop");
  const down = tapeFromCloses([88, 89, 89, 89, 89, 90]);
  assert.equal(down?.regime, "down");
});
