/**
 * Shared formatters for Telegram surfaces. ASCII only — no emojis.
 *
 * lamportsToSolStr: render a lamports BigInt as a decimal SOL string with
 *   `decimals` fractional digits (default 4). Negative is allowed and
 *   keeps the sign. Used in /holdings, /leader, and the buy/sell receipts.
 *
 * shortMint: 6-char prefix + 4-char suffix with an ellipsis. Stable
 *   shortening for chat — sufficient to disambiguate without consuming
 *   the screen line.
 *
 * formatAmount: render a raw integer token amount as decimal using the
 *   mint's decimals. Strips trailing zeros so "1.500000" → "1.5".
 *
 * formatHoldDuration: humanise a seconds duration. "47s", "4m", "1h 12m",
 *   "3d 6h". Used in /leader.
 *
 * pad2: zero-padded two-digit number for hour/minute display.
 */

const ONE_SOL = 1_000_000_000n;

export function lamportsToSolStr(n: bigint, decimals = 4): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / ONE_SOL;
  const frac = abs % ONE_SOL;
  const fracStr = frac.toString().padStart(9, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}.${fracStr}`;
}

export function shortMint(s: string): string {
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** Render a raw integer amount with `decimals` decimals, trimming
 *  trailing zeros. "1000" with decimals=6 → "0.001". */
export function formatAmount(rawAmount: string, decimals: number): string {
  if (decimals === 0) return rawAmount;
  const padded = rawAmount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function formatHoldDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(secs / 86_400);
  const h = Math.round((secs % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Human-friendly magnitude for a decimal token quantity. Big numbers get a
 * K/M suffix; sub-1 amounts keep 6 places so micro-positions stay legible.
 * Display-only — never feed the result back into math.
 */
export function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(6);
}

/**
 * Render a rugcheck score as a one-line badge. `score` is RugCheck's raw
 * risk score (higher = riskier); `undefined` means we never got a number
 * (API down / token unindexed) and we say so rather than implying safety.
 * ASCII only per house style — no traffic-light emoji.
 *
 * Thresholds mirror the reference trader's buy panel: 0 or <1000 reads safe, <10000
 * caution, otherwise high risk. The hard danger-flag block happens upstream
 * in safety.checkToken; this badge is the soft, informational signal.
 */
export function rugcheckBadge(score: number | undefined): string {
  if (score === undefined) return "rugcheck: unknown";
  if (score < 1000) return `rugcheck: safe (${score})`;
  if (score < 10_000) return `rugcheck: caution (${score})`;
  return `rugcheck: HIGH RISK (${score})`;
}
