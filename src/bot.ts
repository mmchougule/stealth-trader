/**
 * Bot entrypoint — wires Telegram + Helius webhook + copy-trade pipeline.
 *
 * Layered out as imports so test files don't accidentally boot Telegram
 * just by importing a sibling.
 */
import "dotenv/config";
import { log } from "./log.js";

async function main() {
  log.info({ version: "0.1.0" }, "stealth-trader starting");
  // TODO (next milestone): wire Helius webhook + Telegram + copy-trade
  // pipeline. Surface stub stays here so the bin script + tsconfig resolve.
  log.warn("bot.ts is currently a stub — wiring lands in the next milestone");
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
