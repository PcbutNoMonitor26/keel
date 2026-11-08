export type ReadingsQuote = {
  buys: number;
  sells: number;
  uniqueTraders?: number;
  liq: number;
  change5m: number;
  ageMin?: number;
  minutes?: number;
};

export type Sample = { x: number[]; pnl: number; at: number };

export type Weights = {
  mean: number[];
  std: number[];
  w: number[];
  b: number;
  trainN: number;
  holdoutN: number;
  holdoutAvg: number;
};

export type ModelMemory = {
  samples: Sample[];
  weights: Weights | null;
};

const DIM = 7;
const MIN_SAMPLES = 80;
const MIN_HOLDOUT = 24;
const TAKE_AT = 0.6;

export function emptyModel(): ModelMemory {
  return { samples: [], weights: null };
}

export function readingsOf(q: ReadingsQuote, sol1m: number, clip = 5): number[] {
  const prints = q.buys + q.sells;
  const flow = Math.min(3, Math.log1p(prints) / Math.log(10));
  const imbalance = prints > 0 ? (q.buys - q.sells) / prints : 0;
  const wallets = Math.min(3, Math.log1p(q.uniqueTraders ?? 0) / Math.log(10));
  const depth = Math.min(4, Math.log1p(q.liq / Math.max(clip, 1)) / Math.log(10));
  const sol = Math.max(-3, Math.min(3, sol1m));
  const move = Math.max(-3, Math.min(3, q.change5m / 10));
  const age = Math.min(4, (q.ageMin ?? q.minutes ?? 30) / 10);
  return [flow, imbalance, wallets, depth, sol, move, age];
}

export function predict(weights: Weights, x: number[]): number {
  let z = weights.b;
  for (let i = 0; i < DIM; i++) {
    const scale = weights.std[i] || 1;
    z += weights.w[i] * (((x[i] ?? 0) - (weights.mean[i] ?? 0)) / scale);
  }
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

export function modelAllows(memory: ModelMemory | undefined, x: number[]): { ok: boolean; p: number } {
  const weights = memory?.weights;
  if (!weights) return { ok: true, p: -1 };
  const p = predict(weights, x);
  return { ok: p >= TAKE_AT, p };
}

function fit(samples: Sample[]): Weights | null {
  if (samples.length < MIN_SAMPLES) return null;
  const ordered = [...samples].sort((a, b) => a.at - b.at);
  const cut = Math.floor(ordered.length * 0.7);
  const train = ordered.slice(0, cut);
  const hold = ordered.slice(cut);
  if (train.length < 40 || hold.length < MIN_HOLDOUT) return null;
  const mean = Array(DIM).fill(0);
  const std = Array(DIM).fill(0);
  for (const sample of train) {
    for (let i = 0; i < DIM; i++) mean[i] += sample.x[i] ?? 0;
  }
  for (let i = 0; i < DIM; i++) mean[i] /= train.length;
  for (const sample of train) {
    for (let i = 0; i < DIM; i++) {
      const d = (sample.x[i] ?? 0) - mean[i];
      std[i] += d * d;
    }
  }
  for (let i = 0; i < DIM; i++) std[i] = Math.sqrt(std[i] / train.length) || 1;
  const scale = (x: number[]) => x.map((v, i) => ((v ?? 0) - mean[i]) / std[i]);
  const w = Array(DIM).fill(0);
  let b = 0;
  const lr = 0.15;
  for (let epoch = 0; epoch < 80; epoch++) {
    for (const sample of train) {
      const z = scale(sample.x);
      let dot = b;
      for (let i = 0; i < DIM; i++) dot += w[i] * z[i];
      const p = dot > 20 ? 1 : dot < -20 ? 0 : 1 / (1 + Math.exp(-dot));
      const err = p - (sample.pnl > 0 ? 1 : 0);
      for (let i = 0; i < DIM; i++) w[i] -= lr * err * z[i];
      b -= lr * err;
    }
  }
  const holdAvg = hold.reduce((sum, sample) => sum + sample.pnl, 0) / hold.length;
  if (!(holdAvg > 0)) return null;
  return { mean, std, w, b, trainN: train.length, holdoutN: hold.length, holdoutAvg: holdAvg };
}

export function noteSample(memory: ModelMemory | undefined, x: number[], pnl: number, at: number): ModelMemory {
  const prev = memory?.samples ? memory : emptyModel();
  const samples = [...prev.samples, { x: x.slice(0, DIM), pnl, at }].slice(-400);
  return { samples, weights: fit(samples) };
}

export function modelLine(memory: ModelMemory | undefined): string {
  const samples = memory?.samples?.length ?? 0;
  const weights = memory?.weights;
  if (!weights) {
    return `Model: rules only. ${samples} of ${MIN_SAMPLES} closed scalps. Weights stay off until a later window is still green after fees.`;
  }
  return `Model on. Trained on ${weights.trainN}, checked on the next ${weights.holdoutN}, holdout ${weights.holdoutAvg.toFixed(1)}%. It can refuse a name. It cannot size a clip up.`;
}
