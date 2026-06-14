import { Router } from "express";
import {
  checkDb,
  checkUpstream,
  checkWalletBalances,
  getPipelineStats,
} from "../services/healthMonitor.js";
import { getWatcherLiveness } from "../services/depositWatcher.js";

// ── Public health (fast — no wallet reads) ────────────────

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const [db, upstream] = await Promise.all([checkDb(), checkUpstream()]);
  const checks = [db, upstream];
  const ok = checks.every((c) => c.ok);
  res.status(ok ? 200 : 503).json({ ok, checks, ts: new Date().toISOString() });
});

// ── Admin status (key-gated — includes wallet balances) ───

export const adminRouter = Router();

adminRouter.use((_req, res, next) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return res.status(403).json({ error: "ADMIN_KEY not configured" });
  const auth = _req.headers.authorization ?? "";
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

adminRouter.get("/status", async (_req, res) => {
  const [db, upstream, balances] = await Promise.all([
    checkDb(),
    checkUpstream(),
    checkWalletBalances().catch((err) => ({ error: String(err) })),
  ]);

  const checks = [db, upstream];

  // Wallet balance warnings degrade overall ok but aren't hard failures —
  // the pipeline can still complete open orders; ops should top up soon.
  let balanceOk = true;
  if (balances && "crc" in balances) {
    if (!balances.crc.ok) {
      console.warn("[health] CRC wallet balance below threshold");
      balanceOk = false;
    }
    if (!balances.usdc.ok) {
      console.warn("[health] USDC wallet balance below threshold");
      balanceOk = false;
    }
  }

  const pipeline = getPipelineStats();
  const watcher = getWatcherLiveness();

  const ok = checks.every((c) => c.ok) && balanceOk;

  res.status(ok ? 200 : 503).json({
    ok,
    checks,
    balances: balances ?? "unavailable (RPC not configured)",
    pipeline,
    watcher: {
      running: watcher.running,
      startedAt: watcher.startedAtMs ? new Date(watcher.startedAtMs).toISOString() : null,
      lastEventAt: watcher.lastEventAtMs ? new Date(watcher.lastEventAtMs).toISOString() : null,
      uptimeMs: watcher.startedAtMs ? Date.now() - watcher.startedAtMs : null,
    },
    ts: new Date().toISOString(),
  });
});
