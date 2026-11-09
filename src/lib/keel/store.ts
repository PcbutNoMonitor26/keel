import { create } from "zustand";
import { advanceAiShadow, emptyAiShadow, type AiShadowState } from "@/lib/keel/ai-shadow";
import { emptyLearn, recordLane, type LearnState } from "@/lib/keel/learn";
import { persist } from "zustand/middleware";
import {
  applyScan,
  commitLiveBuy,
  emptyBook,
  equityOf,
  flatten,
  blockName,
  manualBuy,
  manualClose,
  pinToBook,
  planClip,
  scoreOf,
  DEFAULT_CONFIG,
  MAX_PAPER_CLIP_USD,
  type Book,
  type Config,
  type Scan,
  type Token,
} from "@/lib/keel/engine";

type DeskState = Book & {
  aiShadow: AiShadowState;
  aiLearn: LearnState;
  hydrated: boolean;
  setHydrated: () => void;
  start: () => void;
  stop: () => void;
  ingest: (scan: Scan) => void;
  fill: (address: string) => void;
  pin: (tok: Token) => void;
  block: (address: string, symbol: string) => void;
  requestTake: (address: string) => void;
  close: (address: string) => void;
  requestClose: (address: string) => void;
  flattenBook: () => void;
  reset: () => void;
  patch: (partial: Partial<Config>) => void;
  arm: () => void;
  disarm: () => void;
  note: (text: string) => void;
  drop: (address: string, action: "buy" | "sell") => void;
  commitBuy: (address: string, signature: string, rawOut: string, spent?: number) => void;
};

const seed = emptyBook();

