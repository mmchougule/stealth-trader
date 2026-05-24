#!/usr/bin/env node
/** Tiny helper: print the derived Solana pubkey for a given (MASTER_SEED, tg_id). */
import { parseMasterSeed } from "../src/wallet.js";
import { userPubkey } from "../src/b402-backend.js";

const seed = process.env.MASTER_SEED;
if (!seed) { process.stderr.write("MASTER_SEED required\n"); process.exit(1); }
const tgId = Number(process.env.TG_ID ?? process.env.TEST_TG_ID ?? "999000001");
const pk = userPubkey(tgId, parseMasterSeed(seed));
// eslint-disable-next-line no-console
console.log(pk);
