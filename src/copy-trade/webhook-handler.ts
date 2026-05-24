/**
 * HTTP handler for Helius enhanced webhooks.
 *
 * Helius POSTs an array of enhanced txs to our public URL with an
 * `Authorization: <secret>` header. We:
 *   1. Verify the secret matches our HELIUS_WEBHOOK_SECRET.
 *   2. Parse the batch.
 *   3. For each tx, fan out to every active leader's parseSwap.
 *   4. Hand non-null swaps off to `dispatchCopy`.
 *
 * The handler is framework-agnostic — takes (headers, body) and returns
 * (status, body). Bot wires it into grammy/node:http; tests call it
 * directly with fixtures.
 */
import { parseSwap } from "./parse-swap.js";
import { dispatchCopy, type CopyDeps } from "./execute.js";
import type { HeliusEnhancedTx, CopyOutcome } from "./types.js";

export interface HandlerDeps extends CopyDeps {
  /** Shared secret Helius sends in the Authorization header. */
  authSecret: string;
  /** Optional logger; defaults to console for the OSS path. */
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

export interface HandlerRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface HandlerResponse {
  status: number;
  body: { ok: boolean; processed?: number; outcomes?: CopyOutcome[]; error?: string };
}

export async function handleWebhook(
  req: HandlerRequest,
  deps: HandlerDeps,
): Promise<HandlerResponse> {
  // Header keys arrive in any case via Node — normalize.
  const auth = headerValue(req.headers, "authorization");
  if (auth !== deps.authSecret) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  if (!Array.isArray(req.body)) {
    return { status: 400, body: { ok: false, error: "expected array body" } };
  }

  const txs = req.body as HeliusEnhancedTx[];
  const outcomes: CopyOutcome[] = [];

  for (const tx of txs) {
    // Each tx has one feePayer (the leader). parseSwap with that wallet
    // either returns a ParsedSwap or null. Non-swap-shaped txs (transfers,
    // memos, etc.) silently drop here.
    const parsed = parseSwap(tx, tx.feePayer);
    if (!parsed) continue;
    const dispatched = await dispatchCopy(parsed, deps);
    outcomes.push(...dispatched);
  }

  return { status: 200, body: { ok: true, processed: txs.length, outcomes } };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === key.toLowerCase()) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}
