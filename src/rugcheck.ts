/**
 * rugcheck.xyz summary fetcher. Free public endpoint, no auth.
 *
 * Surface the bot renders in the Buy preview:
 *   - rugcheck's overall risk score (lower is safer; 0 is best)
 *   - a verdict bucket (good / warning / danger / unknown)
 *   - up to 3 short risk-flag strings
 *
 * Decision support, not an audit — we deliberately don't expose the full
 * report. Fail-open: a network/4xx error returns null and the Buy panel
 * simply omits the risk row rather than blocking the user.
 */

export interface RugcheckSummary {
  // 0..~100000 in practice. Higher = more issues found by rugcheck.
  score: number;
  verdict: "good" | "warning" | "danger" | "unknown";
  risks: string[];
}

const CACHE = new Map<string, { v: RugcheckSummary | null; at: number }>();
const TTL_MS = 5 * 60 * 1000; // risk profile is stable minute-to-minute

export async function fetchRugcheck(mint: string): Promise<RugcheckSummary | null> {
  const hit = CACHE.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  try {
    const r = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) },
    );
    if (!r.ok) {
      CACHE.set(mint, { v: null, at: Date.now() });
      return null;
    }
    const j = (await r.json()) as { score?: number; risks?: Array<{ name?: string; description?: string }> };
    const score = Number(j.score ?? 0);
    const verdict: RugcheckSummary["verdict"] =
      score === 0 ? "good" :
      score < 1000 ? "good" :
      score < 10000 ? "warning" :
      "danger";
    const risks = Array.isArray(j.risks)
      ? j.risks.slice(0, 3).map((r) => String(r?.name ?? r?.description ?? r).slice(0, 60))
      : [];
    const summary: RugcheckSummary = { score, verdict, risks };
    CACHE.set(mint, { v: summary, at: Date.now() });
    return summary;
  } catch {
    CACHE.set(mint, { v: null, at: Date.now() });
    return null;
  }
}

/** ASCII badge for chat surfaces (no emojis). */
export function rugcheckBadge(s: RugcheckSummary): string {
  switch (s.verdict) {
    case "good":    return `rugcheck: safe (${s.score})`;
    case "warning": return `rugcheck: caution (${s.score})`;
    case "danger":  return `rugcheck: HIGH RISK (${s.score})`;
    default:        return `rugcheck: unknown`;
  }
}
