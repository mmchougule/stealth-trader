/**
 * Zero-config MCP boot. Mirrors @b402ai/solana-mcp: every env var is optional,
 * sensible defaults fill the rest, so `npx … mcp` works with no flags.
 *
 *   MASTER_SEED     — else load-or-generate a persisted seed (printed once;
 *                     back it up — it derives the wallet that holds funds).
 *   STEALTH_TG_ID   — else 1. Just a numeric account namespace for solo use.
 *   HELIUS_RPC_URL  — else public mainnet (throttles; we warn once).
 *   B402_CLUSTER    — else mainnet.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

export interface McpConfig {
  tgId: number;
  masterSeedHex: string;
  rpcUrl: string;
  cluster: "mainnet" | "devnet" | "localnet";
  /** True when HELIUS_RPC_URL was unset and we fell back to public RPC. */
  rpcDefaulted: boolean;
  /** Set to the seed file path when we generated a fresh seed this boot. */
  generatedSeedPath?: string;
}

export function defaultSeedPath(): string {
  return path.join(os.homedir(), ".config", "stealth-trader", "master-seed");
}

/** Resolve MCP config from env, generating + persisting a master seed when
 *  none is supplied. `seedPath` is injectable so tests don't touch ~/.config. */
export function resolveMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  seedPath: string = defaultSeedPath(),
): McpConfig {
  const clusterRaw = env.B402_CLUSTER ?? "mainnet";
  if (!["mainnet", "devnet", "localnet"].includes(clusterRaw)) {
    throw new Error(`B402_CLUSTER must be mainnet|devnet|localnet; got "${clusterRaw}"`);
  }
  const cluster = clusterRaw as McpConfig["cluster"];

  let masterSeedHex = env.MASTER_SEED?.trim();
  let generatedSeedPath: string | undefined;
  if (!masterSeedHex) {
    if (fs.existsSync(seedPath)) {
      masterSeedHex = fs.readFileSync(seedPath, "utf8").trim();
    } else {
      masterSeedHex = randomBytes(32).toString("hex");
      fs.mkdirSync(path.dirname(seedPath), { recursive: true });
      fs.writeFileSync(seedPath, masterSeedHex, { mode: 0o600 });
      generatedSeedPath = seedPath;
    }
  }

  const tgRaw = env.STEALTH_TG_ID?.trim();
  const tgId = tgRaw && /^\d+$/.test(tgRaw) && Number(tgRaw) > 0 ? Number(tgRaw) : 1;

  const rpcSet = !!env.HELIUS_RPC_URL?.trim();
  const rpcUrl = rpcSet ? env.HELIUS_RPC_URL!.trim() : PUBLIC_MAINNET_RPC;

  return { tgId, masterSeedHex, rpcUrl, cluster, rpcDefaulted: !rpcSet, generatedSeedPath };
}
