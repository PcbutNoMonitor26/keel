export type TopTraderSignal = "positive" | "negative" | "mixed" | "unknown";

export type TopTraderFlow = {
  signal: TopTraderSignal;
  buyAccounts: number;
  sellAccounts: number;
  buyUsd: number;
  sellUsd: number;
  tradeCount: number;
  eligibleAccounts: number;
  boardAgeMs: number;
  observedAtMs: number;
  reason: string;
};

type Trader = { userId?: string; periods?: string[] };
type Trade = {
  mint?: string;
  userId?: string;
  isBuy?: boolean;
  timestamp?: string | null;
  amountUsd?: number | null;
};
type Response = {
  mint?: string;
  traders?: Trader[];
  trades?: Trade[];
  boardsBuiltAtMs?: number;
  generatedAtMs?: number;
};

const FRESH_RESPONSE_MS = 3 * 60_000;
const FRESH_BOARD_MS = 6 * 60 * 60_000;
const FLOW_WINDOW_MS = 5 * 60_000;
const MIN_ACCOUNTS = 3;

export function evaluateTopTraderFlow(body: Response, mint: string, now = Date.now()): TopTraderFlow {
  const generatedAtMs = Number(body.generatedAtMs);
  const boardsBuiltAtMs = Number(body.boardsBuiltAtMs);
  const responseAge = now - generatedAtMs;
  const boardAgeMs = now - boardsBuiltAtMs;
  const unknown = (reason: string): TopTraderFlow => ({
    signal: "unknown", buyAccounts: 0, sellAccounts: 0, buyUsd: 0, sellUsd: 0,
    tradeCount: 0, eligibleAccounts: 0, boardAgeMs: Number.isFinite(boardAgeMs) ? boardAgeMs : 0,
    observedAtMs: Number.isFinite(generatedAtMs) ? generatedAtMs : 0, reason,
  });
  if (body.mint !== mint) return unknown("top-trader response mint mismatch");
  if (!(generatedAtMs > 0) || responseAge < -30_000 || responseAge > FRESH_RESPONSE_MS) {
    return unknown("top-trader response is stale or has an invalid timestamp");
  }
  if (!(boardsBuiltAtMs > 0) || boardAgeMs < -30_000 || boardAgeMs > FRESH_BOARD_MS) {
    return unknown("top-trader leaderboard snapshot is stale");
  }

  // Require presence on both weekly and monthly boards; a daily/weekly
  // spike alone is too noisy to treat as durable trader quality.
  const eligible = new Set(
    (body.traders ?? [])
      .filter((trader) => {
        const periods = new Set(trader.periods ?? []);
        return Boolean(trader.userId && periods.has("weekly") && periods.has("monthly"));
      })
      .map((trader) => trader.userId as string),
  );
  if (eligible.size === 0) return unknown("no trader cohort present on both weekly and monthly top-50 boards");

  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let buyUsd = 0;
  let sellUsd = 0;
  let tradeCount = 0;
  for (const trade of body.trades ?? []) {
    if (trade.mint !== mint || !trade.userId || !eligible.has(trade.userId)) continue;
    const timestamp = trade.timestamp ? Date.parse(trade.timestamp) : NaN;
    if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > FLOW_WINDOW_MS) continue;
    const amountUsd = Number(trade.amountUsd);
    if (!(amountUsd > 0) || !Number.isFinite(amountUsd) || typeof trade.isBuy !== "boolean") continue;
    tradeCount += 1;
    if (trade.isBuy) {
      buyers.add(trade.userId);
      buyUsd += amountUsd;
    } else {
      sellers.add(trade.userId);
      sellUsd += amountUsd;
    }
  }

  let signal: TopTraderSignal = "mixed";
  let reason = "weekly-and-monthly top-trader flow is mixed";
  if (buyers.size >= MIN_ACCOUNTS && buyers.size > sellers.size && buyUsd > sellUsd * 1.2) {
    signal = "positive";
    reason = `${buyers.size} weekly-and-monthly top-trader accounts net buying in the last five minutes`;
  } else if (sellers.size >= MIN_ACCOUNTS && sellers.size > buyers.size && sellUsd > buyUsd * 1.2) {
    signal = "negative";
    reason = `${sellers.size} weekly-and-monthly top-trader accounts net selling in the last five minutes`;
  } else if (tradeCount === 0) {
    signal = "unknown";
    reason = "no fresh trades from the eligible top-trader cohort";
  }
  return {
    signal, buyAccounts: buyers.size, sellAccounts: sellers.size, buyUsd, sellUsd,
    tradeCount, eligibleAccounts: eligible.size, boardAgeMs, observedAtMs: generatedAtMs, reason,
  };
}

export async function getTopTraderFlow(_mint: string, _now = Date.now()): Promise<TopTraderFlow | null> {
  return null;
}

export type TapePrint = {
  wallet: string;
  side: "buy" | "sell";
  usd: number;
  at: number;
  px: number;
  mint: string;
};

export type WalletMark = { seen: number; good: number; bad: number };

export function settleTape(book: Map<string, WalletMark>, print: TapePrint, laterPx: number): void {
  if (!(print.px > 0) || !(laterPx > 0) || !print.wallet) return;
  const change = laterPx / print.px - 1;
  const row = book.get(print.wallet) ?? { seen: 0, good: 0, bad: 0 };
  row.seen += 1;
  if (print.side === "buy" ? change >= 0.03 : change <= -0.03) row.good += 1;
  else if (print.side === "buy" ? change <= -0.03 : change >= 0.03) row.bad += 1;
  book.set(print.wallet, row);
}

export function cohortFromTape(book: Map<string, WalletMark>, prints: TapePrint[], now = Date.now()): TopTraderFlow | null {
  const recent = prints.filter((print) => print.wallet && print.usd > 0 && now - print.at <= 90_000 && now >= print.at);
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let buyUsd = 0;
  let sellUsd = 0;
  let tradeCount = 0;
  for (const print of recent) {
    const row = book.get(print.wallet);
    if (!row || row.seen < 2 || row.good <= row.bad) continue;
    tradeCount += 1;
    if (print.side === "buy") {
      buyers.add(print.wallet);
      buyUsd += print.usd;
    } else {
      sellers.add(print.wallet);
      sellUsd += print.usd;
    }
  }
  if (tradeCount === 0) return null;
  let signal: TopTraderSignal = "mixed";
  let reason = "Keel tape: repeat wallets are mixed on this name";
  if (buyers.size >= 2 && buyers.size > sellers.size && buyUsd > sellUsd * 1.2) {
    signal = "positive";
    reason = `Keel tape: ${buyers.size} repeat wallets buying`;
  } else if (sellers.size >= 2 && sellers.size > buyers.size && sellUsd > buyUsd * 1.2) {
    signal = "negative";
    reason = `Keel tape: ${sellers.size} repeat wallets selling`;
  }
  return {
    signal, buyAccounts: buyers.size, sellAccounts: sellers.size, buyUsd, sellUsd, tradeCount,
    eligibleAccounts: new Set([...buyers, ...sellers]).size, boardAgeMs: 0, observedAtMs: now, reason,
  };
}
