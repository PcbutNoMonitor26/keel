import assert from "node:assert/strict";
import test from "node:test";
import { emptyModel, modelAllows, noteSample, predict, readingsOf } from "./model.ts";

test("a short ledger does not invent weights", () => {
  let memory = emptyModel();
  for (let i = 0; i < 10; i++) memory = noteSample(memory, [1, 1, 1, 2, 0.2, 0.4, 0.2], 3, i);
  assert.equal(memory.weights, null);
  assert.equal(modelAllows(memory, [1, 1, 1, 2, 0.2, 0.4, 0.2]).ok, true);
});

test("weights turn on only when the later window is still green", () => {
  let memory = emptyModel();
  for (let i = 0; i < 100; i++) {
    const good = i % 2 === 0;
    const x = good ? [2, 0.6, 1.5, 2, 0.4, 0.3, 0.4] : [0.2, -0.4, 0.1, 0.3, -0.8, -0.5, 2];
    memory = noteSample(memory, x, good ? 4 : -3, i);
  }
  assert.ok(memory.weights);
  assert.ok((memory.weights?.holdoutAvg ?? 0) > 0);
  const yes = predict(memory.weights!, [2, 0.6, 1.5, 2, 0.4, 0.3, 0.4]);
  const no = predict(memory.weights!, [0.2, -0.4, 0.1, 0.3, -0.8, -0.5, 2]);
  assert.ok(yes > no);
});

test("a later window of losses drops the weights", () => {
  let memory = emptyModel();
  for (let i = 0; i < 60; i++) memory = noteSample(memory, [2, 0.5, 1, 2, 0.2, 0.2, 0.3], 4, i);
  for (let i = 60; i < 100; i++) memory = noteSample(memory, [2, 0.5, 1, 2, 0.2, 0.2, 0.3], -4, i);
  assert.equal(memory.weights, null);
});

test("readings stay in a fixed band", () => {
  const x = readingsOf({ buys: 20, sells: 8, uniqueTraders: 9, liq: 20_000, change5m: 6, ageMin: 2 }, 0.4, 5);
  assert.equal(x.length, 7);
  for (const n of x) assert.ok(n >= -3 && n <= 4);
});
