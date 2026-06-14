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

// Shape of each step item returned by Relay.link's execute endpoint.
interface RelayTxData {
  from?: string;
  to: string;
  data: string;
  value?: string; // hex or decimal string
  chainId?: number;
}

interface RelayStep {
  id: string;
  items: Array<{ status: string; data: RelayTxData }>;
}

/**
 * Execute a Gnosis → destination USDC bridge via Relay.link.
 *
 * Relay.link returns an ordered list of steps (typically: approve + bridge).
 * Each step's transaction is handed to `exec` for signing and submission;
 * `exec` must return the tx hash. Steps run sequentially — the bridge step
 * depends on the approval being confirmed first.
 *
 * @param params   Same fields as quoteBridge — re-calls the API at execution
 *                 time so the calldata is fresh and not stale from the quote.
 * @param exec     Caller-provided signer: signs + submits one tx, returns hash.
 */
export async function executeBridge(
  params: {
    originChainId: number;
    destinationChainId: number;
    currency: string;
    toCurrency: string;
    amountWei: bigint;
    recipient: string;
    user: string;
  },
  exec: (tx: { to: string; data: string; value: bigint; chainId: number }) => Promise<string>
): Promise<{ originTxHash: string }> {
  const res = await fetch(`${RELAY_API}/execute/bridge`, {
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
  if (!res.ok) {
    throw new Error(`relay execute failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { steps?: RelayStep[] };
  const steps = json.steps ?? [];
  if (steps.length === 0) throw new Error("relay returned no bridge steps");

  let lastHash = "";
  for (const step of steps) {
    for (const item of step.items) {
      if (item.status === "complete") continue;
      const d = item.data;
      // value may be hex ("0x...") or decimal string or absent
      const value =
        d.value === undefined || d.value === "0x0" || d.value === "0"
          ? 0n
          : d.value.startsWith("0x")
          ? BigInt(d.value)
          : BigInt(d.value);

      lastHash = await exec({
        to: d.to,
        data: d.data,
        value,
        chainId: d.chainId ?? params.originChainId,
      });
    }
  }

  return { originTxHash: lastHash };
}
