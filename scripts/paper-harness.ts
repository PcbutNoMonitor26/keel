/**
 * Headless live paper session. Drives engine.ts / learn.ts against collectScan()
 * (pump.fun websocket + GeckoTerminal + SOL tape). No fixtures. No live sends.
 *
 *   npx vite-node scripts/paper-harness.ts -- --minutes 25 --out /workspace/keel-sessions
 */
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectScan, pumpIntakeSnapshot } from "../src/lib/keel/scan.ts";
import { applyScan, emptyBook, equityOf, paperExit, PAPER_FEE, quietTape, type Book, type Position } from "../src/lib/keel/engine.ts";
import { countMidTick, hasTapePrint } from "../src/lib/keel/marks.ts";
import { proofLine, profitFactor, type LearnState } from "../src/lib/keel/learn.ts";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const minutes = Math.max(0.2, Number(arg("--minutes", "25")) || 25);
const outDir = arg("--out", "/workspace/keel-sessions");
const pollMs = Math.max(800, Number(arg("--poll-ms", "2000")) || 2000);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const tag = arg("--tag", "session");
const jsonlPath = join(outDir, `${stamp}-${tag}.jsonl`);
const summaryPath = join(outDir, `${stamp}-${tag}-summary.json`);

mkdirSync(outDir, { recursive: true });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type CloseRow = {
  t: string;
  symbol: string;
  address: string;
  lanes: string[];
  entryMid: number | null;
  exitMid: number | null;
  bestMid: number | null;
  impactPct: number | null;
  entryFee: number | null;
  sizeUsd: number;
  exitProceeds: number;
  feePct: number;
  netUsd: number;
  pnlPct: number;
  holdMs: number;
  why: string;
  score: number;
  proofLine: string;
  markSource: "scan" | "stale-position";
  lastPrintAgeSec: number | null;
  midChgPct: number | null;
  entrySource: string | null;
  exitSource: string | null;
  midTicks: number;
  printBacked: boolean;
};

const closes: CloseRow[] = [];

function whyOf(prevLogs: { text: string }[], nextLogs: { text: string }[], symbol: string): string {
  const prev = new Set(prevLogs.map((l) => l.text));
  const fresh = nextLogs.map((l) => l.text).filter((t) => !prev.has(t));
  const hit = fresh.find((t) => t.includes(symbol) && /closed|scratch|no lift|vitality|brake/i.test(t));
  if (hit) {
    const m = hit.match(/·\s*([^·]+)/);
    return (m?.[1] ?? hit).replace(/\. Paper, not a fill\.?/i, "").trim();
  }
  return fresh.find((t) => t.includes(symbol)) ?? "close";
}

