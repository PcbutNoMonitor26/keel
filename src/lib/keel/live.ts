const SOL = "So11111111111111111111111111111111111111112";

type Phantom = {
  isPhantom?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  signAndSendTransaction: (tx: unknown) => Promise<{ signature: string } | string>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export function phantom(): Phantom | null {
  if (typeof window === "undefined") return null;
  const sol = (window as unknown as { solana?: Phantom }).solana;
  if (!sol || typeof sol.signAndSendTransaction !== "function") return null;
  return sol;
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function solPrice(): Promise<number> {
  const res = await fetch("https://api.exchange.coinbase.com/products/SOL-USD/ticker", {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("SOL price feed failed");
  const body = (await res.json()) as { price?: string };
  const px = Number(body.price);
  if (!Number.isFinite(px) || px <= 0) throw new Error("SOL price feed failed");
  return px;
}

function impactPct(raw: unknown): number {
  if (raw == null || raw === "") return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return Number.POSITIVE_INFINITY;
  return n <= 1 ? n * 100 : n;
}

async function quote(inputMint: string, outputMint: string, amount: string): Promise<Record<string, unknown>> {
  const url =
    "https://lite-api.jup.ag/swap/v1/quote?slippageBps=100&" +
    `inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error("No Jupiter route for this mint");
  const body = (await res.json()) as Record<string, unknown>;
  if (!body.outAmount) throw new Error("No Jupiter route for this mint");
  if (impactPct(body.priceImpactPct) > 8) throw new Error("Price impact over 8%. Swap refused.");
  return body;
}

async function send(owner: string, quoteResponse: Record<string, unknown>): Promise<{ signature: string; outAmount: string }> {
  const wallet = phantom();
  if (!wallet) throw new Error("No Solana wallet in this browser");
  const res = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: owner,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!res.ok) throw new Error("Jupiter could not build the swap");
  const body = (await res.json()) as { swapTransaction?: string };
  if (!body.swapTransaction) throw new Error("Jupiter could not build the swap");
  const { VersionedTransaction } = await import("@solana/web3.js");
  const tx = VersionedTransaction.deserialize(bytes(body.swapTransaction));
  const signed = await wallet.signAndSendTransaction(tx);
  const signature = typeof signed === "string" ? signed : signed.signature;
  if (!signature) throw new Error("Wallet returned no signature");

  // A wallet signature only proves submission. Wait for the cluster to confirm
  // the transaction before allowing the desk to book or close a position.
  const rpc = "https://api.mainnet-beta.solana.com";
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    let statusRes: Response;
    try {
      statusRes = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignatureStatuses",
          params: [[signature], { searchTransactionHistory: true }],
        }),
      });
    } catch {
      throw new Error(`Swap submitted (${signature}) but confirmation lookup failed. Inspect the signature before retrying.`);
    }
    if (!statusRes.ok) throw new Error(`Swap submitted (${signature}) but confirmation lookup failed. Check the signature before retrying.`);
    const statusBody = (await statusRes.json()) as {
      result?: { value?: Array<{ err?: unknown; confirmationStatus?: string | null } | null> };
    };
    const status = statusBody.result?.value?.[0];
    if (status?.err) throw new Error(`Swap transaction failed on-chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return { signature, outAmount: String(quoteResponse.otherAmountThreshold ?? quoteResponse.outAmount ?? "") };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Swap submitted (${signature}) but confirmation is unknown. Inspect it on Solana Explorer before retrying.`);
}

export async function solCover(owner: string): Promise<{ usd: number; spendable: number }> {
  const px = await solPrice();
  const rpcs = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
  let lamports: number | null = null;
  for (const rpc of rpcs) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [owner] }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { result?: { value?: number } };
      if (typeof body.result?.value === "number") {
        lamports = body.result.value;
        break;
      }
    } catch {
      continue;
    }
  }
  if (lamports == null) throw new Error("SOL balance feed failed");
  const usd = (lamports / 1e9) * px;
  return { usd, spendable: Math.max(0, usd - px * 0.004) };
}

export async function connectWallet(): Promise<string> {
  const wallet = phantom();
  if (!wallet) throw new Error("No Solana wallet in this browser. Open Keel in Phantom or with the extension installed.");
  const res = await wallet.connect();
  return res.publicKey.toString();
}

export async function trustedOwner(): Promise<string | null> {
  const wallet = phantom();
  if (!wallet) return null;
  try {
    const res = await wallet.connect({ onlyIfTrusted: true });
    return res.publicKey.toString();
  } catch {
    return null;
  }
}

export function watchWallet(onChange: (owner: string | null) => void): () => void {
  const wallet = phantom();
  if (!wallet?.on) return () => {};
  const account = (key: unknown) => {
    const next = key && typeof key === "object" && "toString" in key ? String((key as { toString(): string }).toString()) : null;
    onChange(next && next !== "null" ? next : null);
  };
  const gone = () => onChange(null);
  wallet.on("accountChanged", account);
  wallet.on("disconnect", gone);
  return () => {
    wallet.off?.("accountChanged", account);
    wallet.off?.("disconnect", gone);
  };
}

export async function buyToken(owner: string, mint: string, usd: number): Promise<{ signature: string; outAmount: string }> {
  const px = await solPrice();
  const lamports = Math.floor((usd / px) * 1e9);
  if (lamports < 1_000_000) throw new Error("Clip is under 0.001 SOL");
  // Snapshot this mint before the swap so pre-existing wallet holdings are not
  // accidentally included in Keel's position size.
  const before = BigInt(await tokenBalance(owner, mint));
  const q = await quote(SOL, mint, String(lamports));
  const sent = await send(owner, q);
  let after: bigint;
  try {
    after = BigInt(await tokenBalance(owner, mint));
  } catch {
    throw new Error(`Swap confirmed (${sent.signature}) but the post-buy token balance could not be reconciled. Pause live trading and inspect the wallet before retrying.`);
  }
  const acquired = after - before;
  if (acquired <= 0n) throw new Error(`Swap confirmed (${sent.signature}) but the acquired token balance could not be reconciled. Live trading must remain paused until manually checked.`);
  return { ...sent, outAmount: acquired.toString() };
}

async function tokenBalance(owner: string, mint: string): Promise<string> {
  const rpc = "https://api.mainnet-beta.solana.com";
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
      params: [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
    }),
  });
  if (!res.ok) throw new Error("Could not reconcile the wallet's token balance. Sell paused.");
  const body = (await res.json()) as {
    result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }> };
    error?: unknown;
  };
  if (body.error || !Array.isArray(body.result?.value)) throw new Error("Could not reconcile the wallet's token balance. Sell paused.");
  let total = 0n;
  for (const item of body.result.value) {
    const amount = item.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) throw new Error("Wallet returned an invalid token balance. Sell paused.");
    total += BigInt(amount);
  }
  return total.toString();
}
export async function sellToken(owner: string, mint: string, _rawAmount: string): Promise<{ signature: string }> {
  // Use the wallet's actual current token balance, never an estimated quote output.
  const current = BigInt(await tokenBalance(owner, mint));
  const recorded = BigInt(_rawAmount || "0");
  const amount = current < recorded ? current : recorded;
  if (amount <= 0n) throw new Error("No reconciled Keel token balance available to sell.");
  const q = await quote(mint, SOL, amount.toString());
  const sent = await send(owner, q);
  let remaining: bigint;
  try {
    remaining = BigInt(await tokenBalance(owner, mint));
  } catch {
    throw new Error(`Sell confirmed (${sent.signature}) but the post-sell token balance could not be reconciled. Pause live trading and inspect the wallet before retrying.`);
  }
  if (remaining > current - amount) {
    throw new Error(`Sell confirmed (${sent.signature}) but the wallet still holds an unreconciled token amount. Pause live trading and inspect the wallet before retrying.`);
  }
  return sent;
}
