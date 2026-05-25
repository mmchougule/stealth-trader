#!/usr/bin/env node
/**
 * stealth-trader CLI.
 *
 * Subcommands:
 *   wizard  — interactive setup wizard (writes .env, applies SQL schema)
 *   mcp     — start the MCP server on stdio
 *   start   — boot the Telegram bot (also the default)
 */
import "dotenv/config";

async function main() {
  const cmd = process.argv[2] ?? "start";
  switch (cmd) {
    case "setup":
    case "wizard": {
      const mod = await import("./setup/index.js");
      await mod.runSetupWizard();
      return;
    }
    case "mcp": {
      // Boot the MCP server in-process. Same binary as the bot so the
      // npx install line `npx @b402ai/stealth-trader mcp` works.
      await import("./mcp/index.js");
      return;
    }
    case "start": {
      await import("./bot.js");
      return;
    }
    case "-h":
    case "--help":
      // eslint-disable-next-line no-console
      console.log("Usage: stealth-trader [wizard|mcp|start]");
      return;
    default:
      // eslint-disable-next-line no-console
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
