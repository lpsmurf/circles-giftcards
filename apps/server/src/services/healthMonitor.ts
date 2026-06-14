import { createPublicClient, http, erc20Abi } from "viem";
import type { Address } from "viem";
import { activeChain, activeRpcHttp } from "../config/network.js";
import { listBrands } from "@circles-giftcards/cryptorefills-client";
import { query } from "../db/pool.js";
import { getPendingDeposits } from "./orderPipeline.js";

export interface HealthCheck {
  name: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

// ── Database ─────────────────────────────────────────────

export async function checkDb(): Promise<HealthCheck> {
  if (!process.env.DATABASE_URL) {
    return { name: "db", ok: true, latencyMs: 0, detail: "demo mode — no DB" };
  }
  const t0 = Date.now();
  try {
    await query("SELECT 1");
    return { name: "db", ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { name: "db", ok: false, latencyMs: Date.now() - t0, detail: String(err) };
  }
}

// ── Upstream (Cryptorefills) ──────────────────────────────

const UPSTREAM_TIMEOUT_MS = 5_000;

export async function checkUpstream(): Promise<HealthCheck> {
  const t0 = Date.now();
  try {
    await Promise.race([
      listBrands("DE"),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), UPSTREAM_TIMEOUT_MS)
      ),
    ]);
    return { name: "upstream", ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { name: "upstream", ok: false, latencyMs: Date.now() - t0, detail: String(err) };
  }
}

// ── Wallet balances ───────────────────────────────────────

const USDC_E = "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0" as Address;

// Warn thresholds — overridable via env
const CRC_WARN_WEI = BigInt(process.env.CRC_BALANCE_WARN_WEI ?? "50000000000000000000"); // 50 CRC
const USDC_WARN_WEI = BigInt(process.env.USDC_BALANCE_WARN_WEI ?? "10000000"); // 10 USDC

export interface WalletBalances {
  crc: { wei: string; ok: boolean };
  usdc: { wei: string; ok: boolean };
  latencyMs: number;
}

export async function checkWalletBalances(): Promise<WalletBalances | null> {
  const safe = process.env.ORCHESTRATOR_SAFE_ADDRESS;
  const crcToken = process.env.CRC_TOKEN_ADDRESS;
  const rpcUrl = activeRpcHttp();
  if (!safe || !crcToken || !rpcUrl) return null;

  const t0 = Date.now();
  const pub = createPublicClient({ chain: activeChain, transport: http(rpcUrl) });

  const [crcBal, usdcBal] = await Promise.all([
    pub.readContract({ address: crcToken as Address, abi: erc20Abi, functionName: "balanceOf", args: [safe as Address] }),
    pub.readContract({ address: USDC_E, abi: erc20Abi, functionName: "balanceOf", args: [safe as Address] }),
  ]);

  return {
    crc:  { wei: crcBal.toString(),  ok: crcBal  >= CRC_WARN_WEI },
    usdc: { wei: usdcBal.toString(), ok: usdcBal >= USDC_WARN_WEI },
    latencyMs: Date.now() - t0,
  };
}

// ── Pipeline stats ────────────────────────────────────────

export interface PipelineStats {
  pendingCount: number;
  oldestPendingAgeMs: number | null;
}

export function getPipelineStats(): PipelineStats {
  const pending = getPendingDeposits();
  let oldest: number | null = null;
  const now = Date.now();

  for (const { state } of pending.values()) {
    const age = now - new Date(state.createdAt).getTime();
    if (oldest === null || age > oldest) oldest = age;
  }

  return { pendingCount: pending.size, oldestPendingAgeMs: oldest };
}
