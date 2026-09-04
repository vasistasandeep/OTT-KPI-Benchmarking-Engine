/**
 * Sanity unit tests for `weightedAverage`. The exhaustive convex-combination
 * property coverage lives in the dedicated property test (task 6.9).
 */

import { describe, it, expect } from "vitest";
import { NO_DATA } from "../models/sentinels";
import { weightedAverage } from "./weighted-average";

describe("weightedAverage", () => {
  it("computes sum(vi*wi)/sum(wi) and flags weighted when all weights present", () => {
    // (10*1 + 20*3) / (1 + 3) = 70 / 4 = 17.5
    const result = weightedAverage([
      { value: 10, weight: 1 },
      { value: 20, weight: 3 },
    ]);
    expect(result).toEqual({ value: 17.5, weighted: true });
  });

  it("falls back to the unweighted mean when a weight is missing", () => {
    // (10 + 20 + 30) / 3 = 20
    const result = weightedAverage([
      { value: 10, weight: 5 },
      { value: 20 },
      { value: 30, weight: 2 },
    ]);
    expect(result).toEqual({ value: 20, weighted: false });
  });

  it("falls back to the unweighted mean when weights sum to zero", () => {
    // sum(w) == 0 -> no weighted mean definable, use (4 + 8) / 2 = 6
    const result = weightedAverage([
      { value: 4, weight: 0 },
      { value: 8, weight: 0 },
    ]);
    expect(result).toEqual({ value: 6, weighted: false });
  });

  it("returns NO_DATA for empty input", () => {
    const result = weightedAverage([]);
    expect(result.value).toBe(NO_DATA);
    expect(result.weighted).toBe(false);
  });
});
