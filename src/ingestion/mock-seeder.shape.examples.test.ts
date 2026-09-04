/**
 * MockDataSeeder shape example test (task 13.4).
 *
 * Asserts the exhaustive shape of the standard demo dataset: it covers all 30
 * days, every demo platform, both live and VOD stream types, both compared
 * apps, and — critically — emits a value for *every* KPI in the registry on
 * every slice. This is the "30 days × all platforms × live+VOD × every KPI"
 * assertion referenced in the seeder's comments; the deterministic/scale sanity
 * checks live in mock-seeder.test.ts and are not duplicated here.
 *
 * Validates: Requirements 9.2, 9.3
 */

import { describe, expect, it } from "vitest";

import { ALL_KPI_IDS } from "@/registry/kpi-registry";
import { DEMO_DAYS, seedMockDataset } from "./mock-seeder";

const DEMO_PLATFORMS = ["Android", "Android TV", "Desktop Web"] as const;
const DEMO_STREAM_TYPES = ["Live Sports/Events", "VOD Movies"] as const;
const DEMO_APPS = ["App_A", "App_B"] as const;

describe("seedMockDataset — standard dataset shape (task 13.4)", () => {
  const ds = seedMockDataset({ scale: "standard" });

  it("spans exactly 30 distinct UTC days (Req 9.2)", () => {
    const days = new Set(ds.records.map((r) => r.timestampUtc.slice(0, 10)));
    expect(days.size).toBe(DEMO_DAYS);
  });

  it("covers every demo platform × live+VOD × both apps for all 30 days (Req 9.3)", () => {
    // One record per (day × platform × streamType × app): the full cross-product.
    expect(ds.records.length).toBe(
      DEMO_DAYS * DEMO_PLATFORMS.length * DEMO_STREAM_TYPES.length * DEMO_APPS.length,
    );

    const seen = new Set(
      ds.records.map(
        (r) =>
          `${r.timestampUtc.slice(0, 10)}|${r.dimensions.platform}|${r.dimensions.streamType}|${r.app}`,
      ),
    );

    const days = [...new Set(ds.records.map((r) => r.timestampUtc.slice(0, 10)))];
    for (const day of days) {
      for (const platform of DEMO_PLATFORMS) {
        for (const streamType of DEMO_STREAM_TYPES) {
          for (const app of DEMO_APPS) {
            expect(seen.has(`${day}|${platform}|${streamType}|${app}`)).toBe(true);
          }
        }
      }
    }
    // No slice appears twice.
    expect(seen.size).toBe(ds.records.length);
  });

  it("emits a value for every KPI in the registry on every slice (Req 9.2, 9.3)", () => {
    expect(ALL_KPI_IDS.length).toBeGreaterThan(0);
    for (const r of ds.records) {
      expect(r.metrics).toBeDefined();
      const metrics = r.metrics!;
      for (const kpiId of ALL_KPI_IDS) {
        expect(metrics[kpiId]).toBeDefined();
        expect(typeof metrics[kpiId]).toBe("number");
        expect(Number.isFinite(metrics[kpiId])).toBe(true);
      }
    }
  });

  it("the union of emitted KPIs equals the full registry — nothing extra, nothing missing", () => {
    const emitted = new Set<string>();
    for (const r of ds.records) {
      for (const key of Object.keys(r.metrics ?? {})) {
        emitted.add(key);
      }
    }
    expect(emitted).toEqual(new Set<string>(ALL_KPI_IDS));
  });
});
