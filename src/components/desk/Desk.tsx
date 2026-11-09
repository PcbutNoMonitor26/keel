import { useEffect, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from "recharts";
import {
  coinMin,
  equityOf,
  fmtClock,
  fmtPx,
  fmtRet,
  fmtSigned,
  fmtUsd,
  planClip,
  pnlPct,
  scoreOf,
  stopsFor,
  paperExit,
  DEFAULT_CONFIG,
  type Book,
  type Config,
  type Position,
  type Scan,
  type Token,
} from "@/lib/keel/engine";
import { getScan } from "@/lib/keel/scan";
import { aiShadowStats, analyzeOpportunity } from "@/lib/keel/ai-shadow";
import { emptyLearn, learnSummary, proofLine, type LearnState } from "@/lib/keel/learn";
import { modelLine } from "@/lib/keel/model";
import { buyToken, connectWallet, sellToken, solCover, trustedOwner, watchWallet } from "@/lib/keel/live";
import { useDesk } from "@/lib/keel/store";

// Deliberately hard-disabled until the AI shadow dataset is reviewed and a separate release authorizes live execution.
const LIVE_TRADING_ENABLED = false;

export function Desk({ initial }: { initial: Scan }) {
  const book = useDesk();
  const running = book.running;
  const pollSec = book.config.pollSec;
  const ingest = book.ingest;
  const refresh = useServerFn(getScan);

  const hydrated = book.hydrated;

  useEffect(() => {
    if (!hydrated) return;
    let stop = false;
    ingest(initial);
    let busy = false;
    const pull = () => {
      if (busy || stop) return;
      busy = true;
      const held = useDesk.getState().positions.map((p) => ({ address: p.address }));
      const scan = refresh({ data: { held } });
      let timeoutId: number | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error("slow")), 8_000);
      });
      Promise.race([scan, timeout])
        .then((result) => {
          if (!stop) ingest(result);
        })
        .catch(() => {
          if (!stop) useDesk.getState().note("Scan is slow. Marks unchanged, retrying.");
        })
        .finally(() => {
          if (timeoutId !== undefined) window.clearTimeout(timeoutId);
          busy = false;
        });
    };
    pull();
    const id = window.setInterval(pull, 1_500);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [refresh, ingest, pollSec, hydrated, initial]);

  const hasScan = book.now > 0;
  const tokens = hasScan ? book.tokens : initial.quotes;
  const regime = hasScan ? book.regime : initial.regime;
  const shown = tokens.filter((tok) => scoreOf(tok, book.config, regime, book.learn ?? emptyLearn()).score > 0);
  const sol = hasScan ? book.sol : initial.sol;
  const ret1 = hasScan ? book.ret1 : initial.ret1;
  const ret5 = hasScan ? book.ret5 : initial.ret5;
  const sol15 = hasScan ? book.sol15 : initial.sol15;
  const eq = equityOf(book);
  const session = eq;
  const size = stopsFor(eq, book.config);
  const process = (book.process ?? []).length > 0 ? book.process : (initial.process ?? []);
  const [tick, setTick] = useState(0);
  const [pick, setPick] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [armAsk, setArmAsk] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [cover, setCover] = useState<number | null>(null);
  const [kick, setKick] = useState(0);
  const [hostNote, setHostNote] = useState<string | null>(null);
  const [parkedAsk, setParkedAsk] = useState(false);
  const exportAiEvidence = () => {
    const state = useDesk.getState();
    const report = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      product: "Keel",
      strategy: "deterministic-ai-shadow-v1",
      executionMode: "shadow-only",
      liveTradingEnabled: LIVE_TRADING_ENABLED,
      config: state.config,
      aiShadow: state.aiShadow,
      aiLearn: state.aiLearn,
      learn: state.learn,
      baseline: {
        cash: state.cash,
        realized: state.realized,
        peak: state.peak,
        halted: state.halted,
        positions: state.positions,
        equity: state.equity,
      },
      latestMarketSnapshot: {
        at: state.now,
        regime: state.regime,
        sol: state.sol,
        ret1: state.ret1,
        ret5: state.ret5,
        sol15: state.sol15,
        vol1m: state.vol1m,
        quotes: state.tokens,
      },
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `keel-shadow-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const ago = book.now > 1e11 ? Math.max(0, Math.round((Date.now() - book.now) / 1000)) : 0;
  const busy = useRef(false);
  const cooldown = useRef(new Map<string, number>());
  useEffect(() => {
    let stop = false;
    trustedOwner().then((key) => {
      if (!stop && key) setOwner(key);
    });
    setMounted(true);
    const unwatch = watchWallet((key) => {
      if (!stop) setOwner(key);
    });
    return () => {
      stop = true;
      unwatch();
    };
  }, []);
  useEffect(() => {
    const api = useDesk.persist;
    if (api.hasHydrated()) {
      useDesk.getState().setHydrated();
      return;
    }
    const unsub = api.onFinishHydration(() => {
      useDesk.getState().setHydrated();
    });
    const backup = window.setTimeout(() => {
      if (!useDesk.getState().hydrated) useDesk.getState().setHydrated();
    }, 500);
    return () => {
      unsub();
      window.clearTimeout(backup);
    };
  }, []);
  useEffect(() => {
    if (!owner) {
      setCover(null);
      return;
    }
    let stop = false;
    const pull = () => {
      solCover(owner)
        .then((c) => {
          if (!stop) setCover(c.usd);
        })
        .catch(() => {
          if (!stop) setCover(null);
        });
    };
    pull();
    const id = window.setInterval(pull, 20_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [owner]);
  useEffect(() => {
    if (!LIVE_TRADING_ENABLED || busy.current) return;
    const jobs = book.staged;
    if (!book.live && !jobs.some((job) => job.user)) return;
    if (jobs.length > 0 && !owner) {
      useDesk.getState().note("A pass is ready. Connect a wallet to send it.");
      return;
    }
    const job = jobs.find((item) => {
      if (!book.live && !item.user) return false;
      const until = cooldown.current.get(`${item.action}:${item.address}`) ?? 0;
      return until <= Date.now();
    });
    if (!job) return;
    const tok = useDesk.getState().tokens.find((t) => t.address === job.address);
    const pos = useDesk.getState().positions.find((p) => p.address === job.address);
    if (!owner) {
      useDesk.getState().note("Solana pass is ready. Connect a Solana wallet.");
      return;
    }
    const key = `${job.action}:${job.address}`;
    cooldown.current.set(key, Date.now() + 90_000);
    busy.current = true;
    void (async () => {
      try {
        if (job.action === "buy") {
          if (!tok) return;
          const plan = planClip(useDesk.getState(), tok);
          if (!plan.ok) {
            useDesk.getState().note(`${tok.symbol} — ${plan.error}`);
            return;
          }
          let clip = plan.clip;
          if (tok.venue === "sol") {
            if (!owner) return;
            try {
              const funds = await solCover(owner);
              setCover(funds.usd);
              if (funds.spendable + 0.01 < (tok.mins > 0 ? tok.mins : 1)) {
                useDesk.getState().note(`${tok.symbol} — wallet holds ${fmtUsd(funds.usd)} SOL. Need the coin minimum plus fees.`);
                return;
              }
              clip = Math.min(clip, funds.spendable);
            } catch {
              throw new Error("SOL balance could not be verified. Swap blocked; check the wallet RPC before retrying.");
            }
            const sent = await buyToken(owner, tok.address, clip);
            useDesk.getState().commitBuy(tok.address, sent.signature, sent.outAmount, clip);
          }
        } else if (pos?.signature) {
          if (pos.venue === "sol") {
            if (!owner || !pos.rawOut) {
              useDesk.getState().note(`${job.symbol} — no token balance stored for this clip.`);
              return;
            }
            const sent = await sellToken(owner, job.address, pos.rawOut);
            useDesk.getState().close(job.address);
            useDesk.getState().note(`${job.symbol} sold ${sent.signature.slice(0, 8)}`);
          }
        }
        cooldown.current.set(key, Date.now() + 20_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Wallet refused the order";
        useDesk.getState().note(`${job.symbol} — ${msg}`);
        if (msg.includes("confirmation lookup failed") || msg.includes("confirmation is unknown") || msg.includes("balance could not be reconciled") || msg.includes("balance could not be verified") || msg.includes("could not be reconciled") || msg.includes("unreconciled token amount")) {
          useDesk.getState().disarm();
          useDesk.getState().stop();
          useDesk.getState().note("Live host paused: reconcile wallet balances and inspect any pending transaction before re-arming.");
        }
        cooldown.current.set(key, Date.now() + 90_000);
      } finally {
        useDesk.getState().drop(job.address, job.action);
        busy.current = false;
        setKick((n) => n + 1);
      }
    })();
  }, [book.staged, book.live, owner, kick]);

  const afterHydration = (act: () => void) => {
    const api = useDesk.persist;
    if (api.hasHydrated()) {
      act();
      return;
    }
    setHostNote("Waking the book…");
    let done = false;
    let backup = 0;
    const run = () => {
      if (done) return;
      done = true;
      window.clearTimeout(backup);
      act();
    };
    const unsub = api.onFinishHydration(() => {
      unsub();
      run();
    });
    backup = window.setTimeout(() => {
      unsub();
      run();
    }, 600);
    if (api.hasHydrated()) {
      unsub();
      run();
    }
  };

  const connect = () => {
    setArmAsk(false);
    void (async () => {
      try {
        const wallet = await connectWallet();
        setOwner(wallet);
        const text = "Phantom connected. Paper keeps running. Live swaps stay off.";
        book.note(text);
        setHostNote(text);
      } catch (err) {
        const text = err instanceof Error ? err.message : "Could not connect Solana wallet.";
        book.note(text);
        setHostNote(text);
      }
    })();
  };

  const toggleHost = () => {
    afterHydration(() => {
      const s = useDesk.getState();
      if (s.running) {
        s.stop();
        setParkedAsk(false);
        setHostNote("Host stopped. Marks keep updating. No new takes.");
        return;
      }
      if (s.halted) {
        s.start();
        setParkedAsk(true);
        setHostNote("Paper session loss limit reached. Reset the paper ledger before restarting.");
        return;
      }
      s.start();
      setParkedAsk(false);
      setHostNote("Host armed. Taking the next pass on the live tape.");
      const held = s.positions.map((p) => ({ address: p.address }));
      refresh({ data: { held } })
        .then((scan) => {
          useDesk.getState().ingest(scan);
          setHostNote(useDesk.getState().running ? "Host is on. The tape is live." : "That pass parked the host. Clear the book to arm again.");
        })
        .catch(() => setHostNote("Scan failed. Host stays armed and retries on the next pass."));
    });
  };

  const selected = tokens.find((t) => t.address === pick) ?? null;
  const floor = coinMin(tokens);
  const aiStats = aiShadowStats(book.aiShadow);
  const latestAi = book.aiShadow.signals[0];
  const aiVsBaseline = aiStats.netPnl - session;

  return (
    <div className="min-h-screen bg-bg pb-[calc(7.5rem+env(safe-area-inset-bottom))] text-fg lg:pb-0">
      <header className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 lg:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-medium tracking-tight">Keel</h1>
                <Status running={running} halted={book.halted} live={book.live} />
              </div>
              <p className="mt-1 max-w-md text-sm text-muted">
                Live tape. Small scalps only. The first green is sold. Size creeps up as those wins add up.
              </p>
            </div>
            <div className="hidden shrink-0 items-center gap-2 lg:flex">
              <button
                type="button"
                className="press min-h-11 rounded-full border border-line px-4 text-sm"
                disabled={Boolean(owner)}
                onClick={() => { if (!owner) setArmAsk(true); }}
              >
                {owner ? "Wallet connected" : "Connect Solana wallet"}
              </button>
              {book.live ? (
                <button type="button" className="press min-h-11 rounded-sm border border-line px-3 text-sm" onClick={() => book.disarm()}>Disarm</button>
              ) : null}
              <button
                type="button"
                className={"press min-h-11 shrink-0 rounded-full px-4 text-sm font-medium " + (running ? "border border-line bg-elevated text-fg" : "bg-accent text-accent-fg")}
                onClick={toggleHost}
              >
                {running ? "Stop host" : "Start host"}
              </button>
            </div>
          </div>
          {hostNote ? <p className="hidden text-sm text-muted lg:block">{hostNote}</p> : null}
          {armAsk && !owner ? (
              <div className="hidden flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:items-center sm:justify-between lg:flex">
                <p className="max-w-xl text-sm text-muted">
                  Wallet connection is a smoke test only. AI shadow mode evaluates opportunities and paper trades locally. Live trading and swap staging are disabled during validation.
                </p>
                <span className="flex gap-2">
                  <button type="button" className="press min-h-11 rounded-sm px-3 text-sm text-muted" onClick={() => setArmAsk(false)}>Cancel</button>
                  <button
                    type="button"
                    className="press min-h-11 rounded-sm bg-accent px-3 text-sm font-medium text-accent-fg"
                    onClick={connect}
                  >Connect wallet</button>
                </span>
              </div>
            ) : null}
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Wallet SOL" value={owner && cover == null ? "—" : fmtUsd(cover ?? 0)} hint={owner ? (cover == null ? "wallet connected; balance unavailable" : "verified SOL, not SPL tokens") : "no wallet detected · $0.00"} />
            <Stat label="AI paper P&L" value={fmtSigned(aiStats.netPnl)} hint="simulated $5 clips, not wallet funds" tone={aiStats.netPnl} />
            <Stat label="Baseline comparator" value={fmtSigned(session)} hint="virtual book, not your balance" tone={session} />
            <Stat
              label="SOL 15m"
              value={sol > 0 ? fmtUsd(sol) : "—"}
              hint={`${fmtRet(ret1)} 1m · ${fmtRet(ret5)} 5m · ${fmtRet(sol15)} 15m`}
              tone={sol15}
            />
          </dl>
        </div>
      </header>

      <main className="mx-auto grid min-w-0 max-w-6xl gap-3 px-4 py-3 lg:grid-cols-12 lg:gap-4 lg:px-6 lg:py-4">
        <Panel className="order-4 lg:order-none lg:col-span-12" title="Process" meta={ago > 0 ? `updated ${ago}s ago` : "live"}>
          <LiveProcess tokens={tokens} positions={book.positions} regime={regime} process={process} ago={ago} halted={book.halted} />
        </Panel>
        <Panel className="order-5 lg:order-none lg:col-span-12" title="Paper proof" meta="LIVE MID · NOT A BACKTEST">
          <p className="text-sm text-muted">{proofLine(book.learn ?? emptyLearn())}</p>
          <p className="mt-1 text-xs text-faint">{modelLine(book.model)}</p>
          <p className="mt-1 text-xs text-faint">{learnSummary(book.learn ?? emptyLearn())}</p>
          {book.positions.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No paper clip open. The tape is the live set. The host takes one name per pass when the gate clears.</p>
          ) : (
            <ul className="mt-3 border-t border-line">
              {book.positions.map((p) => {
                const tok = tokens.find((t) => t.address === p.address);
                const exit = paperExit(p.entry, p.mark, p.sizeUsd, tok?.liq ?? 0);
                const best = p.entryMid && p.bestMid ? ((p.bestMid / p.entryMid) - 1) * 100 : 0;
                return (
                  <li key={p.address} className="flex flex-col gap-1 border-b border-line py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span className="min-w-0 text-muted">{p.symbol} · if sold on this pass {exit.pct.toFixed(1)}% after {(exit.impact * 100).toFixed(1)}% impact</span>
                    <span className={exit.pnl >= 0 ? "shrink-0 font-mono text-up" : "shrink-0 font-mono text-down"}>{fmtSigned(exit.pnl)} · best mid {best.toFixed(1)}%</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel className="order-8 lg:order-none lg:col-span-12" title="AI shadow lab" meta="SHADOW ONLY · LIVE EXECUTION DISABLED">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-faint">Export the local paper ledger, signals, feature tags, learned lanes, and market snapshot for independent review.</p>
            <button type="button" className="press min-h-10 rounded-sm border border-line px-3 text-xs" onClick={exportAiEvidence}>
              Export shadow evidence
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="AI paper P&L" value={fmtSigned(aiStats.netPnl)} hint="realized plus marked open clips" tone={aiStats.netPnl} />
            <Stat label="Closed paper trades" value={String(aiStats.closedTrades)} hint={`${aiStats.wins} wins · ${aiStats.losses} losses`} />
            <Stat label="Paper win rate" value={aiStats.closedTrades ? `${aiStats.winRate.toFixed(1)}%` : "—"} hint="Not a probability forecast" />
            <Stat label="Open paper clips" value={String(aiStats.openTrades)} hint={book.aiShadow.halted ? "book stopped" : "next clip reuses half the profit"} />
            <Stat label="Baseline comparator" value={fmtSigned(session)} hint="separate virtual book" tone={session} />
            <Stat label="AI vs baseline" value={fmtSigned(aiVsBaseline)} hint="paper P&L minus comparator" tone={aiVsBaseline} />
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-sm font-medium">Latest AI assessment</p>
            {latestAi ? (
              <>
                <p className="mt-1 text-sm text-muted">{latestAi.symbol} · score {latestAi.score}/100 · {latestAi.decision.replace("_", " ")}</p>
                <p className="mt-1 text-xs leading-relaxed text-faint">{latestAi.reasons.join(" · ")}</p>
                <p className="mt-1 text-xs leading-relaxed text-faint">Not verified: {latestAi.unknowns.join(" · ")}.</p>
              </>
            ) : <p className="mt-1 text-sm text-muted">Waiting for the first scored market scan.</p>}
            <p className="mt-2 text-xs leading-relaxed text-faint">
              Explainable paper ledger. It starts at $0 and shows profit or loss on simulated $5 clips after costs. It does not spend the wallet. Unknown safety checks stay unknown. This is not a promise of returns.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-faint">AI-only learning: {learnSummary(book.aiLearn ?? emptyLearn())}</p>
          </div>
          {book.aiShadow.trades.length > 0 ? (
            <ol className="mt-3 max-h-40 overflow-auto border-t border-line">
              {book.aiShadow.trades.slice(0, 8).map((trade) => (
                <li key={`${trade.address}-${trade.closedAt}`} className="flex items-center justify-between gap-3 border-b border-line py-2 text-xs">
                  <span className="min-w-0 text-muted">{trade.symbol} · {trade.reason}</span>
                  <span className={trade.pnlUsd >= 0 ? "shrink-0 font-mono text-up" : "shrink-0 font-mono text-down"}>{fmtSigned(trade.pnlUsd)}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </Panel>
        <Panel
          className="order-3 lg:order-none lg:col-span-5"
          title="Baseline comparator"
          meta="virtual book · not wallet funds"
        >
          <div className="h-36 w-full min-w-0">
            {mounted ? <Curve points={book.equity} /> : <div className="h-full" />}
          </div>
        </Panel>

        <Panel
          className="order-1 lg:order-none lg:col-span-7"
          title="Tape"
          meta={`${shown.length} above zero · floor ${book.config.scoreFloor} · realized ${fmtSigned(book.realized)}`}
        >
          {shown.length === 0 ? (
            <p className="py-6 text-sm text-muted">Nothing above zero. Pump.fun is still being watched in the background.</p>
          ) : (
          <>
          <p className="mb-2 text-xs text-muted">{thoughtLine(shown, book.config, regime, book.learn ?? emptyLearn())}</p>
          <ul className="flex flex-col">
            {[...shown]
              .sort(
                (a, b) =>
                  analyzeOpportunity(b, book.config, regime, book.aiLearn).score -
                  analyzeOpportunity(a, book.config, regime, book.aiLearn).score,
              )
              .map((tok) => (
              <TapeRow
                key={tok.address}
                tok={tok}
                cfg={book.config}
                regime={regime}
                learn={book.learn ?? emptyLearn()}
                aiLearn={book.aiLearn ?? emptyLearn()}
                active={pick === tok.address}
                held={book.positions.some((p) => p.address === tok.address)}
                blocked={(book.blocked ?? []).includes(tok.address)}
                onPick={() => setPick(tok.address)}
              />
            ))}
          </ul>
          </>
          )}
        </Panel>

        <Panel
          id="keel-book"
          className="order-2 lg:order-none lg:col-span-7"
          title="Book"
          meta={book.positions.length === 0 ? "Tap the tape" : `${book.positions.length} live`}
          action={
            book.positions.length > 0 ? (
              <button
                type="button"
                className="press min-h-11 rounded-sm px-2 text-sm text-muted"
                onClick={() => book.flattenBook()}
              >
                Flatten
              </button>
            ) : null
          }
        >
          {book.positions.length === 0 ? (
            <p className="py-6 text-sm text-muted">Nothing in the book. Tap a name, then choose invest. It stays live until you close it, or the mark turns green or fades.</p>
          ) : (
            <ul className="flex flex-col">
              {book.positions.map((p) => (
                <BookRow
                  key={p.address}
                  p={p}
                  onClose={() => book.requestClose(p.address)}
                />
              ))}
            </ul>
          )}
        </Panel>

        <Panel className="order-6 lg:order-none lg:col-span-5" title="Gates" meta="Saved on this computer">
          <div className="flex flex-col gap-4">
            <div className="flex min-h-11 items-center justify-between gap-3 text-sm">
              <span>Paper clip sizing</span>
              <button
                type="button"
                className="press min-h-11 rounded-sm px-2 font-mono text-xs"
                onClick={() => book.patch({ autoSize: book.config.autoSize === false })}
              >
                {book.config.autoSize === false ? "Manual" : "Auto"}
              </button>
            </div>
            <Money
              label="Clip size"
              value={book.config.autoSize === false ? book.config.buyUsd : Math.max(0.01, Math.round(size.clip * 100) / 100)}
              min={1}
              disabled={book.config.autoSize !== false}
              hint={book.config.autoSize === false ? "manual notional · $5 maximum per clip" : "automatic · fixed $5 paper notional"}
              onChange={(buyUsd) => book.patch({ buyUsd: Math.max(1, buyUsd), autoSize: false })}
            />
            <Gate
              label="Score floor"
              display={String(book.config.scoreFloor)}
              min={50}
              max={90}
              step={1}
              value={book.config.scoreFloor}
              onChange={(scoreFloor) => book.patch({ scoreFloor })}
            />
            <Gate
              label="Max open"
              display={String(book.config.maxPositions)}
              min={1}
              max={4}
              step={1}
              value={book.config.maxPositions}
              onChange={(maxPositions) => book.patch({ maxPositions })}
            />
            <Gate
              label="Min liquidity"
              display={fmtUsd(book.config.minLiq)}
              min={2000}
              max={50000}
              step={1000}
              value={book.config.minLiq}
              onChange={(minLiq) => book.patch({ minLiq })}
            />
            <Gate
              label="Stop"
              display={`${book.config.slPct}%`}
              min={-50}
              max={-5}
              step={1}
              value={book.config.slPct}
              onChange={(slPct) => book.patch({ slPct })}
            />
            <Gate
              label="Target"
              display={`+${book.config.tpPct}%`}
              min={20}
              max={200}
              step={5}
              value={book.config.tpPct}
              onChange={(tpPct) => book.patch({ tpPct })}
            />
            <Gate
              label="Scan every"
              display={`${book.config.pollSec}s`}
              min={10}
              max={60}
              step={1}
              value={book.config.pollSec}
              onChange={(pollSec) => book.patch({ pollSec })}
            />
            <div className="sm:col-span-2">
              <p className="text-xs leading-relaxed text-faint">Both paper ledgers start at $0 and track realized plus estimated unrealized P&L. Simulated clips use fixed notional and never borrow from or mirror wallet funds.</p>
            </div>
          </div>
          <p className="mt-4 text-xs leading-normal text-faint">
            Paper clips are capped at $5 each, with a $20 combined notional ceiling and an $8 session-loss stop. Configured stop/target levels use estimated net returns after costs. Missing SOL reference data pauses new entries.
          </p>
          <div className="mt-4 flex min-h-11 items-center justify-between gap-3">
            {confirmReset ? (
              <>
                <span className="text-sm text-muted">Clear the book?</span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    className="press min-h-11 rounded-sm px-3 text-sm text-muted"
                    onClick={() => setConfirmReset(false)}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    className="press min-h-11 rounded-sm bg-accent px-3 text-sm font-medium text-accent-fg"
                    onClick={() => {
                      book.reset();
                      setConfirmReset(false);
                      setPick(null);
                    }}
                  >
                    Clear
                  </button>
                </span>
              </>
            ) : (
              <button
                type="button"
                className="press min-h-11 rounded-sm text-sm text-muted"
                onClick={() => setConfirmReset(true)}
              >
                New book
              </button>
            )}
          </div>
        </Panel>

        <Panel className="order-7 lg:order-none lg:col-span-12" title="Log" meta={fmtClock(book.now)}>
          <ol className="max-h-72 overflow-auto">
            {book.logs.map((line, i) => (
              <li key={`${line.t}-${i}`} className="flex flex-col gap-1 border-b border-line py-2.5 last:border-b-0 sm:flex-row sm:gap-3">
                <div className="flex shrink-0 gap-3">
                  <time className="w-16 font-mono text-xs text-faint tabular-nums">
                    {fmtClock(line.t)}
                  </time>
                  <span className={"w-10 text-xs " + kindClass(line.kind)}>{line.kind}</span>
                </div>
                <span className="min-w-0 text-sm leading-snug text-muted">{line.text}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </main>
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg px-4 pt-3 lg:hidden" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        {hostNote ? <p className="mb-2 line-clamp-2 text-xs leading-snug text-muted" aria-live="polite">{hostNote}</p> : null}
        {armAsk && !owner ? (
          <div className="mb-2">
            <p className="mb-2 text-xs leading-snug text-muted">Wallet is a smoke test. Paper keeps running. Live swaps stay off.</p>
            <div className="flex gap-2">
              <button type="button" className="press min-h-12 flex-1 rounded-sm border border-line text-sm" onClick={() => setArmAsk(false)}>Cancel</button>
              <button type="button" className="press min-h-12 flex-1 rounded-sm bg-accent text-sm font-medium text-accent-fg" onClick={connect}>Connect Phantom</button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            {parkedAsk && book.halted && !running ? (
              <button
                type="button"
                className="press min-h-12 flex-1 rounded-sm border border-line text-base font-medium"
                onClick={() => {
                  book.reset();
                  setParkedAsk(false);
                  setPick(null);
                  setHostNote("Book cleared. Tap start when you want the host to take clips.");
                }}
              >
                Clear book
              </button>
            ) : null}
            <button
              type="button"
              className={"press min-h-12 flex-1 rounded-full text-base font-medium " + (running ? "border border-line bg-elevated text-fg" : "bg-accent text-accent-fg")}
              onClick={toggleHost}
            >
              {running ? "Stop host" : "Start host"}
            </button>
            <button
              type="button"
              className="press min-h-12 shrink-0 rounded-full border border-line px-4 text-sm"
              disabled={Boolean(owner)}
              onClick={() => { if (!owner) setArmAsk(true); }}
            >
              {owner ? "Wallet on" : "Wallet"}
            </button>
          </div>
        )}
      </div>
      {selected ? (
        <Detail
          tok={selected}
          book={book}
          aiLearn={book.aiLearn ?? emptyLearn()}
          regime={regime}
          onInvest={() => {
            book.pin(selected);
            setPick(null);
            document.getElementById("keel-book")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }}
          onBlock={() => {
            book.block(selected.address, selected.symbol);
            setPick(null);
          }}
          onClose={() => setPick(null)}
        />
      ) : null}
    </div>
  );
}

function LiveProcess({
  tokens,
  positions,
  regime,
  process,
  ago,
  halted,
}: {
  tokens: Token[];
  positions: Position[];
  regime: Book["regime"];
  process: string[];
  ago: number;
  halted: boolean;
}) {
  let best: { symbol: string; score: number } | null = null;
  for (const tok of tokens) {
    const scored = scoreOf(tok, DEFAULT_CONFIG, regime);
    if (!best || scored.score > best.score) best = { symbol: tok.symbol, score: scored.score };
  }
  const greens = positions.filter((p) => p.entryMid && p.mark > p.entryMid).length;
  const fading = positions.filter((p) => p.entryMid && p.mark < p.entryMid * 0.96).length;
  const headline = halted
    ? "Parked. This book gave back 4% from its peak, so it will not take another clip until you clear it."
    : positions.length > 0
    ? `${positions.length} in the book. ${greens} above the entry. ${fading} fading.`
    : best && best.score > 0
      ? `Watching ${tokens.length} names. Strongest read is ${best.symbol}.`
      : tokens.length > 0
        ? `${tokens.length} names on the tape. None have cleared a read yet.`
        : "Waiting on the next print.";
  const note = process.find((line) => /Watching|error|disconnect|stream|candidate|cohort/i.test(line))
    ?? process[0]
    ?? "The tape is arming.";
  const facts = [
    { k: "Tape", v: tokens.length ? `${tokens.length} names` : "Quiet" },
    { k: "SOL", v: regime },
    { k: "Book", v: positions.length ? `${positions.length} live` : "Empty" },
    { k: "Pass", v: ago > 0 ? `${ago}s ago` : "Now" },
  ];
  return (
    <div>
      <p className="text-base leading-snug text-fg">{headline}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {facts.map((fact) => (
          <div key={fact.k} className="rounded-xl bg-subtle px-3 py-2">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-faint">{fact.k}</dt>
            <dd className="mt-1 font-mono text-sm tabular-nums">{fact.v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm leading-relaxed text-muted">{note}</p>
    </div>
  );
}

function thoughtLine(tokens: Token[], cfg: Config, regime: Book["regime"], learn: Book["learn"]): string {
  let best: { symbol: string; score: number; pass: boolean; why: string } | null = null;
  let quiet = 0;
  for (const tok of tokens) {
    const scored = scoreOf(tok, cfg, regime, learn);
    if (scored.reasons[0] === "no prints yet") quiet += 1;
    if (!best || scored.score > best.score) {
      best = { symbol: tok.symbol, score: scored.score, pass: scored.score >= cfg.scoreFloor, why: scored.reasons[0] ?? "no read" };
    }
  }
  if (!best) return "Waiting on the next print.";
  if (best.pass) return `Call: ${best.symbol} ${best.score.toFixed(0)}. ${best.why}. The host takes the clip if the reserve can hold it.`;
  if (quiet === tokens.length) return `No call. ${tokens.length} names on the tape and none have a buy or a sell yet.`;
  return `No call. Best ${best.symbol} ${best.score.toFixed(0)}, ${best.why}.`;
}

function Status({ running, halted, live }: { running: boolean; halted: boolean; live: boolean }) {
  const label = halted ? "Parked" : live && running ? "Live" : running ? "Hosting" : live ? "Armed" : "Paused";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span
        className={
          "size-1.5 rounded-full " +
          (halted ? "bg-down" : live && running ? "keel-live bg-up" : running ? "keel-live bg-up" : "bg-faint")
        }
        aria-hidden
      />
      {label}
    </span>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 0,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: number;
}) {
  return (
    <div className="rounded-2xl bg-subtle px-3.5 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">{label}</dt>
      <dd className="mt-1 font-mono text-2xl font-medium tabular-nums tracking-tight">{value}</dd>
      <p className={"line-clamp-2 text-xs tabular-nums " + (tone > 0 ? "text-up" : tone < 0 ? "text-down" : "text-faint")}>
        {hint}
      </p>
    </div>
  );
}

function Panel({
  title,
  meta,
  className,
  action,
  id,
  children,
}: {
  title: string;
  meta: string;
  className?: string;
  action?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={"min-w-0 overflow-hidden rounded-2xl bg-elevated p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-5 " + (className ?? "")}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="shrink-0 text-sm font-medium tracking-tight">{title}</h2>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <span className="truncate text-right text-xs text-faint">{meta}</span>
          {action}
        </div>
      </div>
      {children}
    </section>
  );
}

function Curve({ points }: { points: { t: number; eq: number }[] }) {
  const values = points.map((p) => p.eq);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(0.015, (hi - lo) * 0.35);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 12, right: 4, left: 4, bottom: 4 }}>
        <YAxis hide domain={[lo - pad, hi + pad]} />
        <Tooltip
          cursor={{ stroke: "var(--color-line)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const v = Number(payload[0]?.value ?? 0);
            return (
              <div className="rounded-sm border border-line bg-bg px-2 py-1 font-mono text-xs tabular-nums">
                {fmtUsd(v)}
              </div>
            );
          }}
        />
        <Area
          type="monotone"
          dataKey="eq"
          stroke="var(--color-fg)"
          fill="var(--color-fg)"
          fillOpacity={0.06}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ageLabel(minutes: number): string {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))}s`;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)}m`;
}

function tapeFact(tok: Token, reasons: string[]): string {
  const age = ageLabel(tok.ageMin ?? tok.minutes);
  const why = reasons[0] ?? "no read";
  const wallets = tok.uniqueTraders ? `${tok.uniqueTraders} wallets` : "wallets unverified";
  const move = `${tok.change5m >= 0 ? "+" : ""}${tok.change5m.toFixed(0)}% from open`;
  if (tok.buys + tok.sells === 0) return `${age} · no prints yet · curve ${fmtUsd(tok.liq)} · ${why}`;
  return `${age} · ${tok.buys} buys / ${tok.sells} sells · ${wallets} · curve ${fmtUsd(tok.liq)} · ${move} · ${why}`;
}

function TapeRow({
  tok,
  cfg,
  regime,
  learn,
  aiLearn,
  active,
  held,
  blocked,
  onPick,
}: {
  tok: Token;
  cfg: Config;
  regime: Book["regime"];
  learn: Book["learn"];
  aiLearn: LearnState;
  active: boolean;
  held: boolean;
  blocked: boolean;
  onPick: () => void;
}) {
  const { score, reasons } = scoreOf(tok, cfg, regime, learn);
  const ai = analyzeOpportunity(tok, cfg, regime, aiLearn);
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={
          "flex w-full min-h-12 items-center gap-3 border-b border-line py-3 text-left last:border-b-0 " +
          (active ? "bg-subtle" : "")
        }
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="font-medium">{tok.symbol}</span>
            <span className="text-xs text-faint">
              {tok.mayhem ? "Mayhem" : tok.pumpFun ? "Pump.fun" : tok.dex}
            </span>
            {held ? <span className="text-xs text-muted">in book</span> : blocked ? <span className="text-xs text-faint">blocked</span> : null}
          </span>
          <span className="mt-0.5 block text-xs leading-snug text-muted">
            {tapeFact(tok, reasons)}
          </span>
        </span>
        <span className="w-8 text-right font-mono text-xs tabular-nums text-faint">B {score.toFixed(0)}</span>
        <span className="w-10 text-right font-mono text-sm tabular-nums">AI {ai.score.toFixed(0)}</span>
        <span className={"w-12 text-right text-xs " + (ai.decision === "PAPER_ENTRY" ? "text-up" : ai.decision === "WATCH" ? "text-muted" : "text-down")}>
          {ai.decision === "PAPER_ENTRY" ? "AI pass" : ai.decision === "WATCH" ? "Watch" : "Reject"}
        </span>
      </button>
    </li>
  );
}

function Detail({
  tok,
  book,
  aiLearn,
  regime,
  onInvest,
  onBlock,
  onClose,
}: {
  tok: Token;
  book: Book;
  aiLearn: LearnState;
  regime: Book["regime"];
  onInvest: () => void;
  onBlock: () => void;
  onClose: () => void;
}) {
  const { score, reasons } = scoreOf(tok, book.config, regime, book.learn);
  const ai = analyzeOpportunity(tok, book.config, regime, aiLearn);
  const held = book.positions.some((p) => p.address === tok.address);
  const blocked = (book.blocked ?? []).includes(tok.address);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 p-4 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tok.symbol}
        className="w-full max-w-md rounded-2xl bg-elevated p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-lg font-medium">{tok.symbol}</p>
            <p className="mt-1 text-sm text-muted">{tapeFact(tok, reasons)}</p>
          </div>
          <button type="button" className="press min-h-11 rounded-full px-3 text-sm text-muted" onClick={onClose}>Close</button>
        </div>
        <p className="mt-3 text-sm text-muted">AI {ai.score}/100 · {ai.decision === "PAPER_ENTRY" ? "would pass" : ai.decision === "WATCH" ? "watching" : "would reject"} · baseline {score.toFixed(0)}</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="press min-h-12 flex-1 rounded-full bg-accent text-sm font-medium text-accent-fg"
            onClick={onInvest}
          >
            {held ? "In the book" : "Invest"}
          </button>
          <button
            type="button"
            className="press min-h-12 flex-1 rounded-full border border-line text-sm font-medium"
            onClick={onBlock}
          >
            {blocked ? "Blocked" : "Block"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-faint">{k}</dt>
      <dd className="mt-0.5 font-mono tabular-nums text-fg">{v}</dd>
    </div>
  );
}

function BookRow({
  p,
  onClose,
}: {
  p: Position;
  onClose: () => void;
}) {
  const pct = pnlPct(p);
  const sol = paperExit(p.entry, p.mark, p.sizeUsd, p.markLiquidityUsd ?? 0).pnl - (p.entryFee ?? p.sizeUsd * 0.0125);
  return (
    <li className="flex items-center gap-2 border-b border-line py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium">{p.symbol}</span>
          <span className="text-xs text-faint">{p.signature ? "on-chain" : "Solana"}</span>
        </div>
        <p className="text-xs leading-snug text-faint">
          {fmtUsd(p.sizeUsd)} · {p.reasons.includes("pinned") ? "pinned" : "host"} · {pct <= -4 ? "fading" : pct > 0 ? "green" : "live"}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className={"font-mono text-sm tabular-nums " + (pct >= 0 ? "text-up" : "text-down")}>
          {pct >= 0 ? "+" : ""}
          {pct.toFixed(1)}%
        </p>
        <p className="font-mono text-xs tabular-nums text-muted">{fmtSigned(sol)}</p>
      </div>
      <button type="button" className="press min-h-11 rounded-sm px-2 text-sm text-muted" onClick={onClose}>
        Close
      </button>
    </li>
  );
}

function Money({
  label,
  value,
  min,
  hint,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  hint: string;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <label className={"block " + (disabled ? "opacity-40" : "")}>
      <span className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="truncate text-xs text-muted">{hint}</span>
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        step="0.01"
        value={Number.isFinite(value) ? value : ""}
        disabled={disabled}
        aria-label={label}
        className="h-12 w-full rounded-sm border border-line bg-bg px-3 font-mono text-base tabular-nums"
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

function Gate({
  label,
  display,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
}: {
  label: string;
  display: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <label className={"block " + (disabled ? "opacity-40" : "")}>
      <span className="mb-1.5 flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono text-xs tabular-nums text-muted">{display}</span>
      </span>
      <input
        type="range"
        className="keel-range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function kindClass(kind: "info" | "skip" | "buy" | "sell"): string {
  if (kind === "buy") return "text-fg";
  if (kind === "sell") return "text-muted";
  return "text-faint";
}

function signed(n: number): string {
  return `${fmtSigned(n)} session`;
}
