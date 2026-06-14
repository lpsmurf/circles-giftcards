/**
 * AgentMail.to inbox used as the recipient email on all Cryptorefills orders.
 * Some brands deliver gift card codes only via email (not in the API response).
 * We create one stable inbox per deployment (idempotent via client_id) and poll
 * it as a fallback after the upstream order status reaches DELIVERED.
 */

const BASE = "https://api.agentmail.to";

// Stable client ID — same value across restarts so we always reuse the same inbox.
const CLIENT_ID = process.env.AGENTMAIL_CLIENT_ID ?? "circles-giftcards-v1";

interface Inbox {
  inboxId: string;
  email: string;
}

let _inbox: Inbox | null = null;

function headers(): Record<string, string> {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw new Error("AGENTMAIL_API_KEY not configured");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/** Returns the shared inbox, creating it on first call (idempotent via client_id). */
export async function getOrCreateInbox(): Promise<Inbox> {
  if (_inbox) return _inbox;

  const res = await fetch(`${BASE}/inboxes`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`AgentMail create inbox ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as Record<string, unknown>;
  const inboxId = data.inbox_id as string;
  // Email is {client_id}@agentmail.to or returned directly in the response.
  const email = (data.email as string | undefined) ?? `${CLIENT_ID}@agentmail.to`;

  _inbox = { inboxId, email };
  console.log(`[emailInbox] inbox ready: ${email} (id=${inboxId})`);
  return _inbox;
}

// ── Gift-card code extraction ─────────────────────────────────

const CODE_PATTERNS = [
  // Explicit label before the code
  /(?:code|gift\s*card|voucher|pin|key|redeem(?:ption)?)[\s:]+([A-Z0-9]{4,6}(?:[-\s][A-Z0-9]{4,6}){1,5})/i,
  // Standard XXXX-XXXX-XXXX-XXXX format
  /\b([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\b/,
  // Long alphanumeric codes (16–25 chars)
  /\b([A-Z0-9]{16,25})\b/,
];

function extractCode(text: string): string | null {
  for (const re of CODE_PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

// ── Inbox polling ─────────────────────────────────────────────

const POLL_INTERVAL_MS = 15_000;

/**
 * Poll the shared inbox for a message containing a gift card code that arrived
 * after `afterMs`. Returns the extracted code or null on timeout.
 */
export async function pollInboxForCode(
  inboxId: string,
  afterMs: number,
  timeoutMs = 8 * 60_000,
): Promise<string | null> {
  const h = headers();
  const deadline = Date.now() + timeoutMs;
  const afterIso = new Date(afterMs).toISOString();

  console.log(`[emailInbox] polling inbox for gift card code (after=${afterIso})`);

  while (Date.now() < deadline) {
    try {
      const url =
        `${BASE}/inboxes/${inboxId}/messages` +
        `?after=${encodeURIComponent(afterIso)}&limit=20`;
      const res = await fetch(url, { headers: h });

      if (res.ok) {
        const data = (await res.json()) as { messages?: Array<Record<string, unknown>> };
        for (const msg of data.messages ?? []) {
          const text =
            (msg.extracted_text as string | undefined) ??
            (msg.text as string | undefined) ??
            "";
          const code = extractCode(text);
          if (code) {
            console.log(`[emailInbox] found gift card code in message "${msg.subject}"`);
            return code;
          }
        }
      }
    } catch (err) {
      console.warn(`[emailInbox] poll error (retrying):`, err);
    }

    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.warn(`[emailInbox] timed out waiting for gift card code in inbox`);
  return null;
}
