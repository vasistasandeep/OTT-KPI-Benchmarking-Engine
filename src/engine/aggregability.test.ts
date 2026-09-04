/**
 * Sanity unit tests for `distinctCount` and `resolveAggregability`. Exhaustive
 * property coverage (dedupe idempotence, never-assembled-from-subgroups, and the
 * cross-bucket / cross-segment guard) lives in the separate PBT tasks 7.2 / 7.3.
 */

import { describe, it, expect } from "vitest";
import { NO_DATA, NOT_AGGREGABLE } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";
import {
  distinctCount,
  resolveAggregability,
  applyAggregability,
  REQUIRES_USER_ID_REASON,
} from "./aggregability";

describe("distinctCount", () => {
  it("counts distinct userId values in the group directly", () => {
    const s: RawSessionFields[] = [
      { userId: "u1" },
      { userId: "u2" },
      { userId: "u3" },
    ];
    expect(distinctCount(s)).toEqual({ value: 3, reason: null });
  });

  it("collapses duplicate session rows for the same user to one unit", () => {
    // u1 appears on three rows, u2 on two — distinct count is 2 (Req 23.1).
    const s: RawSessionFields[] = [
      { userId: "u1" },
      { userId: "u1" },
      { userId: "u1" },
      { userId: "u2" },
      { userId: "u2" },
    ];
    expect(distinctCount(s)).toEqual({ value: 2, reason: null });
  });

  it("returns NO_DATA with no reason for an empty slice (widen the slice)", () => {
    expect(distinctCount([])).toEqual({ value: NO_DATA, reason: null });
  });

  it("returns NO_DATA with the userId reason when userId is not mapped (Req 23.2)", () => {
    const s: RawSessionFields[] = [{ userId: "u1" }, { userId: "u2" }];
    expect(distinctCount(s, false)).toEqual({
      value: NO_DATA,
      reason: REQUIRES_USER_ID_REASON,
    });
  });

  it("gives the userId reason even when the slice is empty and unmapped", () => {
    expect(distinctCount([], false)).toEqual({
      value: NO_DATA,
      reason: REQUIRES_USER_ID_REASON,
    });
  });

  it("counts a defined 0 when sessions exist but carry no userId value", () => {
    // Records exist, they just carry no identity -> 0, not NO_DATA.
    const s: RawSessionFields[] = [{ playTimeMs: 10 }, { userId: "" }];
    expect(distinctCount(s)).toEqual({ value: 0, reason: null });
  });

  it("skips sessions missing a userId but counts the ones that have it", () => {
    const s: RawSessionFields[] = [
      { userId: "u1" },
      { playTimeMs: 5 },
      { userId: "u2" },
    ];
    expect(distinctCount(s)).toEqual({ value: 2, reason: null });
  });
});

describe("resolveAggregability", () => {
  it("marks a single-bucket single-segment pre-aggregated distinct count aggregable (Req 23.5)", () => {
    expect(
      resolveAggregability("distinct_count", false, {
        bucketCount: 1,
        segmentCount: 1,
      }),
    ).toBe("aggregable");
  });

  it("marks a pre-aggregated distinct count spanning buckets not aggregable (Req 23.4)", () => {
    expect(
      resolveAggregability("distinct_count", false, {
        bucketCount: 2,
        segmentCount: 1,
      }),
    ).toBe("not_aggregable");
  });

  it("marks a pre-aggregated distinct count spanning segments not aggregable (Req 23.4)", () => {
    expect(
      resolveAggregability("distinct_count", false, {
        bucketCount: 1,
        segmentCount: 3,
      }),
    ).toBe("not_aggregable");
  });

  it("marks a pre-aggregated percentile spanning buckets not aggregable (Req 23.4, 23.6)", () => {
    expect(
      resolveAggregability("percentile", false, {
        bucketCount: 5,
        segmentCount: 1,
      }),
    ).toBe("not_aggregable");
  });

  it("treats non_aggregable KPIs as a guarded kind across a wide slice", () => {
    expect(
      resolveAggregability("non_aggregable", false, {
        bucketCount: 2,
        segmentCount: 2,
      }),
    ).toBe("not_aggregable");
  });

  it("keeps raw-mode distinct counts aggregable — recomputed directly (Req 23.3)", () => {
    expect(
      resolveAggregability("distinct_count", true, {
        bucketCount: 10,
        segmentCount: 4,
      }),
    ).toBe("aggregable");
  });

  it("keeps raw-mode percentiles aggregable — recomputed from raw values (Req 23.7)", () => {
    expect(
      resolveAggregability("percentile", true, {
        bucketCount: 10,
        segmentCount: 4,
      }),
    ).toBe("aggregable");
  });

  it("never guards additive / recomputable kinds regardless of extent", () => {
    const wide = { bucketCount: 9, segmentCount: 9 };
    expect(resolveAggregability("sum", false, wide)).toBe("aggregable");
    expect(resolveAggregability("ratio", false, wide)).toBe("aggregable");
    expect(resolveAggregability("weighted_avg", false, wide)).toBe("aggregable");
    expect(resolveAggregability("arithmetic_avg", false, wide)).toBe("aggregable");
  });

  it("treats an empty (zero-bucket) slice as aggregable — NO_DATA territory, not a merge", () => {
    expect(
      resolveAggregability("distinct_count", false, {
        bucketCount: 0,
        segmentCount: 0,
      }),
    ).toBe("aggregable");
  });
});

describe("applyAggregability", () => {
  it("replaces the value with NOT_AGGREGABLE when not aggregable", () => {
    expect(applyAggregability(42, "not_aggregable")).toBe(NOT_AGGREGABLE);
  });

  it("passes the value through when aggregable", () => {
    expect(applyAggregability(42, "aggregable")).toBe(42);
  });

  it("passes NO_DATA through unchanged when aggregable", () => {
    expect(applyAggregability(NO_DATA, "aggregable")).toBe(NO_DATA);
  });
});
