/**
 * Sanity unit tests for `percentile`. Property-based coverage (exact values at
 * ranks, monotonicity as p increases) lives in the separate PBT tasks 6.2/6.3.
 */

import { describe, expect, it } from "vitest";

import { NO_DATA } from "@/models";
import { percentile } from "./percentile";

describe("percentile", () => {
  it("returns NO_DATA for empty input", () => {
    expect(percentile([], 50)).toBe(NO_DATA);
  });

  it("returns the single value regardless of p", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("computes the median (P50) of an odd-length set", () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });

  it("interpolates between the two middle values for even length", () => {
    // rank = 0.5 * 3 = 1.5 -> between index 1 (2) and 2 (3) -> 2.5
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("returns exact endpoints at P0 and P100", () => {
    const values = [5, 1, 9, 3, 7];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(9);
  });

  it("interpolates P90 between nearest ranks", () => {
    // n = 5, rank = 0.9 * 4 = 3.6 -> sorted[3]=7 + 0.6*(9-7) = 8.2
    expect(percentile([1, 3, 5, 7, 9], 90)).toBeCloseTo(8.2, 10);
  });

  it("does not mutate the input array", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it("produces monotonic non-decreasing values as p increases", () => {
    const values = [10, 2, 8, 4, 6];
    const p50 = percentile(values, 50) as number;
    const p90 = percentile(values, 90) as number;
    const p95 = percentile(values, 95) as number;
    expect(p50).toBeLessThanOrEqual(p90);
    expect(p90).toBeLessThanOrEqual(p95);
  });
});
