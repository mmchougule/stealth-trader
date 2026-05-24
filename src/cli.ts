#!/usr/bin/env node
/**
 * stealth-trader CLI.
 *
 * Subcommands:
 *   setup   — interactive setup wizard (writes .env, applies SQL schema)
 *   start   — boot the bot (also the default)
 */
import "dotenv/config";

async function main() {
  const cmd = process.argv[2] ?? "start";
  switch (cmd) {
    case "setup": {
      const mod = await import("./setup/index.js");
      await mod.runSetupWizard();
      return;
    }
    case "start": {
      await import("./bot.js");
      return;
    }
    case "-h":
    case "--help":
      // eslint-disable-next-line no-console
      console.log("Usage: stealth-trader [setup|start]");
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
