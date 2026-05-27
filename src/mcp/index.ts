#!/usr/bin/env node
/**
 * stealth-trader MCP server.
 *
 * Exposes the bot as Model Context Protocol tools an LLM agent can call.
 * Same business logic the Telegram bot uses; different surface.
 *
 * Install (Claude Code):
 *   claude mcp add stealth-trader -- npx -y @b402ai/stealth-trader@latest mcp
 *
 * Zero-config: all env optional (see resolveMcpConfig).
 *   MASTER_SEED     — root of trust; auto-generated + persisted if unset
 *   STEALTH_TG_ID   — account namespace; default 1
 *   HELIUS_RPC_URL  — RPC; default public mainnet (set one before trading)
 *   DATABASE_URL    — Postgres; default pglite at ~/.stealth-trader/db
 *   B402_CLUSTER    — mainnet | devnet | localnet (default: mainnet)
 *
 * One process serves one account (tgId). Whoever holds the MASTER_SEED
 * controls that account's keypair — same trust model as the Telegram bot.
 */
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, applySchema } from "../db/index.js";
import { parseMasterSeed } from "../wallet.js";
import { makeB402Backend, userPubkey } from "../b402-backend.js";
import { makeBalanceStore } from "../balance.js";
import { makeTrade } from "../trade.js";
import { handlers, type McpDeps } from "./handlers.js";
import { resolveMcpConfig } from "./config.js";
import {
  getWalletInput, getBalanceInput, getHoldingsInput,
  privateBuyInput, cashoutInput, privateLendInput, discoverLeadersInput,
} from "./schemas.js";

// v0.5 tool surface. follow / unfollow / list_follows are intentionally
// NOT registered — copy-trade lands in v0.6 once a hosted Helius webhook
// proxy exists. Registering them now would let an agent insert follow
// rows that nothing processes. discover_leaders stays (read-only scoring).
const tools = [
  { name: "get_wallet",        schema: getWalletInput,        handler: handlers.get_wallet },
  { name: "get_balance",       schema: getBalanceInput,       handler: handlers.get_balance },
  { name: "get_holdings",      schema: getHoldingsInput,      handler: handlers.get_holdings },
  { name: "private_buy",       schema: privateBuyInput,       handler: handlers.private_buy },
  { name: "private_lend",      schema: privateLendInput,      handler: handlers.private_lend },
  { name: "cashout",           schema: cashoutInput,          handler: handlers.cashout },
  { name: "discover_leaders",  schema: discoverLeadersInput,  handler: handlers.discover_leaders },
] as const;

async function main() {
  // Zero-config: every env var is optional (see resolveMcpConfig). Missing
  // seed → generated + persisted; missing RPC → public mainnet.
  const { tgId, masterSeedHex, rpcUrl, cluster, rpcDefaulted, generatedSeedPath } = resolveMcpConfig();
  if (generatedSeedPath) {
    process.stderr.write(
      `[stealth-trader] generated a new wallet seed → ${generatedSeedPath}\n` +
      `  BACK THIS UP. It derives your deposit wallet; lose it, lose the funds.\n`,
    );
  }
  if (rpcDefaulted && cluster === "mainnet") {
    process.stderr.write(
      "[stealth-trader] using public mainnet RPC (throttles). Set HELIUS_RPC_URL to a Helius/Triton endpoint for reliability.\n",
    );
  }

  const pool = await getPool();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sqlDir = path.resolve(here, "..", "..", "sql");
  await applySchema(pool, sqlDir);
  const masterSeed = parseMasterSeed(masterSeedHex);
  const backend = makeB402Backend({
    masterSeed, rpcUrl, cluster, pool,
    ...(process.env.B402_RELAYER_URL ? { relayerUrl: process.env.B402_RELAYER_URL } : {}),
  });
  const balance = makeBalanceStore(pool);
  const trade = makeTrade({ backend, balance });

  const deps: McpDeps = {
    pool, tgId, resolvePubkey: (id) => userPubkey(id, masterSeed), trade, wallet: backend,
  };

  const server = new Server(
    { name: "stealth-trader", version: "0.5.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: (t.schema.description ?? t.name),
      // No `name` arg: that wraps the schema in a $ref/definitions envelope
      // whose top level has no `type`, which MCP clients reject. Passing the
      // schema alone emits an inline { type: "object", properties }.
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
    }
    try {
      return await tool.handler(req.params.arguments ?? {}, deps);
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
