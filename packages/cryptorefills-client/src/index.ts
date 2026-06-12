// Typed client for the public Cryptorefills MCP server.
// Endpoint:  https://api.cryptorefills.com/mcp/http (stateless HTTP, JSON-RPC 2.0)
// Auth:      none for catalog operations; orders are created PENDING and paid via x402.
// Hygiene per upstream guidelines: identifying User-Agent, 1 req/s default rate
// limit, 5 s timeout, Retry-After honored. purchaseElicitation is never called —
// every order in this app is user-initiated against a signed quote.

const ENDPOINT =
  process.env.CRYPTOREFILLS_MCP_URL ?? "https://api.cryptorefills.com/mcp/http";
const USER_AGENT =
  "CirclesGiftcards/0.1 (HFSP Labs; info@hfsp.xyz; https://hfsp.xyz)";
const TIMEOUT_MS = Number(process.env.CRYPTOREFILLS_TIMEOUT_MS ?? 5000);
const RATE_LIMIT_RPS = Number(process.env.CRYPTOREFILLS_RATE_LIMIT_RPS ?? 1);

const FORBIDDEN_TOOLS: ReadonlySet<string> = new Set(["purchaseElicitation"]);

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: { structuredContent?: { result?: T }; content?: unknown[] };
  error?: { code: number; message: string; data?: unknown };
}

let lastRequestTime = 0;
let nextId = 1;
const minIntervalMs = Math.max(1, Math.ceil(1000 / RATE_LIMIT_RPS));

async function call<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
  if (FORBIDDEN_TOOLS.has(toolName)) {
    throw new Error(`tool ${toolName} is forbidden by policy`);
  }
  const wait = Math.max(0, lastRequestTime + minIntervalMs - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const retryAfter = res.headers.get("Retry-After");
      throw new Error(
        `cryptorefills upstream ${res.status}${retryAfter ? ` (retry-after ${retryAfter})` : ""}`,
      );
    }
    const json = (await res.json()) as JsonRpcResponse<T>;
    if (json.error) {
      throw new Error(`cryptorefills tool error ${json.error.code}: ${json.error.message}`);
    }
    const structured = json.result?.structuredContent?.result;
    if (structured !== undefined) return structured;
    return (json.result?.content ?? null) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Read-only catalog surface ----

export const getCurrencies = () => call("getCurrencies", {});

export const listBrands = (countryCode: string) =>
  call("listBrands", { country_code: countryCode });

export const listProductsForCountry = (params: {
  country_code: string;
  brand_name?: string;
  family_name?: string;
  coin?: string;
  payment_method?: string;
  lang?: string;
}) => call("listProductsForCountry", params);

export const searchProducts = (countryCode: string, q: string, lang?: string) =>
  call("searchProducts", { country_code: countryCode, q, ...(lang ? { lang } : {}) });

export const getProductPrice = (params: {
  brand_name: string;
  country_code: string;
  face_value: number;
  coin: string; // e.g. "USDC"
}) => call("getProductPrice", params);

export const getPaymentViasWithCurrencies = () =>
  call("getPaymentViasWithCurrencies", {});

// ---- Order surface (createOrder yields a PENDING order; payment is x402) ----

export const validateOrder = (body: Record<string, unknown>) =>
  call("validateOrder", { body });

export const createOrder = (body: Record<string, unknown>) =>
  call("createOrder", { body });

export const getOrderStatus = (orderId: string) =>
  call("getOrderStatus", { order_id: orderId });
