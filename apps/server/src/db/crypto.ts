import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";
const KEY_ENV = "GIFT_CARD_ENCRYPTION_KEY";

function getKey(): Buffer | null {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    console.warn("[crypto] GIFT_CARD_ENCRYPTION_KEY is not set — gift card codes will be stored in plaintext. This is unsafe for production.");
    return null;
  }
  const stripped = raw.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(`${KEY_ENV} must be a 64-character hex string (32 bytes); got: ${raw}`);
  }
  const buf = Buffer.from(stripped, "hex");
  if (buf.length !== 32) throw new Error(`${KEY_ENV} must be 32 bytes (64 hex chars)`);
  return buf;
}

/**
 * Encrypt a gift card code if GIFT_CARD_ENCRYPTION_KEY is set.
 * Returns the plaintext unchanged when no key is configured (demo / dev).
 * Ciphertext format: hex(iv):hex(authTag):hex(ciphertext)
 */
export function encryptCode(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

/**
 * Decrypt a gift card code. Transparently handles both encrypted and
 * legacy-plaintext values so rows written before encryption was enabled
 * continue to work.
 */
export function decryptCode(stored: string): string {
  const key = getKey();
  if (!key) return stored;
  const parts = stored.split(":");
  // Not encrypted (legacy plaintext or encryption was disabled when written).
  if (parts.length !== 3) return stored;
  const [ivHex, tagHex, ctHex] = parts;
  try {
    const decipher = createDecipheriv(ALG, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") + decipher.final("utf8");
  } catch {
    // Key mismatch or tampered data — return raw so ops can investigate.
    console.error("[crypto] decryption failed for stored code — returning raw");
    return stored;
  }
}
