// Cheapest-chain settlement selection (docs/SWAP-ROUTING.md).
// cost(c) = bridgeFee(Gnosis→c) + gasCost(c) + upstreamFee(c); pick argmin.

import { quoteBridge } from "./relayBridge.js";

export interface SettlementCandidate {
  chainId: number;
  name: string;
  usdcAddress: string;
  estGasUsd: number; // rough payment-tx gas, refreshed periodically in M2
}

// Chains Cryptorefills reports via getPaymentViasWithCurrencies, narrowed to
// EVM chains our operator wallets support. Gnosis listed first: if accepted
// upstream it wins on cost virtually always (gas ≈ $0.001, no bridge).
export const CANDIDATES: SettlementCandidate[] = [
  { chainId: 100, name: "gnosis", usdcAddress: "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0", estGasUsd: 0.001 },
  { chainId: 8453, name: "base", usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", estGasUsd: 0.01 },
  { chainId: 137, name: "polygon", usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", estGasUsd: 0.01 },
];

export interface RoutingDecision {
  chain: SettlementCandidate;
  bridgeFeeUsd: number;
  totalCostUsd: number;
}

export async function selectSettlementChain(params: {
  amountUsdcWei: bigint;
  acceptedChainNames: string[]; // from getPaymentViasWithCurrencies, lowercased
  operatorAddress: string;
}): Promise<RoutingDecision> {
  const accepted = CANDIDATES.filter((c) => params.acceptedChainNames.includes(c.name));
  if (accepted.length === 0) throw new Error("no supported settlement chain accepted upstream");

  const costs = await Promise.all(
    accepted.map(async (chain) => {
      let bridgeFeeUsd = 0;
      if (chain.chainId !== 100) {
        const q = await quoteBridge({
          originChainId: 100,
          destinationChainId: chain.chainId,
          currency: CANDIDATES[0].usdcAddress,
          toCurrency: chain.usdcAddress,
          amountWei: params.amountUsdcWei,
          recipient: params.operatorAddress,
          user: params.operatorAddress,
        });
        bridgeFeeUsd = q.totalFeeUsd;
      }
      return { chain, bridgeFeeUsd, totalCostUsd: bridgeFeeUsd + chain.estGasUsd };
    }),
  );
  costs.sort((a, b) => a.totalCostUsd - b.totalCostUsd);
  return costs[0];
}
