/**
 * Pre-trade safety check. Wraps rugcheck.xyz with a strict policy:
 *
 *   - block ONLY when rugcheck flags a risk with level === "danger"
 *   - score thresholds and named-blockers (mint authority enabled, etc.)
 *     are false-positive prone — $ORCA, $USDC, and most legit Solana
 *     tokens retain mint or freeze authority. The Buy preview renders
 *     the rugcheck badge; user decides.
 *
 * Fail-open on RugCheck errors — a network/4xx returns pass=true with
 * a "manual review advised" reason so the bot remains usable when the
 * third-party API is down.
 */
import { log } from "./log.js";

export interface SafetyReport {
  pass: boolean;
  reason: string;
  score?: number;
  raw?: unknown;
}

export async function checkToken(mint: string): Promise<SafetyReport> {
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
    if (!r.ok) {
      log.warn({ mint, status: r.status }, "RugCheck non-OK response");
      return {
        pass: true,
        reason: `RugCheck unreachable (HTTP ${r.status}) — manual review advised`,
      };
    }
    const d = (await r.json()) as {
      score?: number;
      risks?: Array<{ name: string; level: string }>;
    };
    const score = typeof d.score === "number" ? d.score : undefined;
    const risks = d.risks ?? [];
    const blockers = risks.filter((x) => x.level === "danger");
    if (blockers.length > 0) {
      return {
        pass: false,
        reason: `RugCheck danger flags: ${blockers.map((r) => r.name).join(", ")}`,
        ...(score !== undefined ? { score } : {}),
        raw: d,
      };
    }
    return {
      pass: true,
      reason: `RugCheck OK (score ${score ?? "n/a"})`,
      ...(score !== undefined ? { score } : {}),
      raw: d,
    };
  } catch (e) {
    const msg = (e as Error)?.message;
    log.warn({ mint, err: msg }, "RugCheck exception");
    return { pass: true, reason: `RugCheck error (${msg}) — fail-open, manual review` };
  }
}
