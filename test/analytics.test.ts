import { describe, it, expect } from "vitest";
import {
  mean,
  stdev,
  percentile,
  median,
  percentileRank,
  gini,
  describe as describeDist,
  kFactor,
  reuseRate,
  retentionCurve,
  activityScore,
} from "../src/services/usage/analytics";

describe("analytics: basic statistics", () => {
  it("mean and stdev", () => {
    expect(mean([])).toBe(0);
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdev([5])).toBe(0);
    expect(stdev([2, 4, 6])).toBeCloseTo(Math.sqrt(8 / 3), 6);
  });

  it("percentile interpolates and median is p50", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([10], 99)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(percentile([0, 10], 25)).toBe(2.5);
  });

  it("percentileRank is the share at or below x", () => {
    expect(percentileRank([], 5)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 2)).toBe(0.5);
    expect(percentileRank([1, 2, 3, 4], 100)).toBe(1);
    expect(percentileRank([5, 5, 5], 5)).toBe(1);
  });
});

describe("analytics: Gini coefficient", () => {
  it("is 0 for perfect equality and empty/zero inputs", () => {
    expect(gini([])).toBe(0);
    expect(gini([0, 0, 0])).toBe(0);
    expect(gini([5, 5, 5, 5])).toBe(0);
  });

  it("approaches high values for concentration", () => {
    const g = gini([0, 0, 0, 100]);
    expect(g).toBeGreaterThan(0.6);
    expect(g).toBeLessThanOrEqual(1);
  });

  it("is monotonic: more skew => higher Gini", () => {
    expect(gini([10, 10, 10, 70])).toBeGreaterThan(gini([20, 25, 25, 30]));
  });
});

describe("analytics: referral math", () => {
  it("kFactor guards divide-by-zero and divides otherwise", () => {
    expect(kFactor(10, 0)).toBe(0);
    expect(kFactor(6, 12)).toBe(0.5);
  });

  it("reuseRate is the fraction of redemptions beyond first-per-link", () => {
    expect(reuseRate(0, 0)).toBe(0);
    // 10 redemptions across 4 links => 6 are reuse => 0.6
    expect(reuseRate(10, 4)).toBe(0.6);
    // never negative
    expect(reuseRate(3, 5)).toBe(0);
  });

  it("retentionCurve computes retained/active per week", () => {
    const curve = retentionCurve([
      { week: "2026-W01", active: 10, retained: 6 },
      { week: "2026-W02", active: 0, retained: 0 },
    ]);
    expect(curve[0].rate).toBe(0.6);
    expect(curve[1].rate).toBe(0); // guards divide-by-zero
  });
});

describe("analytics: activity score", () => {
  it("is bounded in [0,100]", () => {
    expect(
      activityScore({ volume: 0, activeWeeks: 0, weeksSince: 0 }),
    ).toBeGreaterThanOrEqual(0);
    expect(
      activityScore({
        volume: 1e6,
        activeWeeks: 1000,
        weeksSince: 0,
        refBrought: 1000,
      }),
    ).toBeLessThanOrEqual(100);
  });

  it("rewards more volume, more active weeks, and recency", () => {
    const base = activityScore({ volume: 10, activeWeeks: 2, weeksSince: 2 });
    expect(
      activityScore({ volume: 50, activeWeeks: 2, weeksSince: 2 }),
    ).toBeGreaterThan(base);
    expect(
      activityScore({ volume: 10, activeWeeks: 8, weeksSince: 2 }),
    ).toBeGreaterThan(base);
    // Fresher activity (smaller weeksSince) scores higher than stale.
    expect(
      activityScore({ volume: 10, activeWeeks: 2, weeksSince: 0 }),
    ).toBeGreaterThan(
      activityScore({ volume: 10, activeWeeks: 2, weeksSince: 20 }),
    );
  });

  it("advocacy adds a small bonus", () => {
    const without = activityScore({
      volume: 10,
      activeWeeks: 2,
      weeksSince: 1,
    });
    const with_ = activityScore({
      volume: 10,
      activeWeeks: 2,
      weeksSince: 1,
      refBrought: 5,
    });
    expect(with_).toBeGreaterThan(without);
  });
});

describe("analytics: describe", () => {
  it("summarises a distribution", () => {
    const d = describeDist([1, 2, 3, 4, 5]);
    expect(d.count).toBe(5);
    expect(d.mean).toBe(3);
    expect(d.min).toBe(1);
    expect(d.max).toBe(5);
    expect(d.p50).toBe(3);
    expect(d.gini).toBeGreaterThanOrEqual(0);
  });
});