async function main() {
  let book = emptyBook();
  book.running = true;
  book.live = false;
  const started = Date.now();
  const deadline = started + minutes * 60_000;
  console.log(`paper harness ${minutes}m → ${jsonlPath}`);
  console.log(`LIVE trading is not enabled in this harness. PAPER_FEE=${PAPER_FEE}`);

  // Warm the pump.fun socket before the first scored pass.
  try {
    const warm = await collectScan([]);
    console.log(`warm quotes=${warm.quotes.length} sol=${warm.sol} regime=${warm.regime} note=${warm.note || ""}`);
    for (const line of warm.process.slice(0, 6)) console.log("  ", line);
  } catch (err) {
    console.error("warm scan failed", err);
  }
  await sleep(8_000);

  let passes = 0;
  let scanErrors = 0;
  let lastProof = proofLine(book.learn);
  const midWatch = new Map<string, { last: number; ticks: number }>();
  const tapeSeen = new Set<string>();
  const tapeFresh = new Set<string>();
  const refusedMissing = new Set<string>();
  const refusedStale = new Set<string>();
  const entriesTaken = new Set<string>();
  const tapePass = { names: 0, missingPrint: 0, stalePrint: 0, freshPrint: 0, passes: 0 };
  let tapePeakFresh = 0;

  while (Date.now() < deadline && !book.halted) {
    const t0 = Date.now();
    try {
      const held = book.positions.map((p) => ({ address: p.address, priceSource: p.entrySource }));
      const scan = await collectScan(held);
      if (scan.tapeStats) {
        const ts = scan.tapeStats;
        tapePass.names += ts.names;
        tapePass.missingPrint += ts.missingPrint;
        tapePass.stalePrint += ts.stalePrint;
        tapePass.freshPrint += ts.freshPrint;
        tapePass.passes += 1;
        if (ts.freshPrint > tapePeakFresh) tapePeakFresh = ts.freshPrint;
      }
      for (const q of scan.quotes) {
        if (!q.address) continue;
        tapeSeen.add(q.address);
        const why = quietTape(q);
        if (!why) tapeFresh.add(q.address);
        else if (typeof q.lastPrintAgeSec === "number" && Number.isFinite(q.lastPrintAgeSec)) refusedStale.add(q.address);
        else refusedMissing.add(q.address);
      }
      const before = book;
      const open = new Map(before.positions.map((p) => [p.address, p]));
      book = applyScan(before, scan);
      for (const p of book.positions) {
        if (!open.has(p.address)) entriesTaken.add(p.address);
      }
      const still = new Map(book.positions.map((p) => [p.address, p]));
      for (const [addr, pos] of open) {
        const current = still.get(addr);
        const tok = book.tokens.find((q) => q.address === addr);
        const mid = current
          ? (current.mark || current.entryMid || 0)
          : ((tok?.price && tok.price > 0) ? tok.price : (pos.mark || pos.entryMid || 0));
        midWatch.set(addr, countMidTick(midWatch.get(addr), mid));
      }
      for (const p of book.positions) {
        if (!midWatch.has(p.address)) midWatch.set(p.address, countMidTick(undefined, p.mark || p.entryMid || 0));
      }
      passes += 1;
      const closedNow: Position[] = [];
      for (const [addr, pos] of open) {
        if (!still.has(addr)) closedNow.push(pos);
      }
      for (const pos of closedNow) {
        const tok = book.tokens.find((q) => q.address === pos.address);
        const fromScan = Boolean(tok?.price && tok.price > 0);
        const mark = fromScan ? tok!.price : pos.mark;
        const liq = tok?.liq || pos.markLiquidityUsd || 0;
        const exit = paperExit(pos.entry, mark, pos.sizeUsd, liq);
        const entryFee = pos.entryFee ?? pos.sizeUsd * PAPER_FEE;
        const netUsd = exit.pnl - entryFee;
        const holdMs = book.now && pos.openedAt ? book.now - pos.openedAt : t0 - (pos.openedAt || t0);
        const bestMid = Math.max(pos.bestMid ?? 0, mark || 0) || pos.bestMid || null;
        const midChgPct = pos.entryMid && pos.entryMid > 0 && mark > 0 ? ((mark / pos.entryMid) - 1) * 100 : null;
        const row: CloseRow = {
          t: new Date().toISOString(),
          symbol: pos.symbol,
          address: pos.address,
          lanes: pos.features ?? [],
          entryMid: pos.entryMid ?? null,
          exitMid: mark || null,
          bestMid,
          impactPct: pos.impactPct ?? exit.impact * 100,
          entryFee,
          sizeUsd: pos.sizeUsd,
          exitProceeds: exit.proceeds,
          feePct: PAPER_FEE * 100,
          netUsd,
          pnlPct: pos.sizeUsd > 0 ? (netUsd / pos.sizeUsd) * 100 : exit.pct,
          holdMs,
          why: whyOf(before.logs, book.logs, pos.symbol),
          score: pos.score,
          proofLine: proofLine(book.learn),
          markSource: fromScan ? "scan" : "stale-position",
          lastPrintAgeSec: tok?.lastPrintAgeSec ?? null,
          midChgPct,
          entrySource: pos.entrySource ?? null,
          exitSource: tok?.priceSource ?? pos.entrySource ?? null,
          midTicks: midWatch.get(pos.address)?.ticks ?? 0,
          printBacked: tok ? hasTapePrint(tok) : false,
        };
        closes.push(row);
        midWatch.delete(pos.address);
        appendFileSync(jsonlPath, JSON.stringify(row) + "\n");
        console.log(
          `CLOSE ${row.symbol} ${row.why} lanes=${row.lanes.join(",")} net=${row.netUsd.toFixed(4)} hold=${Math.round(row.holdMs / 1000)}s midChg=${row.midChgPct == null ? "n/a" : row.midChgPct.toFixed(2) + "%"} entrySrc=${row.entrySource ?? "n/a"} exitSrc=${row.exitSource ?? "n/a"} ticks=${row.midTicks} print=${row.printBacked} printAge=${row.lastPrintAgeSec == null ? "n/a" : row.lastPrintAgeSec.toFixed(1) + "s"} proof=${row.proofLine}`,
        );
      }
      lastProof = proofLine(book.learn);
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (passes % 8 === 0 || closedNow.length) {
        const rejects = summarizeRejects(scan, book);
        console.log(
          `t+${elapsed}s passes=${passes} quotes=${scan.quotes.length} open=${book.positions.length} closes=${book.learn.n} net=${book.learn.netUsd.toFixed(2)} taken=${entriesTaken.size} tape=${tapeLine(scan)} intake=${intakeLine()} ${rejects} | ${lastProof}`,
        );
        if (book.positions.length) {
          for (const p of book.positions) {
            console.log(`  open ${p.symbol} $${p.sizeUsd.toFixed(2)} · ${p.score} · ${(p.reasons ?? []).join(", ")}`);
          }
        }
      }
    } catch (err) {
      scanErrors += 1;
      console.error(`scan error #${scanErrors}`, err instanceof Error ? err.message : err);
      if (scanErrors >= 12) {
        console.error("too many scan errors, stopping");
        break;
      }
    }
    const wait = pollMs - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }

  const pf = profitFactor(book.learn);
  const summary = {
    tag,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    minutesRequested: minutes,
    passes,
    scanErrors,
    halted: book.halted,
    proofLine: lastProof,
    closes: book.learn.n,
    wins: book.learn.wins,
    winRate: book.learn.n ? book.learn.wins / book.learn.n : 0,
    netUsd: book.learn.netUsd,
    grossWin: book.learn.grossWin,
    grossLoss: book.learn.grossLoss,
    profitFactor: pf === Number.POSITIVE_INFINITY ? "inf" : pf,
    equity: equityOf(book),
    realized: book.realized,
    open: book.positions.map((p) => ({ symbol: p.symbol, sizeUsd: p.sizeUsd, features: p.features, score: p.score })),
    buckets: book.learn.buckets,
    lanes: laneBreakdown(closes, book.learn),
    entriesTaken: entriesTaken.size,
    tape: {
      namesSeen: tapeSeen.size,
      freshPrint: tapeFresh.size,
      refusedMissing: refusedMissing.size,
      refusedStale: refusedStale.size,
      preFilter: tapePass.passes ? {
        passes: tapePass.passes,
        avgNames: tapePass.names / tapePass.passes,
        avgMissing: tapePass.missingPrint / tapePass.passes,
        avgStale: tapePass.stalePrint / tapePass.passes,
        avgFresh: tapePass.freshPrint / tapePass.passes,
        peakFresh: tapePeakFresh,
      } : null,
    },
    intake: pumpIntakeSnapshot(),
    jsonl: jsonlPath,
    liveTradingEnabled: false,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  appendFileSync(jsonlPath, JSON.stringify({ summary: true, proofLine: lastProof, netUsd: book.learn.netUsd, closes: book.learn.n }) + "\n");
  console.log("SUMMARY", JSON.stringify(summary, null, 2));
  console.log("proofLine:", lastProof);
  // The pump.fun websocket keeps the event loop alive; end the process so a timed session can exit.
  process.exit(0);
}

function tapeLine(scan: { tapeStats?: { names: number; missingPrint: number; stalePrint: number; freshPrint: number } }): string {
  const ts = scan.tapeStats;
  if (!ts) return "tape=n/a";
  return `names=${ts.names} fresh=${ts.freshPrint} stale=${ts.stalePrint} missing=${ts.missingPrint}`;
}

function intakeLine(): string {
  const snap = pumpIntakeSnapshot();
  return `trades=${snap.tradeMessages} creates=${snap.createMessages} raw=${snap.rawMessages} subTrades=${snap.tradeSubscribeOk} watch=${snap.watchedTradeMints}`;
}

function summarizeRejects(scan: { process: string[] }, _book: Book): string {
  const lead = scan.process.find((l) => l.startsWith("Watching") || l.startsWith("Top candidate") || l.startsWith("No name"));
  return lead ? lead.slice(0, 160) : "";
}

function laneBreakdown(rows: CloseRow[], learn: LearnState) {
  const keys = new Set<string>();
  for (const row of rows) for (const k of row.lanes) keys.add(k);
  for (const k of Object.keys(learn.buckets)) keys.add(k);
  const out: Record<string, { n: number; wins: number; winRate: number; netUsd: number; avgHoldSec: number; pf: number | "inf" | 0; avgPnlPct: number }> = {};
  for (const key of keys) {
    const hits = rows.filter((r) => r.lanes.includes(key));
    const wins = hits.filter((r) => r.netUsd > 0);
    const losses = hits.filter((r) => r.netUsd <= 0);
    const grossWin = wins.reduce((s, r) => s + r.netUsd, 0);
    const grossLoss = losses.reduce((s, r) => s + Math.abs(r.netUsd), 0);
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? "inf" : 0;
    const hold = hits.length ? hits.reduce((s, r) => s + r.holdMs, 0) / hits.length / 1000 : 0;
    out[key] = {
      n: hits.length,
      wins: wins.length,
      winRate: hits.length ? wins.length / hits.length : 0,
      netUsd: hits.reduce((s, r) => s + r.netUsd, 0),
      avgHoldSec: Math.round(hold * 10) / 10,
      pf,
      avgPnlPct: hits.length ? hits.reduce((s, r) => s + r.pnlPct, 0) / hits.length : 0,
    };
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
