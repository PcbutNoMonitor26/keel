# KEEL shared queue

Updated 2026-11-22 by Keel Optimizer, on branch `optimizer/restore-paper-gates` of `PcbutNoMonitor26/keel`.

Read this file before editing. Take the first open item. Finish that item. Check it off here, write what you actually verified, and commit the update. Do not merge to `main` until the proof gate below is met.

## Proof gate

A close is the next live mid, minus impact, minus a 0.5% per-side fee. It is not a backtest. `proofLine` in `src/lib/keel/learn.ts` is the only sentence that counts.

Do not say the book prints until all of these are true on a live paper session:

- at least 8 closes
- net USD after costs is positive
- profit factor is above 1

Until then the desk is required to say it is too early. If the first 8 closes are behind the fee hurdle, tighten the lane that lost. Do not loosen a gate to manufacture a green number. Do not book junk names to inflate the close count.

Live sends stay off. `LIVE_TRADING_ENABLED` in `src/components/desk/Desk.tsx` stays `false` until the owner writes a separate yes after the proof gate. `arm()` may set `live: true` only after this same proof gate; Desk still will not send a transaction while the flag is false.

## Defaults now on this branch

- `paperExit` fee is 0.5% per side (`PAPER_FEE` in `engine.ts`).
- `scoreFloor` is 54, `maxPositions` is 6. Auto-entry is still capped by `riskFor().slots`, which remains 1.
- `proofLine` leads with the closed paper $ figure.
- The Desk proof panel and header show paper $ (realized) and session equity.

## Notes

On 2026-11-22 the three latest commits on `main` (`0a3349a`, `10efebe`, `e7092ac`) replaced `engine.ts`, `learn.ts`, `store.ts`, `Desk.tsx`, `QUEUE.md`, and `README.md` with `$(cat /tmp/...)` stubs. Those files were restored from `4d482a1` and the intended edits were re-applied on this branch. Do not merge `main` as it stood at `e7092ac` — the desk cannot boot from those stubs.

### Recorded live paper proofLines (cloud agent transcript bc-6392c796, 1.25% fee era)

First session (~75s, Playwright against the live pump.fun tape):

- `Paper proof: 2 of 8 closes. Too early to claim an edge. A close is the live mid after impact and 1.25% per-side venue fees, not a backtest.`
- 2 closes, 0 wins, netUsd=-0.5410892856467364
- BACKPACK $8.00 · 86 · pump.fun, 3m old, 13 buys, no-lift, net=-0.2642602962878241, lanes pump/thin/chase/bid, -2.0532537035978016%
- ORANGE $7.99 · 76 · pump.fun, 2m old, 10 buys, no-lift, incremental net ≈ -0.2768, lanes pump/thin/chase/early, early -2.2149405981318133%
- pump/thin/chase n=2 sumR=-4.268194301729615

Raising the curve floor to $8,000 and later $4,500 produced zero takes (dozens of live names, mostly “no prints” / “thin curve”). The chase ≥18% refusal was the useful tighten from that session; the high floor was later rolled back in the cloud workspace and never landed on this GitHub repo.

Later session (~6 minutes, same 1.25% fee, after some local tightens in the cloud workspace):

- Same proofLine: `Paper proof: 2 of 8 closes. Too early to claim an edge. A close is the live mid after impact and 1.25% per-side venue fees, not a backtest.`
- 2 closes, 0 wins, netUsd=-0.5507500342232274, grossWin=0, grossLoss=0.5507500342232274, sumR=-4.389121160211169
- BACKPACKERS $7.99 · 98 · trench, pump.fun, 1m, no-lift
- BP $8.00 · 100 · trench, pump.fun, 1m, no-lift (book was full after the first; risk.slots=1)
- buckets: pump/early/thin n=2 sumR=-4.389121160211169; bid n=1 sumR=-2.168743183746935
- Early lane average about -2.2% (fee-sized). The cloud agent decided to require pump/trench age ≥ 2 minutes rather than change `laneAdjust`, and the transcript ended mid-commit. That age gate is not on `main`.

The proof gate has not been met.
