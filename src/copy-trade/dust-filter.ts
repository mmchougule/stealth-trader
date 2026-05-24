/**
 * Dust filter: skip copies that would burn more in gas/fees than they buy.
 *
 * Default: 0.002 SOL minimum leader trade. Configurable via env to allow
 * per-deployment tuning. Each /follow can override its own min via the
 * `min_copy_lamports` column on the follow row.
 */

export const DEFAULT_DUST_MIN_LAMPORTS = 2_000_000n;

export interface DustGate {
  /** The amount the leader spent on chain. */
  leaderAmountIn: bigint;
  /** The threshold this caller/follow uses. Use DEFAULT_DUST_MIN_LAMPORTS
   *  unless the follow row carries an override. */
  minLamports: bigint;
}

export function isDust({ leaderAmountIn, minLamports }: DustGate): boolean {
  return leaderAmountIn < minLamports;
}

export function resolveMin(opts: {
  envValue?: string | undefined;
  followOverride?: bigint | undefined;
}): bigint {
  if (opts.followOverride !== undefined && opts.followOverride > 0n) {
    return opts.followOverride;
  }
  if (opts.envValue) {
    try {
      const n = BigInt(opts.envValue);
      if (n > 0n) return n;
    } catch { /* fall through */ }
  }
  return DEFAULT_DUST_MIN_LAMPORTS;
}
