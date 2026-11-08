import assert from "node:assert/strict";
import test from "node:test";
import { cohortFromTape, evaluateTopTraderFlow, settleTape, type TapePrint } from "./trader-intel.ts";

const now = Date.parse("2026-11-07T18:00:00.000Z");
const mint = "So11111111111111111111111111111111111111112";
const base = {
  mint,
  boardsBuiltAtMs: now - 60_000,
  generatedAtMs: now - 5_000,
  traders: [
    { userId: "a", periods: ["weekly", "monthly"] },
    { userId: "b", periods: ["weekly", "monthly"] },
    { userId: "c", periods: ["weekly", "monthly"] },
    { userId: "daily-only", periods: ["daily"] },
  ],
};

test("Keel tape promotes a wallet only after it has been right more than once", () => {
  const book = new Map<string, { seen: number; good: number; bad: number }>();
  const early: TapePrint = { wallet: "wallet-a", side: "buy", usd: 20, at: now - 80_000, px: 1, mint };
  settleTape(book, early, 1.05);
  const again: TapePrint = { wallet: "wallet-a", side: "buy", usd: 25, at: now - 70_000, px: 1, mint };
  settleTape(book, again, 1.08);
  const other: TapePrint = { wallet: "wallet-b", side: "buy", usd: 30, at: now - 60_000, px: 1, mint };
  settleTape(book, other, 1.04);
  settleTape(book, { ...other, at: now - 50_000 }, 1.06);
  const flow = cohortFromTape(book, [
    { wallet: "wallet-a", side: "buy", usd: 40, at: now - 10_000, px: 1.1, mint },
    { wallet: "wallet-b", side: "buy", usd: 35, at: now - 8_000, px: 1.1, mint },
  ], now);
  assert.equal(flow?.signal, "positive");
  assert.equal(flow?.buyAccounts, 2);
  const fresh = cohortFromTape(new Map(), [
    { wallet: "new", side: "buy", usd: 100, at: now - 1_000, px: 1, mint },
  ], now);
  assert.equal(fresh, null);
});

test("positive signal requires distinct traders ranked on both weekly and monthly boards", () => {
  const trades = ["a", "b", "c"].map((userId, i) => ({
    mint, userId, isBuy: true, timestamp: new Date(now - i * 1000).toISOString(), amountUsd: 100,
  }));
  const result = evaluateTopTraderFlow({ ...base, trades }, mint, now);
  assert.equal(result.signal, "positive");
  assert.equal(result.buyAccounts, 3);
  assert.equal(result.eligibleAccounts, 3);
});

test("daily-only or single-period leaderboard members do not qualify as durable cohort", () => {
  const result = evaluateTopTraderFlow({
    ...base,
    traders: [{ userId: "daily-only", periods: ["daily"] }],
    trades: [{ mint, userId: "daily-only", isBuy: true, timestamp: new Date(now).toISOString(), amountUsd: 500 }],
  }, mint, now);
  assert.equal(result.signal, "unknown");
});

test("stale board and stale trades are not interpreted as negative flow", () => {
  const stale = evaluateTopTraderFlow({ ...base, boardsBuiltAtMs: now - 7 * 60 * 60_000 }, mint, now);
  assert.equal(stale.signal, "unknown");
  const oldTrade = evaluateTopTraderFlow({
    ...base,
    trades: [{ mint, userId: "a", isBuy: false, timestamp: new Date(now - 6 * 60_000).toISOString(), amountUsd: 900 }],
  }, mint, now);
  assert.equal(oldTrade.signal, "unknown");
});

test("negative signal requires distinct top traders selling with meaningful notional", () => {
  const trades = ["a", "b", "c"].map((userId, i) => ({
    mint, userId, isBuy: false, timestamp: new Date(now - i * 1000).toISOString(), amountUsd: 100,
  }));
  const result = evaluateTopTraderFlow({ ...base, trades }, mint, now);
  assert.equal(result.signal, "negative");
  assert.equal(result.sellAccounts, 3);
});

test("mismatched mint and future-dated trades are ignored", () => {
  const wrong = evaluateTopTraderFlow({ ...base, mint: "wrong" }, mint, now);
  assert.equal(wrong.signal, "unknown");
  const result = evaluateTopTraderFlow({
    ...base,
    trades: [{ mint, userId: "a", isBuy: true, timestamp: new Date(now + 60_000).toISOString(), amountUsd: 1000 }],
  }, mint, now);
  assert.equal(result.signal, "unknown");
});
