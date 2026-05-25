/**
 * Validators for setup-wizard input. Pure functions — no I/O — so the
 * happy and bad paths are both unit-testable.
 *
 * Each returns a discriminated result so the wizard can print useful
 * messages instead of stack traces.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Telegram bot token. BotFather's format is:
 *   <bot_id>:<35-char-base64url-ish>
 * We require a non-zero bot_id and at least 35 chars after the colon.
 */
export function validateTelegramToken(input: string): Result<string> {
  const s = input.trim();
  if (!s) return { ok: false, error: "Telegram bot token is empty." };
  const m = /^(\d+):([A-Za-z0-9_-]{30,})$/.exec(s);
  if (!m) {
    return {
      ok: false,
      error: "Expected Telegram bot token shape '<bot_id>:<secret>' from @BotFather.",
    };
  }
  if (m[1] === "0") {
    return { ok: false, error: "Telegram bot id cannot be 0." };
  }
  return { ok: true, value: s };
}

/**
 * Helius API key. Their dashboard issues UUIDv4-shaped keys. We accept any
 * 36-char string with 4 hyphens to keep the validator forward-compatible if
 * the key shape changes.
 */
export function validateHeliusKey(input: string): Result<string> {
  const s = input.trim();
  if (!s) return { ok: false, error: "Helius API key is empty." };
  if (s.length < 30 || s.split("-").length < 5) {
    return {
      ok: false,
      error: "Helius API key looks too short. Copy the full key from helius.dev.",
    };
  }
  return { ok: true, value: s };
}

/**
 * Sanity-check a Solana mainnet RPC URL. Accepts any provider — Helius,
 * Quicknode, Triton, Alchemy, your own validator. We just confirm it's a
 * parseable https:// URL, not the rate-limited public endpoint, and points
 * at mainnet (not devnet/testnet).
 */
export function validateRpcUrl(input: string): Result<string> {
  const s = input.trim();
  if (!s) return { ok: false, error: "RPC URL is empty." };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: "Not a valid URL." }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "RPC URL must use http(s)://" };
  }
  if (u.host === "api.mainnet-beta.solana.com") {
    return {
      ok: false,
      error: "Public mainnet RPC will rate-limit. Use a provider (free key at helius.dev / quicknode.com).",
    };
  }
  if (s.includes("devnet") || s.includes("testnet")) {
    return { ok: false, error: "This is a mainnet-only bot. Provide a mainnet RPC URL." };
  }
  return { ok: true, value: s };
}

/**
 * AUTHORIZED_TG_USERS is a comma-separated list of Telegram numeric IDs.
 * We accept positive integers, ignore whitespace, dedupe, and require at
 * least one ID so a fresh deploy doesn't accidentally open to the world.
 */
export function validateTgUserList(input: string): Result<string> {
  const s = input.trim();
  if (!s) return { ok: false, error: "Authorize at least one Telegram user ID." };
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return { ok: false, error: `Not a numeric Telegram user ID: ${p}` };
    if (p === "0") return { ok: false, error: "Telegram user ID 0 is invalid." };
    out.add(p);
  }
  if (out.size === 0) return { ok: false, error: "Authorize at least one Telegram user ID." };
  return { ok: true, value: Array.from(out).join(",") };
}

/**
 * Random 48-hex secret for the Helius webhook auth header. Generated when
 * the user doesn't supply one. Pure function — caller passes the source.
 */
export function generateWebhookSecret(rand: () => Uint8Array): string {
  const b = rand();
  let hex = "";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  return hex;
}
