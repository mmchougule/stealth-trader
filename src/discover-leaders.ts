/**
 * Curated leader list for /discover, loaded from config — empty by default.
 *
 * The OSS repo ships NO hardcoded wallets. An operator who wants /discover
 * to surface a starter list sets STEALTH_DISCOVER_LEADERS in their env:
 *
 *   STEALTH_DISCOVER_LEADERS="WALLET|label|blurb ; WALLET2|label2|blurb2"
 *
 * Each entry is `wallet|label|blurb`, entries separated by `;`. label and
 * blurb are optional (label defaults to a truncated wallet). Example:
 *
 *   STEALTH_DISCOVER_LEADERS="9Bkp...rw9P|scalper|90% win, 8m hold"
 *
 * Why config not code: shipping specific strangers' wallets in a public
 * repo invites staleness and implies endorsement. /leader <wallet> works
 * on any wallet regardless — /discover is just an optional starter set the
 * operator curates for their own deployment.
 */
export interface RecommendedLeader {
  wallet: string;
  label: string;
  blurb: string;
}

function shortWallet(w: string): string {
  return w.length > 10 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

/** Parse STEALTH_DISCOVER_LEADERS. Tolerant: skips malformed entries. */
export function parseLeaderConfig(raw: string | undefined): RecommendedLeader[] {
  if (!raw || !raw.trim()) return [];
  const out: RecommendedLeader[] = [];
  for (const entry of raw.split(";")) {
    const [wallet, label, blurb] = entry.split("|").map((s) => s.trim());
    if (!wallet) continue;
    // Base58 wallets are 32-44 chars. Skip anything obviously not a pubkey.
    if (wallet.length < 32 || wallet.length > 44) continue;
    out.push({
      wallet,
      label: label || shortWallet(wallet),
      blurb: blurb || "",
    });
  }
  return out;
}

/** The configured leaders. Empty unless STEALTH_DISCOVER_LEADERS is set. */
export const RECOMMENDED_LEADERS: RecommendedLeader[] =
  parseLeaderConfig(process.env.STEALTH_DISCOVER_LEADERS);

/** First N — for tight surfaces (e.g. /start chips). */
export function topRecommended(n = 3): RecommendedLeader[] {
  return RECOMMENDED_LEADERS.slice(0, n);
}
