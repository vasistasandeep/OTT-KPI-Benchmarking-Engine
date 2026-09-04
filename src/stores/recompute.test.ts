/**
 * Integration tests for the recompute pipeline and the state stores (task 14.1).
 *
 * These run against the in-memory repository (no IndexedDB needed) and rely on
 * the engine's synchronous in-thread fallback under jsdom, so a full
 * restore → slice → aggregate → compare → cache cycle is exercised end to end:
 *
 * - restore on load promotes the persisted active dataset, else the most recent,
 *   else seeds the demo dataset (Req 3.3, 9.4);
 * - the restored SLA config is loaded into `useSLAStore`;
 * - a recompute populates `useResultStore` with a comparison for the slice;
 * - an empty slice sets the `noData` flag (Req 10.6);
 * - the App_A/App_B labels follow the active dataset (Req 19).
 */

import { describe, it, expect, beforeEach } from "vitest";

import { InMemoryKPIRepository } from "@/repository/InMemoryKPIRepository";
import type { KPIDataRepository } from "@/repository";
import { seedMockDataset } from "@/ingestion/mock-seeder";
import type { Dataset } from "@/models/records";
import type { SLAConfig } from "@/models/config";
import { bucketTimestamp } from "@/engine/bucket";

import { useDatasetStore, DEFAULT_APP_A_LABEL } from "./useDatasetStore";
import { useFilterStore, defaultFilterSlice } from "./useFilterStore";
import { useSLAStore } from "./useSLAStore";
import { useResultStore } from "./useResultStore";
import { hydrate, runRecompute, restoreActiveDataset } from "./recompute";

// A fixed "now" inside the demo window (demo ends 2025-03-31) so the default
// 30d preset actually matches the seeded records.
const NOW = Date.parse("2025-03-31T12:00:00Z");

function resetStores(): void {
  useDatasetStore.setState({
    activeDataset: null,
    datasets: [],
    appALabel: DEFAULT_APP_A_LABEL,
    appBLabel: "App B",
  });
  useFilterStore.setState({ slice: defaultFilterSlice(), revision: 0 });
  useSLAStore.getState().reset();
  useResultStore.setState({
    result: null,
    aggregated: null,
    noData: false,
    status: "idle",
    progress: null,
    slice: null,
    error: null,
  });
}

/** A tiny pre-aggregated dataset with records inside the demo window. */
function smallDataset(id: string, name: string, createdAt: string): Dataset {
  const ts = "2025-03-20T00:00:00Z";
  return {
    id,
    name,
    createdAt,
    appALabel: "Alpha",
    appBLabel: "Beta",
    recordCount: 2,
    sourceType: "Aggregated",
    ingestionMode: "Pre_Aggregated",
    records: [
      {
        id: `${id}:a`,
        datasetId: id,
        app: "App_A",
        timestampUtc: ts,
        sourceUtcOffsetMinutes: 0,
        bucket: bucketTimestamp(ts),
        origin: "file",
        dimensions: { platform: "Android" } as Dataset["records"][number]["dimensions"],
        metrics: { vst_p50: 0.9 },
        volumeWeight: 100,
        ingestedGranularity: "day",
      },
      {
        id: `${id}:b`,
        datasetId: id,
        app: "App_B",
        timestampUtc: ts,
        sourceUtcOffsetMinutes: 0,
        bucket: bucketTimestamp(ts),
        origin: "file",
        dimensions: { platform: "Android" } as Dataset["records"][number]["dimensions"],
        metrics: { vst_p50: 1.1 },
        volumeWeight: 100,
        ingestedGranularity: "day",
      },
    ],
  };
}

describe("restoreActiveDataset", () => {
  let repo: KPIDataRepository;
  beforeEach(() => {
    repo = new InMemoryKPIRepository();
    resetStores();
  });

  it("seeds and persists the demo dataset when none exists (Req 9.4)", async () => {
    const restored = await restoreActiveDataset(repo);
    expect(restored).not.toBeNull();
    expect(restored!.sourceType).toBe("Mock");
    // Persisted as active so the next boot restores the same dataset (Req 3.3).
    expect(await repo.getActiveDatasetId()).toBe(restored!.id);
    expect((await repo.listDatasets()).map((m) => m.id)).toContain(restored!.id);
  });

  it("restores the persisted active dataset when present (Req 3.3)", async () => {
    const ds = smallDataset("keep", "Keep", "2025-02-01T00:00:00Z");
    await repo.saveDataset(ds);
    await repo.setActiveDatasetId("keep");

    const restored = await restoreActiveDataset(repo);
    expect(restored!.id).toBe("keep");
  });

  it("promotes the most recently created dataset when no active pointer is set", async () => {
    await repo.saveDataset(smallDataset("old", "Old", "2025-01-01T00:00:00Z"));
    await repo.saveDataset(smallDataset("new", "New", "2025-03-01T00:00:00Z"));

    const restored = await restoreActiveDataset(repo);
    expect(restored!.id).toBe("new");
    expect(await repo.getActiveDatasetId()).toBe("new");
  });
});

