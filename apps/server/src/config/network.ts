import { gnosis, gnosisChiado } from "viem/chains";
import type { Chain } from "viem";

/** True when TESTNET=chiado. CoW swap and Cryptorefills payment are mocked in
 *  this mode — only deposit detection, Safe transactions, and refunds hit the
 *  chain (Chiado). Flip to false (or unset TESTNET) for mainnet. */
export const TESTNET: boolean = process.env.TESTNET === "chiado";

export const activeChain: Chain = TESTNET ? gnosisChiado : gnosis;

export function activeRpcHttp(): string {
  return TESTNET
    ? (process.env.CHIADO_RPC_HTTP ?? "https://rpc.chiado.gnosis.gateway.fm")
    : (process.env.GNOSIS_RPC_HTTP ?? "https://rpc.gnosischain.com");
}

export function activeRpcWss(): string {
  return TESTNET
    ? (process.env.CHIADO_RPC_WSS ?? "")
    : (process.env.GNOSIS_RPC_WSS ?? "");
}

export function activeCowApiUrl(): string {
  return process.env.COW_API_URL ?? (TESTNET
    ? "https://barn.api.cow.fi/xdai/api/v1"
    : "https://api.cow.fi/xdai/api/v1");
}
