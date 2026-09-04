/**
 * Sanity unit tests for the authoritative completion-quartile logic: raw-mode
 * `rate(q)` and the pre-aggregated funnel-monotonicity check. Exhaustive
 * property coverage (raw monotonicity, denominator, retention) lives in the
 * dedicated property test (task 6.13).
 */

import { describe, it, expect } from "vitest";
import { NO_DATA } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";
import {
  QUARTILES,
  completionQuartileRates,
  readQuartileValues,
  findQuartileViolations,
  checkQuartileMonotonicity,
} from "./quartiles";

describe("completionQuartileRates (raw mode)", () => {
  it("counts nested quartiles over started sessions, monotonic non-increasing", () => {
    const s: RawSessionFields[] = [
      { quartileReached: 100 },
      { quartileReached: 75 },
      { quartileReached: 25 },
      { quartileReached: 0 },
    ];
    const r = completionQuartileRates(s);
    // reached>=25: 3/4=75, >=50: 2/4=50, >=75: 2/4=50, >=100: 1/4=25
    expect(r[25]).toBe(75);
    expect(r[50]).toBe(50);
    expect(r[75]).toBe(50);
    expect(r[100]).toBe(25);
    // monotonic non-increasing by construction
    expect(r[25] as number).toBeGreaterThanOrEqual(r[50] as number);
    expect(r[50] as number).toBeGreaterThanOrEqual(r[75] as number);
    expect(r[75] as number).toBeGreaterThanOrEqual(r[100] as number);
  });

  it("treats a missing quartileReached as 0 (session started, reached none)", () => {
    const s: RawSessionFields[] = [{ quartileReached: 50 }, {}];
    const r = completionQuartileRates(s);
    // one of two sessions reached >=25 and >=50
    expect(r[25]).toBe(50);
    expect(r[50]).toBe(50);
    expect(r[75]).toBe(0);
    expect(r[100]).toBe(0);
  });

  it("rounds rates to 2 decimals", () => {
    const s: RawSessionFields[] = [
      { quartileReached: 100 },
      { quartileReached: 0 },
      { quartileReached: 0 },
    ];
    // 1/3 * 100 = 33.333... -> 33.33
    expect(completionQuartileRates(s)[100]).toBe(33.33);
  });

  it("returns NO_DATA for every quartile when there are no sessions", () => {
    const r = completionQuartileRates([]);
    expect(r[25]).toBe(NO_DATA);
    expect(r[50]).toBe(NO_DATA);
    expect(r[75]).toBe(NO_DATA);
    expect(r[100]).toBe(NO_DATA);
  });
});

describe("readQuartileValues", () => {
  it("reads finite quartile metrics into a keyed map", () => {
    const values = readQuartileValues({
      metrics: {
        content_completion_25: 80,
        content_completion_50: 60,
        content_completion_75: 40,
        content_completion_100: 20,
      },
    });
    expect(values).toEqual({ 25: 80, 50: 60, 75: 40, 100: 20 });
  });

  it("ignores missing metrics and returns {} when there are none", () => {
    expect(readQuartileValues({})).toEqual({});
    expect(readQuartileValues({ metrics: { content_completion_50: 60 } })).toEqual({
      50: 60,
    });
  });
});

describe("findQuartileViolations", () => {
  it("finds no violation for monotonic non-increasing values", () => {
    expect(findQuartileViolations({ 25: 80, 50: 60, 75: 40, 100: 20 })).toEqual([]);
  });

  it("allows equal adjacent values (>= not >)", () => {
    expect(findQuartileViolations({ 25: 50, 50: 50, 75: 50, 100: 50 })).toEqual([]);
  });

  it("reports the offending pair when a lower quartile is below a higher one", () => {
    const v = findQuartileViolations({ 25: 40, 50: 60 });
    expect(v).toEqual([{ lower: 25, higher: 50, lowerValue: 40, higherValue: 60 }]);
  });

  it("compares the next present quartile when intermediate ones are absent", () => {
    const v = findQuartileViolations({ 25: 30, 100: 70 });
    expect(v).toEqual([{ lower: 25, higher: 100, lowerValue: 30, higherValue: 70 }]);
  });

  it("returns no violation for fewer than two present values", () => {
    expect(findQuartileViolations({ 50: 60 })).toEqual([]);
    expect(findQuartileViolations({})).toEqual([]);
  });
});

describe("checkQuartileMonotonicity (pre-aggregated)", () => {
  it("returns null for a monotonic record", () => {
    const advisory = checkQuartileMonotonicity({
      id: "r1",
      metrics: {
        content_completion_25: 90,
        content_completion_50: 70,
        content_completion_75: 50,
        content_completion_100: 30,
      },
    });
    expect(advisory).toBeNull();
  });

  it("raises NON_MONOTONIC_QUARTILES naming the record and offending pair", () => {
    const advisory = checkQuartileMonotonicity({
      id: "r2",
      metrics: {
        content_completion_25: 40,
        content_completion_50: 60,
        content_completion_75: 30,
        content_completion_100: 10,
      },
    });
    expect(advisory).not.toBeNull();
    expect(advisory?.code).toBe("NON_MONOTONIC_QUARTILES");
    expect(advisory?.detail).toContain("r2");
    // 25% (40) is below 50% (60)
    expect(advisory?.detail).toContain("25%");
    expect(advisory?.detail).toContain("50%");
  });

  it("returns null when fewer than two quartile values are present", () => {
    expect(
      checkQuartileMonotonicity({ id: "r3", metrics: { content_completion_50: 60 } }),
    ).toBeNull();
    expect(checkQuartileMonotonicity({ id: "r4" })).toBeNull();
  });
});

describe("QUARTILES", () => {
  it("lists the four funnel thresholds in ascending order", () => {
    expect(QUARTILES).toEqual([25, 50, 75, 100]);
  });
});
