/**
 * MockDataSeeder sanity tests (task 13.3).
 *
 * These are lightweight checks that the seeder is deterministic and emits the
 * right shape/scale. The exhaustive "30 days × all platforms × live+VOD × every
 * KPI" shape assertion is the separate shape example test (task 13.4) and is not
 * duplicated here.
 *
 * Validates: Requirements 9.2, 9.3, 15.3, 17.4
 */

import { describe, expect, it } from "vitest";

import { bucketTimestamp } from "@/engine/bucket";
import {
  DEMO_APP_A_LABEL,
  DEMO_APP_B_LABEL,
  DEMO_DAYS,
  seedMockDataset,
} from "./mock-seeder";

describe("seedMockDataset", () => {
  it("is deterministic: same options yield identical records", () => {
    const a = seedMockDataset({ scale: "standard", seed: 42 });
    const b = seedMockDataset({ scale: "standard", seed: 42 });
    expect(a).toEqual(b);
  });

  it("different seeds change the generated values", () => {
    const a = seedMockDataset({ scale: "standard", seed: 1 });
    const b = seedMockDataset({ scale: "standard", seed: 2 });
    expect(a.records).not.toEqual(b.records);
  });

  it("labels App_A Current and App_B Experimental/Competitor (Req 9.2)", () => {
    const ds = seedMockDataset({ scale: "standard" });
    expect(ds.appALabel).toBe(DEMO_APP_A_LABEL);
    expect(ds.appBLabel).toBe(DEMO_APP_B_LABEL);
    expect(ds.sourceType).toBe("Mock");
  });

  it("standard profile is a compact pre-aggregated dataset (~500 records)", () => {
    const ds = seedMockDataset({ scale: "standard" });
    expect(ds.ingestionMode).toBe("Pre_Aggregated");
    expect(ds.recordCount).toBe(ds.records.length);
    // 30 days × 3 platforms × 2 stream types × 2 apps = 360.
    expect(ds.records.length).toBe(DEMO_DAYS * 3 * 2 * 2);
    for (const r of ds.records) {
      expect(r.origin).toBe("mock");
      expect(r.metrics).toBeDefined();
      expect(r.session).toBeUndefined();
    }
  });

  it("stress profile is raw-session and clears the 25,000-record worker threshold (Req 17.4)", () => {
    const ds = seedMockDataset({ scale: "stress" });
    expect(ds.ingestionMode).toBe("Raw_Session");
    expect(ds.records.length).toBeGreaterThan(25000);
    const sample = ds.records[0];
    expect(sample.session).toBeDefined();
    expect(sample.session?.userId).toMatch(/^u\d+$/);
    expect(sample.metrics).toBeUndefined();
  });

  it("emits UTC timestamps and buckets consistent with bucketTimestamp (Req 26.5)", () => {
    const ds = seedMockDataset({ scale: "standard" });
    for (const r of ds.records.slice(0, 20)) {
      expect(r.timestampUtc.endsWith("Z")).toBe(true);
      expect(r.bucket).toEqual(bucketTimestamp(r.timestampUtc));
    }
  });

  it("spans Mobile, Connected TV, and Desktop Web platforms and live + VOD (Req 9.3)", () => {
    const ds = seedMockDataset({ scale: "standard" });
    const platforms = new Set(ds.records.map((r) => r.dimensions.platform));
    const streamTypes = new Set(ds.records.map((r) => r.dimensions.streamType));
    expect(platforms).toEqual(new Set(["Android", "Android TV", "Desktop Web"]));
    expect(streamTypes).toEqual(new Set(["Live Sports/Events", "VOD Movies"]));
  });
});
