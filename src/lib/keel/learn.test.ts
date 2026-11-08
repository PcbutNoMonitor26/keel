import assert from "node:assert/strict";
import test from "node:test";
import { emptyLearn, featuresOf, laneAdjust, learnSummary, proofLine, recordLane, recordOutcome } from "./learn.ts";

test("a losing mayhem lane raises the next score and shrinks the next clip", () => {
  let learn = emptyLearn();
  for (let i = 0; i < 6; i++) learn = recordOutcome(learn, ["mayhem", "early"], -10, -2);
  const adj = laneAdjust(learn, ["mayhem"]);
  assert.ok(adj.penalty >= 6);
  assert.ok(adj.sizeMul < 1);
  assert.equal(laneAdjust(learn, ["live"]).penalty, 0);
  assert.match(learnSummary(learn), /mayhem/);
});

test("two ugly closes shrink the lane before five samples", () => {
  let learn = emptyLearn();
  learn = recordLane(learn, ["mayhem"], -12);
  assert.equal(laneAdjust(learn, ["mayhem"]).sizeMul, 1);
  learn = recordLane(learn, ["mayhem"], -12);
  const adj = laneAdjust(learn, ["mayhem"]);
  assert.ok(adj.sizeMul <= 0.5);
  assert.ok(adj.penalty >= 6);
  assert.equal(learn.n, 0);
});

test("proof stays unclaimed until eight live closes", () => {
  let learn = emptyLearn();
  assert.match(proofLine(learn), /Too early/);
  for (let i = 0; i < 8; i++) learn = recordOutcome(learn, ["live"], 4, 1);
  assert.match(proofLine(learn), /ahead of the fee hurdle/);
  assert.equal(learn.wins, 8);
});

test("feature tags keep mayhem losses off the live lane", () => {
  const tags = featuresOf({ mayhem: true, pumpFun: true, ageMin: 1, minutes: 1, liq: 5000, change5m: 20, buys: 20, sells: 8 });
  assert.deepEqual(tags[0], "mayhem");
  assert.ok(tags.includes("early"));
  assert.ok(tags.includes("thin"));
  assert.ok(tags.includes("chase"));
});
