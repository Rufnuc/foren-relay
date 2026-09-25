// Pure mathematical analytics over anonymous aggregates. No I/O, no PII — every
// function here takes plain numbers (activity totals, redemption counts, weekly
// presence) and returns statistics. Kept separate from storage so it can be unit
// tested exhaustively and reasoned about in isolation.

/** Arithmetic mean, or 0 for an empty set. */
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Population standard deviation (0 for <2 points). */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

/**
 * Linear-interpolated percentile (p in [0,100]) over a copy of `xs`. p=50 is the
 * median. Empty input → 0.
 */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

export function median(xs: number[]): number {
  return percentile(xs, 50);
}

/**
 * The share of values at or below `x` — i.e. `x`'s percentile within the sample,
 * as a fraction in [0,1]. Used to tell a user "you're more active than N% of
 * people" without revealing anyone else's number.
 */
export function percentileRank(xs: number[], x: number): number {
  if (!xs.length) return 0;
  const atOrBelow = xs.reduce((n, v) => n + (v <= x ? 1 : 0), 0);
  return atOrBelow / xs.length;
}

/**
 * Gini coefficient of a non-negative distribution: 0 = perfectly equal, →1 =
 * maximally concentrated. Here it measures how unevenly engagement is spread
 * across users (a few power-users vs. a broad base). Returns 0 for empty input
 * or an all-zero distribution.
 */
export function gini(xs: number[]): number {
  const vals = xs.filter((v) => v >= 0);
  const n = vals.length;
  if (n === 0) return 0;
  const total = vals.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  // G = ( 2*Σ i*x_i ) / ( n*Σ x_i ) - (n+1)/n , with i 1-based.
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * sorted[i];
  const g = (2 * cum) / (n * total) - (n + 1) / n;
  // Clamp tiny negative values from float error.
  return Math.max(0, Math.min(1, g));
}

export interface Distribution {
  count: number;
  mean: number;
  stdev: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
  gini: number;
}

export function describe(xs: number[]): Distribution {
  return {
    count: xs.length,
    mean: round(mean(xs)),
    stdev: round(stdev(xs)),
    min: xs.length ? Math.min(...xs) : 0,
    max: xs.length ? Math.max(...xs) : 0,
    p50: round(percentile(xs, 50)),
    p90: round(percentile(xs, 90)),
    p99: round(percentile(xs, 99)),
    gini: round(gini(xs)),
  };
}

/**
 * Referral virality (K-factor): the average number of NEW users each existing
 * user brings in. Approximated from aggregate referral data as
 *   K = (total distinct redeemers) / (population that could refer)
 * When K ≥ 1 growth is self-sustaining. `referrers` is the base population
 * (active anonymous identities); guard against divide-by-zero.
 */
export function kFactor(distinctRedeemers: number, referrers: number): number {
  if (referrers <= 0) return 0;
  return round(distinctRedeemers / referrers);
}

/**
 * Reuse rate: the fraction of redemptions beyond the first per link — i.e. how
 * much links get *re-shared* rather than used once. 0 = every redemption is a
 * distinct link's first use; →1 = links are reused heavily.
 */
export function reuseRate(
  totalRedemptions: number,
  distinctLinksRedeemed: number,
): number {
  if (totalRedemptions <= 0) return 0;
  return round(
    Math.max(0, (totalRedemptions - distinctLinksRedeemed) / totalRedemptions),
  );
}

/**
 * Week-over-week retention curve from a map of week → active anon-id set sizes,
 * paired with carry-over counts. `points` are consecutive weeks with the number
 * active that week and the number of them also active the following week.
 * Returns each week's retention fraction (retained / active).
 */
export function retentionCurve(
  points: { week: string; active: number; retained: number }[],
): {
  week: string;
  active: number;
  retained: number;
  rate: number;
}[] {
  return points.map((p) => ({
    ...p,
    rate: p.active > 0 ? round(p.retained / p.active) : 0,
  }));
}

/**
 * RFM-style activity score in [0,100] for one user, from three signals:
 *   • volume       — lifetime meaningful actions (log-dampened so a power user
 *                    doesn't dwarf the scale)
 *   • activeWeeks  — number of distinct weeks with activity (frequency)
 *   • weeksSince   — weeks since last active (recency, exponential decay)
 * Weights favour sustained, recent engagement over raw volume. Deterministic and
 * monotonic in each signal. `refBrought` (distinct redeemers of this user's
 * links) adds a small advocacy bonus.
 */
export function activityScore(input: {
  volume: number;
  activeWeeks: number;
  weeksSince: number;
  refBrought?: number;
}): number {
  const volume = Math.max(0, input.volume);
  const activeWeeks = Math.max(0, input.activeWeeks);
  const weeksSince = Math.max(0, input.weeksSince);
  const refBrought = Math.max(0, input.refBrought ?? 0);

  // Each component normalised to [0,1] with a saturating curve.
  const vol = 1 - Math.exp(-volume / 25); // ~0.63 at 25 actions, →1
  const freq = 1 - Math.exp(-activeWeeks / 8); // ~0.63 at 8 active weeks
  const recency = Math.exp(-weeksSince / 6); // 1 now, ~0.51 at 4 weeks idle, →0
  const advocacy = 1 - Math.exp(-refBrought / 3); // small bonus for bringing people

  const score = 100 * (0.3 * vol + 0.3 * freq + 0.3 * recency + 0.1 * advocacy);
  return round(Math.max(0, Math.min(100, score)));
}

/** Round to 4 significant decimals to keep JSON stable and readable. */
function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
