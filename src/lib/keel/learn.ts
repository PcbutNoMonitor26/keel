export type Bucket = { n: number; sumR: number };

export type LearnState = {
  n: number;
  sumR: number;
  wins: number;
  netUsd: number;
  grossWin: number;
  grossLoss: number;
  buckets: Record<string, Bucket>;
};

export type FeatureQuote = {
  mayhem?: boolean;
  pumpFun?: boolean;
  ageMin?: number;
  minutes?: number;
  liq: number;
  change5m: number;
  buys: number;
  sells: number;
};

export function emptyLearn(): LearnState {
  return { n: 0, sumR: 0, wins: 0, netUsd: 0, grossWin: 0, grossLoss: 0, buckets: {} };
}

export function featuresOf(q: FeatureQuote): string[] {
  const age = q.ageMin ?? q.minutes ?? 99;
  const keys = [q.mayhem ? "mayhem" : q.pumpFun ? "pump" : "live"];
  if (age <= 3) keys.push("early");
  if (q.liq > 0 && q.liq < 8_000) keys.push("thin");
  if (q.change5m >= 18) keys.push("chase");
  if (q.sells > 0 && q.buys / q.sells >= 1.8) keys.push("bid");
  return keys;
}

export function recordOutcome(state: LearnState, features: string[], pnlPct: number, pnlUsd: number): LearnState {
  const r = Number.isFinite(pnlPct) ? pnlPct : 0;
  const usd = Number.isFinite(pnlUsd) ? pnlUsd : 0;
  const buckets: Record<string, Bucket> = { ...state.buckets };
  for (const key of features) {
    const prev = buckets[key] ?? { n: 0, sumR: 0 };
    buckets[key] = { n: prev.n + 1, sumR: prev.sumR + r };
  }
  const win = usd > 0;
  return {
    n: state.n + 1,
    sumR: state.sumR + r,
    wins: state.wins + (win ? 1 : 0),
    netUsd: state.netUsd + usd,
    grossWin: state.grossWin + (win ? usd : 0),
    grossLoss: state.grossLoss + (win ? 0 : -usd),
    buckets,
  };
}

export function recordLane(state: LearnState, features: string[], pnlPct: number): LearnState {
  const r = Number.isFinite(pnlPct) ? pnlPct : 0;
  const buckets: Record<string, Bucket> = { ...state.buckets };
  for (const key of features) {
    const prev = buckets[key] ?? { n: 0, sumR: 0 };
    buckets[key] = { n: prev.n + 1, sumR: prev.sumR + r };
  }
  return { ...state, buckets };
}

export function laneAdjust(state: LearnState, features: string[]): { penalty: number; sizeMul: number; note: string } {
  let penalty = 0;
  let sizeMul = 1;
  const notes: string[] = [];
  for (const key of features) {
    const bucket = state.buckets[key];
    if (!bucket || bucket.n < 2) continue;
    const avg = bucket.sumR / bucket.n;
    const ugly = bucket.n >= 2 && avg <= -8;
    const soft = bucket.n >= 3 && avg <= -4;
    const mature = bucket.n >= 5;
    if (ugly || (mature && avg <= -8)) {
      penalty += 6;
      sizeMul *= 0.5;
      notes.push(`${key} ${avg.toFixed(1)}%`);
    } else if (soft || (mature && avg <= -3)) {
      penalty += 6;
      sizeMul *= 0.7;
      notes.push(`${key} ${avg.toFixed(1)}%`);
    } else if (mature && avg >= 5) {
      penalty -= 4;
      notes.push(`${key} +${avg.toFixed(1)}%`);
    }
  }
  return {
    penalty: Math.max(-8, Math.min(18, penalty)),
    sizeMul: Math.max(0.35, Math.min(1, sizeMul)),
    note: notes.slice(0, 3).join(", "),
  };
}

export function proofLine(state: LearnState): string {
  if (state.n < 8) {
    return `Paper proof: ${state.n} of 8 closes. Too early to claim an edge. A close is the live mid after impact and 1.25% per-side venue fees, not a backtest.`;
  }
  const avg = state.sumR / state.n;
  const pf = state.grossLoss > 0 ? state.grossWin / state.grossLoss : state.grossWin > 0 ? Number.POSITIVE_INFINITY : 0;
  const pfText = pf === Number.POSITIVE_INFINITY ? "no booked loss yet" : pf.toFixed(2);
  const tone = state.netUsd > 0 && pf > 1 ? "ahead of the fee hurdle" : state.netUsd < 0 ? "behind the fee hurdle" : "flat after costs";
  const sign = state.netUsd > 0 ? "+" : state.netUsd < 0 ? "-" : "";
  return `Paper proof: ${state.n} closes, ${sign}$${Math.abs(state.netUsd).toFixed(2)} net, expectancy ${avg.toFixed(1)}%, profit factor ${pfText}. ${tone}. This browser's live paper only.`;
}

export function learnSummary(state: LearnState): string {
  const parts = Object.entries(state.buckets)
    .filter(([, bucket]) => bucket.n >= 5)
    .map(([key, bucket]) => `${key} ${bucket.n}× ${(bucket.sumR / bucket.n).toFixed(1)}%`);
  return parts.length ? `Learned: ${parts.join(" · ")}. Losing lanes get harder and smaller.` : "Learned: no lane has 5 closes yet. Two ugly closes still shrink that lane.";
}
