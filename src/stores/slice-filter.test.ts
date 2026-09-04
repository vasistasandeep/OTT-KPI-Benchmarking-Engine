/**
 * Unit tests for the slice filter (task 14.1).
 *
 * Cover the two design rules the recompute pipeline depends on: inclusive UTC
 * bucket boundaries (Req 26.7) and `7d`/`30d` presets resolved to explicit
 * from/to windows relative to a fixed "now" (Req 26.8, 26.9), plus dimension
 * chip and app-toggle filtering (Req 10.3, 10.4).
 */

import { describe, it, expect } from "vitest";

import { applySlice, resolveDateRange } from "./slice-filter";
import { defaultFilterSlice } from "./useFilterStore";
import type { FilterSlice } from "@/models/results";
import type { AppAssignment, KPIRecord } from "@/models/records";
import { bucketTimestamp } from "@/engine/bucket";

// A fixed reference "now" so preset resolution is deterministic.
const NOW = Date.parse("2025-03-31T12:34:56Z");

let seq = 0;
function record(
  timestampUtc: string,
  app: AppAssignment = "App_A",
  dimensions: Record<string, string> = {},
): KPIRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    datasetId: "d",
    app,
    timestampUtc,
    sourceUtcOffsetMinutes: 0,
    bucket: bucketTimestamp(timestampUtc),
    origin: "file",
    dimensions: dimensions as KPIRecord["dimensions"],
  };
}

describe("resolveDateRange", () => {
  it("resolves the 7d preset to the last 7 UTC days inclusive of today", () => {
    const slice: FilterSlice = { ...defaultFilterSlice(), dateRange: { preset: "7d" } };
    const range = resolveDateRange(slice, NOW);
    // today = 2025-03-31, so 7d window is 2025-03-25 .. 2025-03-31 inclusive.
    expect(range).toEqual({ from: "2025-03-25", to: "2025-03-31" });
  });

  it("resolves the 30d preset to a 30-UTC-day inclusive window", () => {
    const slice: FilterSlice = { ...defaultFilterSlice(), dateRange: { preset: "30d" } };
    const range = resolveDateRange(slice, NOW);
    expect(range).toEqual({ from: "2025-03-02", to: "2025-03-31" });
  });

  it("expands presets to hour boundaries at hour granularity", () => {
    const slice: FilterSlice = {
      ...defaultFilterSlice(),
      granularity: "hour",
      dateRange: { preset: "7d" },
    };
    const range = resolveDateRange(slice, NOW);
    expect(range).toEqual({ from: "2025-03-25T00:00:00Z", to: "2025-03-31T23:00:00Z" });
  });

  it("passes a custom range through, normalized to the granularity", () => {
    const slice: FilterSlice = {
      ...defaultFilterSlice(),
      dateRange: { preset: "custom", from: "2025-01-05", to: "2025-01-10" },
    };
    expect(resolveDateRange(slice, NOW)).toEqual({ from: "2025-01-05", to: "2025-01-10" });
  });
});

describe("applySlice", () => {
  it("includes records on both inclusive UTC day boundaries and excludes those outside", () => {
    const slice: FilterSlice = {
      ...defaultFilterSlice(),
      dateRange: { preset: "custom", from: "2025-03-10", to: "2025-03-12" },
    };
    const before = record("2025-03-09T23:00:00Z");
    const lower = record("2025-03-10T00:00:00Z");
    const upper = record("2025-03-12T23:59:00Z");
    const after = record("2025-03-13T00:00:00Z");

    const kept = applySlice([before, lower, upper, after], slice, NOW);
    const ids = kept.map((r) => r.id);
    expect(ids).toContain(lower.id);
    expect(ids).toContain(upper.id);
    expect(ids).not.toContain(before.id);
    expect(ids).not.toContain(after.id);
  });

  it("filters by app toggle", () => {
    const slice: FilterSlice = {
      ...defaultFilterSlice(),
      dateRange: { preset: "custom", from: "2025-03-01", to: "2025-03-31" },
      apps: ["App_B"],
    };
    const a = record("2025-03-15T10:00:00Z", "App_A");
    const b = record("2025-03-15T10:00:00Z", "App_B");
    const kept = applySlice([a, b], slice, NOW);
    expect(kept.map((r) => r.id)).toEqual([b.id]);
  });

  it("filters by dimension chip selection and treats missing values as Unknown", () => {
    const slice: FilterSlice = {
      ...defaultFilterSlice(),
      dateRange: { preset: "custom", from: "2025-03-01", to: "2025-03-31" },
      dimensionSelections: { platform: ["Android"] },
    };
    const android = record("2025-03-15T10:00:00Z", "App_A", { platform: "Android" });
    const desktop = record("2025-03-15T10:00:00Z", "App_A", { platform: "Desktop Web" });
    const missing = record("2025-03-15T10:00:00Z", "App_A", {});
    const kept = applySlice([android, desktop, missing], slice, NOW);
    expect(kept.map((r) => r.id)).toEqual([android.id]);

    const unknownSlice: FilterSlice = {
      ...slice,
      dimensionSelections: { platform: ["Unknown"] },
    };
    const keptUnknown = applySlice([android, missing], unknownSlice, NOW);
    expect(keptUnknown.map((r) => r.id)).toEqual([missing.id]);
  });

  it("an empty selection for a dimension leaves it unconstrained", () => {
    const slice: FilterSlice = {
      ...defaultFilterSlice(),
      dateRange: { preset: "custom", from: "2025-03-01", to: "2025-03-31" },
      dimensionSelections: { platform: [] },
    };
    const a = record("2025-03-15T10:00:00Z", "App_A", { platform: "Android" });
    const b = record("2025-03-15T10:00:00Z", "App_A", { platform: "Desktop Web" });
    expect(applySlice([a, b], slice, NOW)).toHaveLength(2);
  });
});
