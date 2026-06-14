#!/usr/bin/env tsx
/**
 * Deploy MockERC20 on Chiado and mint 10,000 mCRC to the operator/Safe address.
 * Reads from apps/server/.env and writes CRC_TOKEN_ADDRESS back when done.
 *
 * Requires: Foundry (forge + cast)  — install with: curl -L https://foundry.paradigm.xyz | bash && foundryup
 *
 * Usage:
 *   npx tsx scripts/chiado/deploy-token.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_PATH = resolve(ROOT, "apps/server/.env");
const SOL_PATH = resolve(ROOT, "scripts/chiado/MockERC20.sol");

// ── Load .env ────────────────────────────────────────────────

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

function patchEnv(path: string, key: string, value: string): void {
  let src = readFileSync(path, "utf8");
  const re = new RegExp(`^#?${key}=.*$`, "m");
  src = re.test(src) ? src.replace(re, `${key}=${value}`) : `${src}\n${key}=${value}\n`;
  writeFileSync(path, src);
}

const env = loadEnv(ENV_PATH);

const operatorKey =
  env["OPERATOR_KEY"] ??
  (console.error("OPERATOR_KEY not set in apps/server/.env"), process.exit(1));

const mintTo = env["ORCHESTRATOR_SAFE_ADDRESS"] ??
  (console.error("ORCHESTRATOR_SAFE_ADDRESS not set in apps/server/.env"), process.exit(1));

const rpc = env["CHIADO_RPC_HTTP"] ?? "https://rpc.chiado.gnosis.gateway.fm";

// ── Helpers ──────────────────────────────────────────────────

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` } }).trim();
}

// ── Check balance ────────────────────────────────────────────

const operatorAddr = run(`cast wallet address --private-key ${operatorKey}`);
console.log(`Operator : ${operatorAddr}`);
console.log(`Mint to  : ${mintTo}`);

const balWei = BigInt(run(`cast balance --rpc-url ${rpc} ${operatorAddr}`));
console.log(`Balance  : ${balWei} wei (${Number(balWei) / 1e18} xDAI)\n`);

if (balWei < 1_000_000_000_000_000n) {
  console.error("Insufficient Chiado xDAI. Fund the operator address:");
  console.error("  https://faucet.gnosis.io/");
  console.error("  https://gnosisfaucet.com/");
  console.error(`  Address: ${operatorAddr}`);
  process.exit(1);
}

// ── Deploy ───────────────────────────────────────────────────

console.log("Deploying MockERC20...");
const deployOut = run(
  `forge create --rpc-url ${rpc} --chain-id 10200 --private-key ${operatorKey} ` +
  `${SOL_PATH}:MockERC20 --constructor-args "Mock Circles CRC" "mCRC" --json`
);
const deployJson = JSON.parse(deployOut) as { deployedTo: string; transactionHash: string };
const tokenAddress = deployJson.deployedTo;
console.log(`Token     : ${tokenAddress}`);
console.log(`Deploy tx : ${deployJson.transactionHash}`);

// ── Mint ─────────────────────────────────────────────────────

console.log(`\nMinting 10,000 mCRC to ${mintTo}...`);
const mintTx = run(
  `cast send --rpc-url ${rpc} --chain-id 10200 --private-key ${operatorKey} ` +
  `${tokenAddress} "mint(address,uint256)" ${mintTo} 10000000000000000000000 --json`
);
const mintJson = JSON.parse(mintTx) as { transactionHash: string };
console.log(`Mint tx   : ${mintJson.transactionHash}`);

const bal = run(
  `cast call --rpc-url ${rpc} ${tokenAddress} "balanceOf(address)(uint256)" ${mintTo}`
);
console.log(`Balance   : ${BigInt(bal) / 10n ** 18n} mCRC`);

// ── Patch .env ───────────────────────────────────────────────

patchEnv(ENV_PATH, "CRC_TOKEN_ADDRESS", tokenAddress);
patchEnv(ENV_PATH, "OPERATOR_KEY", operatorKey);  // ensure uncommented
console.log(`\n✓  CRC_TOKEN_ADDRESS=${tokenAddress} written to apps/server/.env`);
console.log("✓  OPERATOR_KEY uncommented");
console.log("\nRestart the server to activate execution mode:");
console.log("  pkill -f 'tsx watch' && npm run dev:server");