export const useDesk = create<DeskState>()(
  persist(
    (set) => ({
      ...seed,
      aiShadow: emptyAiShadow(),
      aiLearn: emptyLearn(),
      hydrated: false,
      setHydrated: () => set({ hydrated: true }),
      start: () =>
        set((s) => {
          if (s.halted) return {
            logs: [{ t: s.now || Date.now(), kind: "info" as const, text: "Paper loss limit reached. Reset the paper ledger before restarting." }, ...s.logs].slice(0, 80),
          };
          return {
            running: true,
            logs: [{ t: s.now, kind: "info" as const, text: "Host armed. Next print can take a trade." }, ...s.logs].slice(0, 80),
          };
        }),
      stop: () =>
        set((s) => ({
          running: false,
          logs: [
            { t: s.now, kind: "info" as const, text: "Host stopped. Open marks keep updating. No new takes." },
            ...s.logs,
          ].slice(0, 80),
        })),
      ingest: (scan) => set((s) => {
        const next = applyScan(s, scan);
        const before = s.aiShadow.trades.length;
        const aiShadow = advanceAiShadow(s.aiShadow, scan, next.config, s.aiLearn, next.model?.weights ?? null);
        const added = aiShadow.trades.slice(0, Math.max(0, aiShadow.trades.length - before));
        let aiLearn = s.aiLearn;
        for (const trade of added) {
          if (trade.features?.length) aiLearn = recordLane(aiLearn, trade.features, trade.pnlPct);
        }
        return { ...next, aiLearn, aiShadow };
      }),
      fill: (address) => set((s) => manualBuy(s, address)),
      pin: (tok) => set((s) => pinToBook(s, tok)),
      block: (address, symbol) => set((s) => blockName(s, address, symbol)),
      requestTake: (address) =>
        set((s) => {
          const tok = s.tokens.find((t) => t.address === address);
          if (!tok || s.positions.some((p) => p.address === address)) return s;
          const { score, reasons } = scoreOf(tok, s.config, s.regime);
          const stamp = s.now || Date.now();
          if (score < s.config.scoreFloor) {
            return {
              logs: [{ t: stamp, kind: "skip" as const, text: `${tok.symbol} blocked · ${reasons[0] ?? "gate"}` }, ...s.logs].slice(0, 80),
            };
          }
          if (!s.live) {
            return {
              logs: [{ t: stamp, kind: "info" as const, text: `${tok.symbol} passed. Connect a wallet to send it.` }, ...s.logs].slice(0, 80),
            };
          }
          if (s.staged.some((st) => st.action === "buy" && st.address === address)) return s;
          const plan = planClip(s, tok);
          if (!plan.ok) {
            return {
              logs: [{ t: stamp, kind: "skip" as const, text: `${tok.symbol} — ${plan.error}` }, ...s.logs].slice(0, 80),
            };
          }
          return {
            staged: [...s.staged, { action: "buy" as const, address, symbol: tok.symbol, why: reasons.slice(0, 3).join(", "), user: true }],
            logs: [{ t: stamp, kind: "info" as const, text: `Queued ${tok.symbol}. The wallet opens next.` }, ...s.logs].slice(0, 80),
          };
        }),
      close: (address) => set((s) => manualClose(s, address)),
      requestClose: (address) =>
        set((s) => {
          const p = s.positions.find((x) => x.address === address);
          if (!p) return s;
          if (!p.signature) return manualClose(s, address);
          if (s.staged.some((st) => st.action === "sell" && st.address === address)) return s;
          return {
            staged: [...s.staged, { action: "sell" as const, address, symbol: p.symbol, why: "manual", user: true }],
            logs: [{ t: s.now || Date.now(), kind: "info" as const, text: `Queued ${p.symbol} sell. The wallet opens next.` }, ...s.logs].slice(0, 80),
          };
        }),
      flattenBook: () => set((s) => flatten(s)),
      reset: () => set(() => ({ ...emptyBook(), aiShadow: emptyAiShadow(), aiLearn: emptyLearn(), hydrated: true, now: Date.now() })),
      arm: () =>
        set((s) => ({
          live: false,
          logs: [
            { t: s.now || Date.now(), kind: "info" as const, text: "Live trading is disabled while AI shadow validation is in progress. No wallet swaps can be staged." },
            ...s.logs,
          ].slice(0, 80),
        })),
      disarm: () =>
        set((s) => ({
          live: false,
          staged: s.staged.filter((job) => job.user),
          logs: [
            { t: s.now || Date.now(), kind: "info" as const, text: "Disarmed. The tape keeps scoring. New passes wait." },
            ...s.logs,
          ].slice(0, 80),
        })),
      note: (text) =>
        set((s) =>
          s.logs[0]?.text === text
            ? s
            : { logs: [{ t: s.now || Date.now(), kind: "info" as const, text }, ...s.logs].slice(0, 80) },
        ),
      drop: (address, action) =>
        set((s) => ({ staged: s.staged.filter((job) => !(job.address === address && job.action === action)) })),
      commitBuy: (address, signature, rawOut, spent) =>
        set((s) => commitLiveBuy(s, address, signature, rawOut, spent)),
      patch: (partial) =>
        set((s) => ({
          config: {
            ...s.config, ...partial, startingUsd: 0,
            buyUsd: partial.buyUsd == null ? s.config.buyUsd : Math.min(MAX_PAPER_CLIP_USD, Math.max(1, partial.buyUsd)),
            maxPositions: Math.max(1, Math.min(4, Math.floor(partial.maxPositions ?? s.config.maxPositions))),
          },
        })),
    }),
    {
      name: "keel-solana-desk-v3",
      version: 4,
      migrate: (persistedState: unknown) => {
        const saved = (persistedState ?? {}) as Partial<DeskState>;
        const legacyStart = Math.max(0, Number(saved.config?.startingUsd ?? DEFAULT_CONFIG.startingUsd));
        const realized = Number.isFinite(Number(saved.realized)) ? Number(saved.realized) : Number(saved.cash ?? legacyStart) - legacyStart;
        const legacyAi = saved.aiShadow;
        const legacyAiStart = Math.max(0, Number(legacyAi?.startingUsd ?? legacyStart));
        const aiRealized = Number(legacyAi?.realized ?? 0);
        return {
          ...saved,
          config: { ...DEFAULT_CONFIG, ...saved.config, startingUsd: 0,
            buyUsd: Math.min(MAX_PAPER_CLIP_USD, Math.max(1, Number(saved.config?.buyUsd ?? DEFAULT_CONFIG.buyUsd))),
            maxPositions: Math.max(1, Math.min(4, Math.floor(Number(saved.config?.maxPositions ?? DEFAULT_CONFIG.maxPositions)))) },
          cash: realized,
          peak: Math.max(0, Number(saved.peak ?? legacyStart) - legacyStart),
          equity: (saved.equity ?? []).map((point) => ({ ...point, eq: Number(point.eq) - legacyStart })),
          aiShadow: legacyAi ? { ...legacyAi, startingUsd: 0, cash: aiRealized,
            peak: Math.max(0, Number(legacyAi.peak ?? legacyAiStart) - legacyAiStart) } : emptyAiShadow(),
          running: false, live: false, staged: [],
        };
      },
      partialize: (s) => ({
        now: s.now,
        cash: s.cash,
        realized: s.realized,
        peak: s.peak,
        halted: s.halted,
        running: s.running,
        regime: s.regime,
        sol: s.sol,
        ret1: s.ret1,
        ret5: s.ret5,
        sol15: s.sol15,
        vol1m: s.vol1m,
        config: s.config,
        positions: s.positions,
        seen: s.seen,
        logs: s.logs,
        equity: s.equity,
        aiShadow: s.aiShadow,
        aiLearn: s.aiLearn,
        learn: s.learn,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);
