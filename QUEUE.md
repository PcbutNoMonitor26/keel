# KEEL shared queue

Updated 2026-11-07 by Grok, for the next model (ChatGPT or otherwise).
Repo: `pcnomonitor-hue/keel`. Branch: `solana-only-hardening`. Last published commit on that branch when this note was written: `786f970`.

Read this file before editing. Take the first open item. Finish that item. Check it off here, write what you actually verified, and commit the update on `solana-only-hardening`. Do not open a new idea while an item above yours is open. Do not merge to `main` until the proof gate below is met.

## Proof gate

A close is the next live mid, minus impact, minus a 1% fee. It is not a backtest. `proofLine` in `src/lib/keel/learn.ts` is the only sentence that counts.

Do not say the book prints until all of these are true on a live paper session in the browser:

- at least 8 closes
- net USD after costs is positive
- profit factor is above 1

Until then the desk is required to say it is too early. If the first 8 closes are behind the fee hurdle, tighten the lane that lost. Do not loosen a gate to manufacture a green number. Do not book junk names to inflate the close count.

Live sends stay off. `LIVE_TRADING_ENABLED` in `src/components/desk/Desk.tsx` stays `false` until the owner writes a separate yes after the proof gate.

## Already on `786f970` — do not redo

- Solana only. Polymarket is gone.
- Paper fill uses impact plus a 1% fee. Counterfactual P&L is `paperExit`.
- Learning lanes: mayhem, pump.fun, early, bid, chase, live. Five losing closes make that lane harder and the clip smaller.
- Mayhem does not fire without two-sided flow or six wallets. Exit is 90s / +8% / −5%.
- The AI shadow book uses the same penalties. A name it just closed waits 10 minutes.
- Wallet swaps are hard-disabled during shadow validation.

## In the Grok preview, not in `786f970` yet

If you copy an older `Desk.tsx` or `scan.ts` you will wipe these. Port them if they are missing, do not revert them:

- Phone dock: Start host / Stop host / Wallet. A 10% drawdown park explains itself and offers Clear book. Start waits until the persisted book has hydrated so the tap is not overwritten.
- Pump.fun websocket `error` must not call `socket.close()`. That re-entered the error event and killed the Node process, which made Start look dead.
- Share cards, if missing: `public/og.jpg` at 1200×630, `public/x-banner.jpg` at 1200×264, `src/lib/og/site.json` with `"type": "x:game"` and `"card": "custom"`.

## Open

1. [ ] Port the preview fixes above onto `solana-only-hardening` if the tree does not already have them. Verify: unit tests, `tsc`, homepage answers, Start toggles Hosting, a scan does not crash the server.
2. [ ] Run one live paper session. The tape must be live coins (Pump.fun plus Gecko), not a fixture. A taken clip stores entry mid, impact, and best mid. A close increments `proofLine` and a learn bucket.
3. [ ] Fix the first real defect that session shows. One defect per commit. Likely candidates: a scammy name still passing, mayhem firing with no wallets, the host parking with no on-screen reason, the scan process dying.
4. [ ] After 8 live closes, paste the exact `proofLine` string under Notes. If it is behind the fee hurdle, tighten that lane and keep paper running. Do not flip live.
5. [ ] Only after the proof gate, stop and ask the owner before anyone sets `LIVE_TRADING_ENABLED` to true.

## Notes

(empty — the next model writes the verification here)
