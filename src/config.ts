/**
 * Environment loader. Every env var the bot reads goes through here so
 * the rest of the code is testable with a fixture config and we never
 * sprinkle process.env lookups across modules.
 *
 * Boot will throw if a required value is missing; the message names the
 * env var so the operator can fix it without reading source.
 */

export interface Config {
  telegramBotToken: string;
  authorizedTgUsers: ReadonlySet<number>;
  heliusRpcUrl: string;
  heliusWebhookSecret: string;
  webhookPublicUrl: string | null;
  /** Postgres URL OR `pglite:/path` OR null (defaults to ~/.stealth-trader/db). */
  databaseUrl: string | null;
  cluster: "mainnet" | "devnet" | "localnet";
  solanaKeypairPath: string | null;
  relayerUrl: string | null;
  logLevel: string;
  /** Dust threshold override in lamports; default 2,000,000. */
  dustMinLamports: bigint | null;
  /** 32-byte hex root of trust. Required — derives every user's keypair. */
  masterSeedHex: string;
  /** Optional fee-payer keypair file path. When set, the bot pre-creates
   *  recipient ATAs (~0.002 SOL one-time per address/mint) so /cashout
   *  to a fresh wallet never fails with "insufficient funds for rent".
   *  When unset, fresh-recipient cashouts fall through to the SDK's
   *  user-pays path (works only if the user has spare SOL). */
  operatorFeeKeypairPath: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    telegramBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
    authorizedTgUsers: parseUserList(required(env, "AUTHORIZED_TG_USERS")),
    heliusRpcUrl: required(env, "HELIUS_RPC_URL"),
    heliusWebhookSecret: required(env, "HELIUS_WEBHOOK_SECRET"),
    webhookPublicUrl: optional(env, "WEBHOOK_PUBLIC_URL"),
    databaseUrl: optional(env, "DATABASE_URL"),
    cluster: parseCluster(env.B402_CLUSTER ?? "mainnet"),
    solanaKeypairPath: optional(env, "SOLANA_KEYPAIR_PATH"),
    relayerUrl: optional(env, "B402_RELAYER_URL"),
    logLevel: env.LOG_LEVEL ?? "info",
    dustMinLamports: parseBigintOpt(env.DUST_MIN_LAMPORTS),
    masterSeedHex: required(env, "MASTER_SEED"),
    operatorFeeKeypairPath: optional(env, "OPERATOR_FEE_KEYPAIR_PATH"),
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") {
    throw new Error(`missing required env var: ${key}`);
  }
  return v.trim();
}

function optional(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return v && v.trim() !== "" ? v.trim() : null;
}

function parseUserList(s: string): ReadonlySet<number> {
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (!/^\d+$/.test(t)) throw new Error(`AUTHORIZED_TG_USERS contains non-numeric: ${t}`);
    out.add(Number(t));
  }
  if (out.size === 0) throw new Error("AUTHORIZED_TG_USERS must list at least one ID");
  return out;
}

function parseCluster(s: string): Config["cluster"] {
  if (s === "mainnet" || s === "devnet" || s === "localnet") return s;
  throw new Error(`B402_CLUSTER must be mainnet | devnet | localnet, got: ${s}`);
}

function parseBigintOpt(s: string | undefined): bigint | null {
  if (!s) return null;
  try {
    const n = BigInt(s);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}
