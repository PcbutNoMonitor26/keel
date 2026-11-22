import assert from "node:assert/strict";
import test from "node:test";
import { allowsLiveCurveOverlay, applySameSourceMarks, countMidTick, curveHeldMid, hasTapePrint, heldSourceOf, parseGeckoTokenPrices } from "./marks.ts";
import type { Quote } from "./engine.ts";

const base: Quote = {
  venue: "sol", address: "So11111111111111111111111111111111111111112", symbol: "SOL", title: "Solana",
  price: 1e-5, liq: 20_000, vol1h: 10_000, change1h: 1, change5m: 3, buys: 20, sells: 8,
  dex: "gecko", side: "long", assetId: "", mins: 1, minutes: 2, edge: 0, fair: 0, endsAt: 0,
  priceSource: "gecko",
};

test("curve held mid prefers the latest trade print over a stale snapshot", () => {
  const mid = curveHeldMid({
    lastPx: 1e-6,
    event: { vSolInBondingCurve: 40, vTokensInBondingCurve: 1_000_000 },
    prints: [
      { t: 1_000, px: 1.0e-6 },
      { t: 2_500, px: 1.2e-6 },
    ],
  }, 100, 3_000);
  assert.equal(mid.price, 1.2e-6);
  assert.equal(mid.lastPrintAgeSec, 0.5);
});

test("curve held mid falls back to the live curve when there are no prints", () => {
  const mid = curveHeldMid({
    event: { vSolInBondingCurve: 50, vTokensInBondingCurve: 1_000_000 },
  }, 80, 10_000);
  assert.equal(mid.price, (50 / 1_000_000) * 80);
  assert.equal(mid.lastPrintAgeSec, undefined);
});

test("same-source marks update a gecko mid and ignore a DexScreener print", () => {
  const quoted = [{ ...base, price: 1.48e-5, priceSource: "gecko" as const }];
  const ticked = applySameSourceMarks(quoted, [{ address: base.address, price: 1.50e-5, priceSource: "gecko" }]);
  assert.equal(ticked[0]?.price, 1.50e-5);
  assert.equal(ticked[0]?.priceSource, "gecko");
  const crossed = applySameSourceMarks(quoted, [{ address: base.address, price: 1.35e-5, priceSource: "dex" }]);
  assert.equal(crossed[0]?.price, 1.48e-5);
  assert.equal(crossed[0]?.priceSource, "gecko");
});

test("same-source marks update a curve mid from a later print", () => {
  const quoted = [{ ...base, dex: "pump.fun", pumpFun: true, price: 7.3147366e-6, priceSource: "curve" as const }];
  const ticked = applySameSourceMarks(quoted, [{ address: base.address, price: 7.40e-6, priceSource: "curve", lastPrintAgeSec: 0.4 }]);
  assert.equal(ticked[0]?.price, 7.40e-6);
  assert.equal(ticked[0]?.lastPrintAgeSec, 0.4);
});

test("parseGeckoTokenPrices reads the simple token_price payload", () => {
  const prices = parseGeckoTokenPrices({
    data: {
      id: "solana",
      type: "simple_token_price",
      attributes: { token_prices: { So11111111111111111111111111111111111111112: "0.0000149" } },
    },
  });
  assert.equal(prices.get("So11111111111111111111111111111111111111112"), 0.0000149);
});

test("held source prefers the entry tag, then the quote, then a live curve", () => {
  assert.equal(heldSourceOf({ address: "x", priceSource: "gecko" }, { priceSource: "curve" }, true), "gecko");
  assert.equal(heldSourceOf({ address: "x" }, { priceSource: "curve" }, false), "curve");
  assert.equal(heldSourceOf({ address: "x" }, {}, true), "curve");
  assert.equal(heldSourceOf({ address: "x" }, {}, false), undefined);
});

test("a live curve mark overlays a gecko entry mid and a DexScreener mark does not", () => {
  const quoted = [{ ...base, price: 1.48e-5, priceSource: "gecko" as const }];
  const curved = applySameSourceMarks(quoted, [{ address: base.address, price: 1.51e-5, priceSource: "curve", lastPrintAgeSec: 0.3 }]);
  assert.equal(curved[0]?.price, 1.51e-5);
  assert.equal(curved[0]?.priceSource, "curve");
  assert.equal(curved[0]?.lastPrintAgeSec, 0.3);
  const crossed = applySameSourceMarks(quoted, [{ address: base.address, price: 1.35e-5, priceSource: "dex" }]);
  assert.equal(crossed[0]?.price, 1.48e-5);
  assert.equal(crossed[0]?.priceSource, "gecko");
  assert.equal(allowsLiveCurveOverlay("gecko", "curve"), true);
  assert.equal(allowsLiveCurveOverlay("curve", "dex"), false);
});

test("countMidTick includes the exit poll", () => {
  const opened = countMidTick(undefined, 1.5e-5);
  assert.equal(opened.ticks, 0);
  const held = countMidTick(opened, 1.5e-5);
  assert.equal(held.ticks, 0);
  const closed = countMidTick(held, 1.5e-5 * 1.35);
  assert.equal(closed.ticks, 1);
  assert.equal(hasTapePrint({ lastPrintAgeSec: 0.4 }), true);
  assert.equal(hasTapePrint({}), false);
});
