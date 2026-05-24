/**
 * Helius webhook reconciler.
 *
 * Responsibilities:
 *   - List all webhooks on this Helius account.
 *   - If a webhook ID is persisted in `stealth.system_config`, update
 *     its address list to match the current set of active leaders.
 *   - Otherwise, adopt an existing webhook whose URL matches ours, or
 *     create a fresh one. Persist the ID so subsequent deploys reuse it.
 *   - Delete any stale duplicates pointing at our URL.
 *
 * The previous (pre-stealth-trader) version of this bot would create a
 * new webhook on every boot, and Helius caps per-account webhooks at
 * around 100. The single-webhook architecture below was the fix.
 *
 * All Helius API calls go through `callHelius` for one place to audit
 * the wire format and one place to apply auth.
 */
import type { Pool } from "pg";

const WEBHOOK_ID_KEY = "helius_webhook_id";

export interface HeliusWebhookConfig {
  webhookID: string;
  webhookURL: string;
  accountAddresses: string[];
  transactionTypes: string[];
  webhookType: string;
  authHeader: string;
}

export interface ReconcileOpts {
  apiKey: string;
  publicUrl: string;        // e.g. https://your.host/webhook/helius
  authHeader: string;       // HELIUS_WEBHOOK_SECRET
  addresses: string[];      // active leader wallets
  baseUrl?: string;         // override for tests
  pool: Pool;
}

export async function reconcileWebhook(opts: ReconcileOpts): Promise<HeliusWebhookConfig> {
  const persistedId = await readPersistedId(opts.pool);

  // Find any webhooks pointing at OUR URL — we'll either reuse one or kill dupes.
  const all = await listWebhooks(opts);
  const ours = all.filter((w) => w.webhookURL === opts.publicUrl);

  let target = persistedId
    ? all.find((w) => w.webhookID === persistedId) ?? null
    : ours[0] ?? null;

  if (target) {
    // Update target to match the current addresses + filter (ANY catches
    // Helius's mis-classified swaps; parse-swap filters content-side).
    target = await updateWebhook(opts, target.webhookID);
    await persistId(opts.pool, target.webhookID);
  } else {
    if (opts.addresses.length === 0) {
      throw new Error("no addresses to register and no existing webhook to reuse");
    }
    target = await createWebhook(opts);
    await persistId(opts.pool, target.webhookID);
  }

  // Best-effort: delete any other webhooks at our URL (stale from older
  // deploys before the persisted-ID story). Don't fail the reconcile on
  // a delete error.
  for (const w of ours) {
    if (w.webhookID !== target.webhookID) {
      await deleteWebhook(opts, w.webhookID).catch(() => undefined);
    }
  }

  return target;
}

async function readPersistedId(pool: Pool): Promise<string | null> {
  const r = await pool.query(
    `SELECT value FROM stealth.system_config WHERE key = $1`,
    [WEBHOOK_ID_KEY],
  );
  return r.rowCount && r.rowCount > 0 ? r.rows[0].value : null;
}

async function persistId(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO stealth.system_config (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [WEBHOOK_ID_KEY, id],
  );
}

function url(opts: ReconcileOpts, suffix = ""): string {
  const base = opts.baseUrl ?? "https://api.helius.xyz/v0/webhooks";
  return `${base}${suffix}?api-key=${opts.apiKey}`;
}

async function listWebhooks(opts: ReconcileOpts): Promise<HeliusWebhookConfig[]> {
  const r = await fetch(url(opts));
  if (!r.ok) throw new Error(`Helius list ${r.status}: ${await r.text().catch(() => "")}`);
  return (await r.json()) as HeliusWebhookConfig[];
}

async function createWebhook(opts: ReconcileOpts): Promise<HeliusWebhookConfig> {
  const r = await fetch(url(opts), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload(opts)),
  });
  if (!r.ok) throw new Error(`Helius create ${r.status}: ${await r.text().catch(() => "")}`);
  return (await r.json()) as HeliusWebhookConfig;
}

async function updateWebhook(opts: ReconcileOpts, id: string): Promise<HeliusWebhookConfig> {
  const r = await fetch(url(opts, `/${id}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload(opts)),
  });
  if (!r.ok) throw new Error(`Helius update ${r.status}: ${await r.text().catch(() => "")}`);
  return (await r.json()) as HeliusWebhookConfig;
}

async function deleteWebhook(opts: ReconcileOpts, id: string): Promise<void> {
  const r = await fetch(url(opts, `/${id}`), { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw new Error(`Helius delete ${r.status}`);
}

function payload(opts: ReconcileOpts) {
  return {
    webhookURL: opts.publicUrl,
    // ANY catches swaps Helius mis-classifies (Phantom in-app, custom
    // routers). parse-swap filters content-side, so widening here is safe.
    transactionTypes: ["ANY"],
    accountAddresses: opts.addresses,
    webhookType: "enhanced",
    authHeader: opts.authHeader,
  };
}
