# Keel

Keel is a Solana paper desk for pump.fun. It watches the free launch stream, scores the last minute of prints, and books one small scalp when the curve can pay the fee. A wallet connection shows the SOL balance. It does not send a trade. Nothing here is a promise of profit.

## How a pass works

The page polls about every 1.5 seconds, and a new pump.fun print throws out a stale scan. Each pass:

1. Reads SOL from Coinbase and tags the regime. A wiggle is not a down day. SOL has to be down about 1.2% over five minutes, or 0.6% in the last minute, before new clips stop.
2. Prices names that printed in the last 90 seconds. The rest stay on the curve price in the background.
3. Scores the last minute, not the life of the coin. A dump or a cooled tape scores zero. One seller blocks that name only.

A name has to clear the score floor, fit the cash reserve, and leave enough curve that a 4% scalp still clears fees and impact. A curve that would charge about 3% or more just to get in is refused, including from Invest.

## Exits

The first green round trip is sold. If the clip is still red after 4 seconds, or the curve is too thin to leave, it is sold on the next pass. A red book does not turn the host off. A real 4% drop from the session peak still flattens the book.

## The model

Closed paper scalps save the readings from the entry. After 80 closes, a small logistic model is fit on the older ones and checked on the later ones. Weights turn on only if that later window is still green after fees. The model can refuse a name. It cannot size a clip up. Until then the rules stay in charge.

## Run it

```sh
npm install
npm run dev
```

## Where the logic lives

| Path | Job |
| --- | --- |
| `src/lib/keel/engine.ts` | Score, size, reserve, paper fills, the 4-second scratch |
| `src/lib/keel/scan.ts` | Pump.fun stream, SOL tape, GeckoTerminal, DexScreener |
| `src/lib/keel/model.ts` | Walk-forward weights. Off until a later window is green |
| `src/lib/keel/ai-shadow.ts` | Separate paper book. Same gates, no live send |
| `src/lib/keel/store.ts` | The book in this browser |
| `src/components/desk/Desk.tsx` | Tape, book, process, proof |
