#!/usr/bin/env node
/**
 * stealth-trader MCP server.
 *
 * Exposes the bot as Model Context Protocol tools an LLM agent can call.
 * Same business logic the Telegram bot uses; different surface.
 *
 * Install (Claude Code):
 *   claude mcp add stealth-trader -- node /abs/path/to/dist/mcp/index.js
 *
 * Required env (same as bot.ts):
 *   STEALTH_TG_ID         — the Telegram user this MCP instance acts for
 *   DATABASE_URL          — Postgres
 *   HELIUS_RPC_URL        — RPC with api-key query param
 *   MASTER_SEED           — 64-hex root of trust (must match the bot's)
 *   B402_CLUSTER          — mainnet | devnet | localnet (default: mainnet)
 *
 * One MCP server process serves one Telegram user. Spinning up an MCP
 * for someone else's tg_id requires their MASTER_SEED — which means
 * if MASTER_SEED is operator-controlled, the operator implicitly
 * controls every user's keypair. That's the same trust model as the
 * Telegram bot itself.
 */
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

import { getPool } from "../db/index.js";
import { parseMasterSeed } from "../wallet.js";
import { makeB402Backend, userPubkey } from "../b402-backend.js";
import { makeBalanceStore } from "../balance.js";
import { makeTrade } from "../trade.js";
import { handlers, type McpDeps } from "./handlers.js";
import {
  getWalletInput, getBalanceInput, getHoldingsInput,
  followInput, unfollowInput, listFollowsInput,
  privateBuyInput, cashoutInput, discoverLeadersInput,
} from "./schemas.js";

const tools = [
  { name: "get_wallet",        schema: getWalletInput,        handler: handlers.get_wallet },
  { name: "get_balance",       schema: getBalanceInput,       handler: handlers.get_balance },
  { name: "get_holdings",      schema: getHoldingsInput,      handler: handlers.get_holdings },
  { name: "follow",            schema: followInput,           handler: handlers.follow },
  { name: "unfollow",          schema: unfollowInput,         handler: handlers.unfollow },
  { name: "list_follows",      schema: listFollowsInput,      handler: handlers.list_follows },
  { name: "private_buy",       schema: privateBuyInput,       handler: handlers.private_buy },
  { name: "cashout",           schema: cashoutInput,          handler: handlers.cashout },
  { name: "discover_leaders",  schema: discoverLeadersInput,  handler: handlers.discover_leaders },
] as const;

async function main() {
  const tgId = Number(process.env.STEALTH_TG_ID ?? "");
  if (!Number.isInteger(tgId) || tgId <= 0) {
    process.stderr.write("STEALTH_TG_ID env var is required (positive integer).\n");
    process.exit(1);
  }
  const masterSeedHex = process.env.MASTER_SEED;
  if (!masterSeedHex) {
    process.stderr.write("MASTER_SEED env var is required (64 hex chars).\n");
    process.exit(1);
  }
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write("HELIUS_RPC_URL env var is required.\n");
    process.exit(1);
  }
  const cluster = (process.env.B402_CLUSTER ?? "mainnet") as "mainnet" | "devnet" | "localnet";

  const pool = getPool();
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
    { name: "stealth-trader", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: (t.schema.description ?? t.name),
      inputSchema: zodToJsonSchema(t.schema, t.name),
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
