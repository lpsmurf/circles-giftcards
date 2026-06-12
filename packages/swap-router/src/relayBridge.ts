// Relay.link bridging: move USDC from Gnosis to the chosen settlement chain.
// Same pattern as HFSP Labs' gnosis-card-x402 (~$0.03–0.10 flat, ~90 s).

const RELAY_API = process.env.RELAY_API_URL ?? "https://api.relay.link";

export interface BridgeQuote {
  originChainId: number;
  destinationChainId: number;
  amountIn: bigint;
  amountOut: bigint;
  totalFeeUsd: number;
  estimatedSeconds: number;
}

export async function quoteBridge(params: {
  originChainId: number; // 100 = Gnosis
  destinationChainId: number; // e.g. 8453 = Base
  currency: string; // token address on origin
  toCurrency: string; // token address on destination
  amountWei: bigint;
  recipient: string;
  user: string;
}): Promise<BridgeQuote> {
  const res = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: params.user,
      recipient: params.recipient,
      originChainId: params.originChainId,
      destinationChainId: params.destinationChainId,
      originCurrency: params.currency,
      destinationCurrency: params.toCurrency,
      amount: params.amountWei.toString(),
      tradeType: "EXACT_OUTPUT",
    }),
  });
  if (!res.ok) throw new Error(`relay quote failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    fees?: { relayer?: { amountUsd?: string }; gas?: { amountUsd?: string } };
    details?: { currencyIn?: { amount?: string }; currencyOut?: { amount?: string }; timeEstimate?: number };
  };
  return {
    originChainId: params.originChainId,
    destinationChainId: params.destinationChainId,
    amountIn: BigInt(json.details?.currencyIn?.amount ?? "0"),
    amountOut: BigInt(json.details?.currencyOut?.amount ?? "0"),
    totalFeeUsd:
      Number(json.fees?.relayer?.amountUsd ?? 0) + Number(json.fees?.gas?.amountUsd ?? 0),
    estimatedSeconds: json.details?.timeEstimate ?? 90,
  };
}

export async function executeBridge(_quote: BridgeQuote): Promise<{ txHash: string }> {
  if (!process.env.OPERATOR_KEY) {
    throw new Error("bridge execution disabled: OPERATOR_KEY not configured (M2)");
  }
  throw new Error("not implemented: pending M2 (see prepkit/MILESTONES.md)");
}