describe("hydrate + runRecompute", () => {
  let repo: KPIDataRepository;
  beforeEach(() => {
    repo = new InMemoryKPIRepository();
    resetStores();
  });

  it("loads the saved SLA config into the store on hydrate", async () => {
    const sla: SLAConfig = { varianceBand: 3, thresholds: { vst_p50: 1.0 }, minSampleSize: 0 };
    await repo.saveSLAConfig(sla);
    await repo.saveDataset(smallDataset("d", "D", "2025-03-01T00:00:00Z"));
    await repo.setActiveDatasetId("d");

    const handle = await hydrate(repo, NOW);
    expect(useSLAStore.getState().config).toEqual(sla);
    handle.dispose();
  });

  it("populates the result cache and App labels for the restored dataset", async () => {
    await repo.saveDataset(smallDataset("d", "D", "2025-03-01T00:00:00Z"));
    await repo.setActiveDatasetId("d");

    const handle = await hydrate(repo, NOW);

    const results = useResultStore.getState();
    expect(results.status).toBe("ready");
    expect(results.noData).toBe(false);
    expect(results.result).not.toBeNull();
    // A vst_p50 comparison should be present with both apps' values.
    const vst = results.result!.results.find((r) => r.kpiId === "vst_p50");
    expect(vst).toBeDefined();
    expect(vst!.appAValue).toBeCloseTo(0.9, 5);
    expect(vst!.appBValue).toBeCloseTo(1.1, 5);

    // App labels follow the active dataset (Req 19).
    expect(useDatasetStore.getState().appALabel).toBe("Alpha");
    expect(useDatasetStore.getState().appBLabel).toBe("Beta");
    handle.dispose();
  });

  it("sets the no-data flag when the slice matches no records (Req 10.6)", async () => {
    await repo.saveDataset(smallDataset("d", "D", "2025-03-01T00:00:00Z"));
    await repo.setActiveDatasetId("d");
    // Narrow the slice to a window with no records BEFORE hydrating.
    useFilterStore.setState({
      slice: { ...defaultFilterSlice(), dateRange: { preset: "custom", from: "2020-01-01", to: "2020-01-02" } },
      revision: 0,
    });

    const handle = await hydrate(repo, NOW);
    expect(useResultStore.getState().noData).toBe(true);
    handle.dispose();
  });

  it("surfaces a no-data cache with no error when no dataset is active", async () => {
    // No dataset saved and none loaded into the store.
    await runRecompute(NOW);
    const results = useResultStore.getState();
    expect(results.noData).toBe(true);
    expect(results.status).toBe("ready");
    expect(results.result!.results).toEqual([]);
  });

  it("recomputes after a debounced filter change", async () => {
    await repo.saveDataset(smallDataset("d", "D", "2025-03-01T00:00:00Z"));
    await repo.setActiveDatasetId("d");
    const handle = await hydrate(repo, NOW);
    expect(useResultStore.getState().noData).toBe(false);

    // Change the filter to an empty window; the subscription schedules a
    // debounced recompute. Run it directly to assert the pipeline reacts.
    useFilterStore.getState().setDateRange({ preset: "custom", from: "2020-01-01", to: "2020-01-02" });
    await runRecompute(NOW);
    expect(useResultStore.getState().noData).toBe(true);
    handle.dispose();
  });
});

describe("mock demo dataset end to end", () => {
  beforeEach(resetStores);

  it("aggregates the seeded demo dataset without errors", async () => {
    const repo = new InMemoryKPIRepository();
    const demo = seedMockDataset();
    await repo.saveDataset(demo);
    await repo.setActiveDatasetId(demo.id);

    const handle = await hydrate(repo, NOW);
    const results = useResultStore.getState();
    expect(results.status).toBe("ready");
    expect(results.noData).toBe(false);
    expect(results.result!.results.length).toBeGreaterThan(0);
    handle.dispose();
  });
});
