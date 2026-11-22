import assert from "node:assert/strict";
import test from "node:test";
import {
  canSubscribeTokenTrades,
  chunkKeys,
  isTradeSubscribeDenied,
  newTradeSubscribeKeys,
  pumpStreamUrl,
  PUMP_STREAM_BASE,
  tapePrintStats,
  tradeSubscribeKeys,
  TRADE_SUBSCRIBE_CHUNK,
} from "./pump-feed.ts";

test("trade subscribe keys include every tape mint, not only held, and do not cap at 80", () => {
  const tape = Array.from({ length: 125 }, (_, i) => `tape${i}`);
  const held = ["heldA", "tape0"];
  const keys = tradeSubscribeKeys(tape, held);
  assert.equal(keys.length, 126);
  assert.equal(keys[0], "heldA");
  assert.ok(keys.includes("tape124"));
  assert.ok(keys.includes("tape0"));
  assert.equal(new Set(keys).size, 126);
  assert.ok(keys.length > 80);
});

test("only unsubscribed tape mints are queued for subscribeTokenTrade", () => {
  const fresh = newTradeSubscribeKeys(["a", "b", "c"], ["held"], ["a", "held"]);
  assert.deepEqual(fresh, ["b", "c"]);
  assert.equal(chunkKeys(Array.from({ length: 450 }, (_, i) => String(i))).length, Math.ceil(450 / TRADE_SUBSCRIBE_CHUNK));
});

test("the trade stream URL stays keyless unless an API key is provided", () => {
  assert.equal(pumpStreamUrl(), PUMP_STREAM_BASE);
  assert.equal(pumpStreamUrl("  "), PUMP_STREAM_BASE);
  assert.equal(pumpStreamUrl("test-key"), `${PUMP_STREAM_BASE}?api-key=test-key`);
  assert.equal(canSubscribeTokenTrades(undefined, false), false);
  assert.equal(canSubscribeTokenTrades("test-key", false), true);
  assert.equal(canSubscribeTokenTrades("test-key", true), false);
});

test("PumpPortal denial of keyless subscribeTokenTrade is detected", () => {
  assert.equal(isTradeSubscribeDenied({
    message: "'subscribeTokenTrade' and 'subscribeAccountTrade' methods are only available when connecting with an API key funded with at least 0.02 SOL.",
  }), true);
  assert.equal(isTradeSubscribeDenied({ message: "Successfully subscribed to token creation events." }), false);
});

test("pre-filter tape stats split missing, stale, and fresh prints", () => {
  const stats = tapePrintStats([
    {},
    { lastPrintAgeSec: undefined },
    { lastPrintAgeSec: 16 },
    { lastPrintAgeSec: 15 },
    { lastPrintAgeSec: 0.4 },
  ], 15);
  assert.deepEqual(stats, { names: 5, missingPrint: 2, stalePrint: 1, freshPrint: 2 });
});
