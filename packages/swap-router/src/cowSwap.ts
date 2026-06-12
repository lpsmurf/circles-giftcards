// CoW Protocol on Gnosis Chain: quote and execute wrapped-CRC → USDC swaps.
// Quoting needs no keys (public order book API). Execution requires the
// orchestrator's spend-limited Safe module key (see docs/SECURITY.md).

const COW_API = process.env.COW_API_URL ?? "https://api.cow.fi/xdai/api/v1";

// Gnosis Chain token addresses
export const TOKENS = {
  USDC_E: "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0", // USDC.e (native, Gnosis)
  WXDAI: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
} as const;

export interface CowQuote {
  sellToken: string;
  buyToken: string;
  sellAmount: bigint; // CRC wei needed
  buyAmount: bigint; // USDC out (6 decimals on USDC.e wrapper semantics may differ)
  feeAmount: bigint;
  validTo: number;
  quoteId: number | null;
}

// Quote: how much `sellToken` (wrapped CRC) must be sold to receive exactly
// `buyAmountWei` of USDC. Uses a buy-order quote so the USDC leg is fixed.
export async function quoteSellForExactBuy(params: {
  sellToken: string; // wrapped CRC ERC-20 address
  buyAmountWei: bigint; // USDC needed (product price + settlement cost)
  receiver: string;
  from: string;
}): Promise<CowQuote> {
  const res = await fetch(`${COW_API}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sellToken: params.sellToken,
      buyToken: TOKENS.USDC_E,
      receiver: params.receiver,
      from: params.from,
      kind: "buy",
      buyAmountAfterFee: params.buyAmountWei.toString(),
      validFor: 90, // matches our quote expiry
      partiallyFillable: false,
      signingScheme: "presign", // Safe-compatible
    }),
  });
  if (!res.ok) throw new Error(`cow quote failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    quote: {
      sellToken: string;
      buyToken: string;
      sellAmount: string;
      buyAmount: string;
      feeAmount: string;
      validTo: number;
    };
    id: number | null;
  };
  return {
    sellToken: json.quote.sellToken,
    buyToken: json.quote.buyToken,
    sellAmount: BigInt(json.quote.sellAmount),
    buyAmount: BigInt(json.quote.buyAmount),
    feeAmount: BigInt(json.quote.feeAmount),
    validTo: json.quote.validTo,
    quoteId: json.id,
  };
}

// Execution skeleton — submits the order and pre-signs via the Safe module.
// Gated behind OPERATOR_KEY; not enabled until the M2 security review (see
// prepkit/MILESTONES.md).
export async function executeSwap(_quote: CowQuote): Promise<{ orderUid: string }> {
  if (!process.env.OPERATOR_KEY) {
    throw new Error("swap execution disabled: OPERATOR_KEY not configured (M2)");
  }
  throw new Error("not implemented: pending Safe module deployment (M2)");
}
