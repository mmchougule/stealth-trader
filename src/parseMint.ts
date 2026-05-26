/**
 * Extract a Solana mint address from arbitrary user input.
 *
 * Accepts:
 *   - bare mint:        "9E9eu…BAGS"
 *   - pump.fun URL:     "https://pump.fun/coin/<mint>"  or  "https://pump.fun/<mint>"
 *   - solscan URL:      "https://solscan.io/token/<mint>"  or  "/address/<mint>"
 *   - birdeye URL:      "https://birdeye.so/token/<mint>?chain=solana"
 *   - dexscreener URL:  "https://dexscreener.com/solana/<mint>"
 *   - jup.ag URL:       "https://jup.ag/swap/SOL-<mint>"
 *   - KOL messages with the mint embedded in arbitrary text
 *
 * Strategy: scan for any base58 substring 32-44 chars. Pick the first.
 * Validation that it's a REAL token is the caller's job (rugcheck, jupiter
 * decimals); we only check it's *shaped like* a Solana pubkey.
 *
 * Returns `null` on empty/garbage/no-match. Never throws.
 *
 * Length bounds:
 *   - 32: minimum base58 of a 32-byte ed25519 pubkey (leading-1 dense)
 *   - 44: maximum. Anything longer is a tx signature (~88 base58 chars)
 *
 * Anchored on non-base58 boundaries so we don't slice into the middle of
 * a longer base58 blob and surface a wrong-but-valid-shape mint.
 */
const BASE58_CHAR = "[1-9A-HJ-NP-Za-km-z]";
const BASE58_NON = "[^1-9A-HJ-NP-Za-km-z]";
const MINT_REGEX = new RegExp(
  `(?:^|${BASE58_NON})(${BASE58_CHAR}{32,44})(?:$|${BASE58_NON})`,
);

export function parseMintFromInput(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  if (input.length === 0) return null;
  const m = input.match(MINT_REGEX);
  return m ? m[1] : null;
}
