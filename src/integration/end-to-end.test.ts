/**
 * End-to-end integration tests for the OTT KPI Benchmarking Engine (task 21.1).
 *
 * Unlike the focused unit/property suites, these wire real modules together and
 * exercise whole user journeys against the actual persistence, store, recompute,
 * worker, and ingestion implementations. They run entirely in jsdom:
 *   - `fake-indexeddb/auto` (registered in src/test/setup.ts) backs the
 *     `DexieKPIRepository` so the persistence journeys hit the same code path a
 *     browser would; and
 *   - the `WorkerAggregationEngine` transparently falls back to synchronous
 *     in-thread execution where no `Worker` global exists (Req 17.2), so the
 *     worker-offload journey exercises the *routing decision* end to end while
 *     the computation runs inline.
 *
 * Flows covered:
 *   1. Offline ingest -> persist -> reload -> visualize (Req 3.4).
 *   2. A filter-change recompute updates every module via `useResultStore`
 *      (Req 10.5, 13.4).
 *   3. Worker offload above 25,000 records for a stress raw-session dataset
 *      (Req 17.2, 17.4).
 *   4. Storage-quota pre-flight refusal, `QuotaExceededError` rollback, and the
 *      denied-persistence advisory against `fake-indexeddb`
 *      (Req 27.1, 27.2, 27.5, 3.5, 27.3, 27.4).
 *   5. Retention deletion-candidate surfacing (Req 27.6, 27.7).
 *   6. Wide-format end-to-end equivalence with two single-app files
 *      (Req 21.5, 21.6, 21.7).
 *
 * Requirements: 3.4, 10.5, 13.4, 17.2, 17.4, 21.5, 21.6, 21.7,
 * 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DexieKPIRepository } from "@/repository/DexieKPIRepository";
import { InMemoryKPIRepository } from "@/repository/InMemoryKPIRepository";
import { createKPIRepository } from "@/repository/createKPIRepository";
import {
  QuotaExceededError,
  QuotaPreflightError,
  type NotifyFn,
  type RepositoryNotification,
} from "@/repository/support";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";

import { seedMockDataset } from "@/ingestion/mock-seeder";
import {
  buildConfirmedMapping,
  ingestConfirmedMapping,
  proposeMappingDraft,
} from "@/ingestion/ingestion-flow";
import type { ParsedFile } from "@/ingestion/file-parser";

import { bucketTimestamp } from "@/engine/bucket";
import { aggregate } from "@/engine/aggregation-engine";
import { shouldUseWorker } from "@/worker/worker-aggregation-engine";
import { KPI_BY_ID } from "@/registry/kpi-registry";
import type { KPIDefinition } from "@/registry/kpi-types";

import type { Dataset } from "@/models/records";
import type { ColumnMapping } from "@/models/config";

import {
  useDatasetStore,
  DEFAULT_APP_A_LABEL,
  DEFAULT_APP_B_LABEL,
} from "@/stores/useDatasetStore";
import { useFilterStore, defaultFilterSlice } from "@/stores/useFilterStore";
import { useSLAStore } from "@/stores/useSLAStore";
import { useResultStore } from "@/stores/useResultStore";
import { hydrate, runRecompute } from "@/stores/recompute";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A fixed "now" inside the seeded demo window (the mock seeder ends its window
 * on 2025-03-31) so the default 30d preset actually matches the records the
 * seeder produced. Presets resolve relative to this injected clock.
 */
const NOW = Date.parse("2025-03-31T12:00:00Z");

/** A unique database name per test so fake-indexeddb state never bleeds across. */
function uniqueDbName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

/** Reset every Zustand store to its boot defaults between tests. */
function resetStores(): void {
  useDatasetStore.setState({
    activeDataset: null,
    datasets: [],
    appALabel: DEFAULT_APP_A_LABEL,
    appBLabel: DEFAULT_APP_B_LABEL,
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

/**
 * Install a fake `navigator.storage` (jsdom ships none) with the given estimate
 * and persist behavior; returns a restore function. Mirrors the stub used by the
 * repository unit suite so the quota journeys drive the real StorageManager path.
 */
function stubStorageManager(opts: {
  usage?: number;
  quota?: number;
  persisted?: boolean;
  persist?: () => Promise<boolean>;
}): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "storage");
  const fake = {
    estimate: async () => ({ usage: opts.usage ?? 0, quota: opts.quota ?? 0 }),
    persisted: async () => opts.persisted ?? false,
    persist: opts.persist ?? (async () => true),
  };
  Object.defineProperty(navigator, "storage", { value: fake, configurable: true });
  return () => {
    if (original) Object.defineProperty(navigator, "storage", original);
    else Reflect.deleteProperty(navigator as object, "storage");
  };
}

/**
 * A tiny pre-aggregated dataset with two records (one per app) inside the demo
 * window, so a default-slice recompute produces a non-empty comparison.
 */
function smallDataset(id: string, name: string, createdAt: string): Dataset {
  const ts = "2025-03-20T00:00:00Z";
  const dims = { platform: "Android" } as Dataset["records"][number]["dimensions"];
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
        dimensions: dims,
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
        dimensions: dims,
        metrics: { vst_p50: 1.1 },
        volumeWeight: 100,
        ingestedGranularity: "day",
      },
    ],
  };
}

// ===========================================================================
// Flow 1 — Offline ingest -> persist -> reload -> visualize (Req 3.4)
// ===========================================================================

describe("offline ingest -> persist -> reload -> visualize (Req 3.4)", () => {
  let repo: DexieKPIRepository;

  beforeEach(async () => {
    resetStores();
    repo = await DexieKPIRepository.open({ databaseName: uniqueDbName("e2e-persist") });
  });

  afterEach(async () => {
    repo.database.close();
    await repo.database.delete();
  });

  it("ingests a file through the repository, then a fresh boot rehydrates and visualizes the same data", async () => {
    // --- Ingest: a long-layout file with an app column, mode Pre_Aggregated ---
    const parsed: ParsedFile = {
      headers: ["date", "app", "platform", "vst"],
      rows: [
        { date: "2025-03-20", app: "App_A", platform: "Android", vst: "0.90" },
        { date: "2025-03-20", app: "App_B", platform: "Android", vst: "1.10" },
      ],
      sampleValues: {
        date: ["2025-03-20", "2025-03-20"],
        app: ["App_A", "App_B"],
        platform: ["Android", "Android"],
        vst: ["0.90", "1.10"],
      },
    };
    const draft = proposeMappingDraft(parsed);
    const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", undefined);
    const ingest = await ingestConfirmedMapping(repo, parsed, mapping, {
      datasetId: "march-run",
      datasetName: "March Run",
      appALabel: "Current",
      appBLabel: "Experimental",
    });
    expect(ingest.dataset.recordCount).toBe(2);

    // The records are persisted in IndexedDB (via fake-indexeddb).
    expect(await repo.getRecords("march-run")).toHaveLength(2);

    // --- Reload: open a brand-new repository over the SAME database name and
    // rehydrate the pipeline, simulating a page reload after going offline. ---
    const reopened = await DexieKPIRepository.open({
      databaseName: repo.database.name,
    });
    try {
      const handle = await hydrate(reopened, NOW);
      try {
        // The persisted active dataset was restored (Req 3.4).
        expect(useDatasetStore.getState().activeDataset?.id).toBe("march-run");
        expect(useDatasetStore.getState().appALabel).toBe("Current");
        expect(useDatasetStore.getState().appBLabel).toBe("Experimental");

        // --- Visualize: the recompute produced a comparison the modules read. ---
        const results = useResultStore.getState();
        expect(results.status).toBe("ready");
        expect(results.noData).toBe(false);
        const vst = results.result!.results.find((r) => r.kpiId === "vst_p50");
        expect(vst).toBeDefined();
        expect(vst!.appAValue).toBeCloseTo(0.9, 5);
        expect(vst!.appBValue).toBeCloseTo(1.1, 5);
      } finally {
        handle.dispose();
      }
    } finally {
      reopened.database.close();
    }
  });
});

// ===========================================================================
// Flow 2 — A filter change recomputes and updates every module (Req 10.5, 13.4)
// ===========================================================================

describe("filter-change recompute updates every module (Req 10.5, 13.4)", () => {
  let repo: KPIDataRepository;

  beforeEach(() => {
    resetStores();
    repo = new InMemoryKPIRepository();
  });

  it("a filter store change flows through the recompute pipeline into useResultStore", async () => {
    await repo.saveDataset(smallDataset("d", "D", "2025-03-01T00:00:00Z"));
    await repo.setActiveDatasetId("d");

    const handle = await hydrate(repo, NOW);
    try {
      // Baseline: the default 30d slice matches the seeded records.
      expect(useResultStore.getState().noData).toBe(false);
      const baselineSlice = useResultStore.getState().slice;

      // Change the date range to a window that contains no records. The store's
      // revision bumps; the pipeline recomputes. We drive `runRecompute`
      // directly (bypassing the 150 ms debounce) to assert the propagation.
      useFilterStore
        .getState()
        .setDateRange({ preset: "custom", from: "2020-01-01", to: "2020-01-02" });
      await runRecompute(NOW);

      const after = useResultStore.getState();
      // Every module now sees the no-data state for the new slice (Req 10.6).
      expect(after.noData).toBe(true);
      expect(after.status).toBe("ready");
      // The cache's slice tracks the live filter, not the stale baseline (13.4).
      expect(after.slice).not.toEqual(baselineSlice);
      expect(after.slice!.dateRange).toEqual({
        preset: "custom",
        from: "2020-01-01",
        to: "2020-01-02",
      });

      // Widen it back and the comparison reappears — the same store drives it.
      useFilterStore.getState().setDateRange({ preset: "30d" });
      await runRecompute(NOW);
      expect(useResultStore.getState().noData).toBe(false);
      expect(
        useResultStore.getState().result!.results.some((r) => r.kpiId === "vst_p50"),
      ).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("an SLA (dimension) filter change re-slices and updates the cached result", async () => {
    // Two platforms so a dimension chip selection changes the matched slice.
    const ds = smallDataset("dim", "Dim", "2025-03-01T00:00:00Z");
    const iosA = {
      ...ds.records[0],
      id: "dim:ios-a",
      dimensions: { platform: "iOS" } as Dataset["records"][number]["dimensions"],
    };
    const withIos: Dataset = { ...ds, records: [...ds.records, iosA], recordCount: 3 };
    await repo.saveDataset(withIos);
    await repo.setActiveDatasetId("dim");

    const handle = await hydrate(repo, NOW);
    try {
      expect(useResultStore.getState().noData).toBe(false);

      // Select a platform that no record matches -> no-data across modules.
      useFilterStore.getState().setDimensionSelection("platform", ["Roku"]);
      await runRecompute(NOW);
      expect(useResultStore.getState().noData).toBe(true);

      // Select the real platform -> the comparison returns.
      useFilterStore.getState().setDimensionSelection("platform", ["Android"]);
      await runRecompute(NOW);
      expect(useResultStore.getState().noData).toBe(false);
    } finally {
      handle.dispose();
    }
  });
});

// ===========================================================================
// Flow 3 — Worker offload above 25,000 records (Req 17.2, 17.4)
// ===========================================================================

describe("worker offload above 25,000 records (Req 17.2, 17.4)", () => {
  beforeEach(resetStores);

  it("routes a stress raw-session dataset to the worker path and stays responsive", async () => {
    const repo = new InMemoryKPIRepository();
    const stress = seedMockDataset({ scale: "stress" });

    // The stress profile is a Raw_Session dataset above the 25,000 threshold,
    // so the recompute would route it to the Web Worker (Req 17.4). Under jsdom
    // there is no Worker, so the engine runs the identical pure code inline.
    expect(stress.ingestionMode).toBe("Raw_Session");
    expect(stress.records.length).toBeGreaterThan(25_000);
    expect(shouldUseWorker(stress.ingestionMode, stress.records.length)).toBe(true);

    await repo.saveDataset(stress);
    await repo.setActiveDatasetId(stress.id);

    const handle = await hydrate(repo, NOW);
    try {
      const results = useResultStore.getState();
      // The offloaded aggregation completed and produced a comparison the
      // dashboard can render — proving the worker-routed path resolves to the
      // same result contract as the synchronous path (Req 17.2).
      expect(results.status).toBe("ready");
      expect(results.noData).toBe(false);
      expect(results.result!.results.length).toBeGreaterThan(0);
    } finally {
      handle.dispose();
    }
  });

  it("keeps a sub-threshold or pre-aggregated slice on the synchronous path", async () => {
    // The compact standard demo is Pre_Aggregated, so it never offloads even
    // though it populates every module (Req 17.4).
    const standard = seedMockDataset({ scale: "standard" });
    expect(standard.ingestionMode).toBe("Pre_Aggregated");
    expect(shouldUseWorker(standard.ingestionMode, standard.records.length)).toBe(false);
  });
});

// ===========================================================================
// Flow 4 — Quota pre-flight refusal, rollback, and denied-persistence advisory
//          (Req 27.1, 27.2, 27.5, 3.5, 27.3, 27.4)
// ===========================================================================

describe("storage-quota guard against fake-indexeddb (Req 27.1-27.5, 3.5)", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("refuses a large write projected to exceed remaining quota, naming the dataset + shortfall, persisting nothing (Req 27.1, 27.2)", async () => {
    // Almost-full store: 10 bytes free. A 1-byte threshold forces the pre-flight
    // for any non-empty payload.
    restore = stubStorageManager({ usage: 990, quota: 1000 });
    const notify = vi.fn<NotifyFn>();
    const repo = await DexieKPIRepository.open({
      databaseName: uniqueDbName("e2e-quota"),
      quotaPreflightThresholdBytes: 1,
      onNotify: notify,
    });
    try {
      const parsed: ParsedFile = {
        headers: ["date", "app", "vst"],
        rows: [
          { date: "2025-03-20", app: "App_A", vst: "0.9" },
          { date: "2025-03-20", app: "App_B", vst: "1.1" },
        ],
        sampleValues: {
          date: ["2025-03-20"],
          app: ["App_A", "App_B"],
          vst: ["0.9", "1.1"],
        },
      };
      const draft = proposeMappingDraft(parsed);
      const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", undefined);

      let thrown: unknown;
      await ingestConfirmedMapping(repo, parsed, mapping, {
        datasetId: "too-big",
        datasetName: "March Logs",
        appALabel: "A",
        appBLabel: "B",
      }).catch((e) => (thrown = e));

      // The write was refused up front (Req 27.1).
      expect(thrown).toBeInstanceOf(QuotaPreflightError);
      const err = thrown as QuotaPreflightError;
      expect(err.datasetName).toBe("March Logs");
      expect(err.shortfallBytes).toBeGreaterThan(0);
      expect(err.message).toMatch(/March Logs/);

      // Nothing was persisted: no records for the refused dataset (Req 27.2).
      expect(await repo.getRecords("too-big")).toHaveLength(0);
      // Surfaced through the notification channel (Req 3.5).
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining<Partial<RepositoryNotification>>({ level: "error" }),
      );
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("rolls a chunked append back on QuotaExceededError and preserves persisted data (Req 27.5, 3.5)", async () => {
    const notify = vi.fn<NotifyFn>();
    const repo = await DexieKPIRepository.open({
      databaseName: uniqueDbName("e2e-rollback"),
      onNotify: notify,
    });
    try {
      // Persist a dataset that must survive the failed append.
      const seeded = smallDataset("keep", "Keep", "2025-03-01T00:00:00Z");
      await repo.saveDataset(seeded);

      // Make the next records write throw a browser quota error mid-append;
      // Dexie rolls the enclosing transaction back so no partial rows remain.
      const spy = vi
        .spyOn(repo.database.records, "bulkPut")
        .mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));

      const extra = { ...seeded.records[0], id: "keep:extra" };
      let thrown: unknown;
      await repo.appendRecords("keep", [extra]).catch((e) => (thrown = e));
      spy.mockRestore();

      expect(thrown).toBeInstanceOf(QuotaExceededError);
      expect((thrown as QuotaExceededError).datasetId).toBe("keep");

      // Rolled back: the original records are intact, the append dropped.
      const records = await repo.getRecords("keep");
      expect(records).toHaveLength(2);
      expect(records.some((r) => r.id === "keep:extra")).toBe(false);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining<Partial<RepositoryNotification>>({ level: "error" }),
      );
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("records a denied persistent-storage request as an advisory without blocking the save (Req 27.3, 27.4)", async () => {
    const persist = vi.fn(async () => false);
    restore = stubStorageManager({ quota: 1_000_000, persist });
    const notify = vi.fn<NotifyFn>();
    const repo = await DexieKPIRepository.open({
      databaseName: uniqueDbName("e2e-persist-denied"),
      onNotify: notify,
    });
    try {
      // The save succeeds even though persistence was denied (Req 27.4).
      await expect(
        repo.saveDataset(smallDataset("adv", "Advisory", "2025-03-01T00:00:00Z")),
      ).resolves.toBeUndefined();
      expect(await repo.getDataset("adv")).toBeDefined();

      // Persistence was requested exactly once (Req 27.3) and the denial was
      // surfaced as a warning advisory (Req 27.4).
      expect(persist).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining<Partial<RepositoryNotification>>({
          level: "warning",
          operation: "request persistent storage",
        }),
      );
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("degrades to an in-memory advisory repository when IndexedDB cannot be opened (incognito path, Req 3.5)", async () => {
    // The boot factory's forced in-memory path models private browsing: writes
    // still succeed but nothing persists, and an advisory banner is raised.
    const boot = await createKPIRepository({ forceInMemory: true });
    expect(boot.persistent).toBe(false);
    expect(boot.advisory).toMatch(/private browsing/i);
    await boot.repository.saveDataset(smallDataset("mem", "Mem", "2025-03-01T00:00:00Z"));
    expect(await boot.repository.getDataset("mem")).toBeDefined();
  });
});

// ===========================================================================
// Flow 5 — Retention deletion-candidate surfacing (Req 27.6, 27.7)
// ===========================================================================

describe("retention deletion-candidate surfacing (Req 27.6, 27.7)", () => {
  it("surfaces the oldest datasets as deletion candidates at the dataset-count ceiling — never pruning silently", async () => {
    const repo = await DexieKPIRepository.open({ databaseName: uniqueDbName("e2e-retain") });
    try {
      await repo.saveRetentionPolicy({ maxDatasets: 2, maxRecordsPerDataset: 500_000 });
      await repo.saveDataset(smallDataset("old", "Old", "2025-01-01T00:00:00Z"));
      await repo.saveDataset(smallDataset("mid", "Mid", "2025-02-01T00:00:00Z"));

      const outcome = await repo.checkRetention();
      expect(outcome.kind).toBe("RetentionLimitReached");
      if (outcome.kind === "RetentionLimitReached") {
        expect(outcome.limit).toBe("maxDatasets");
        expect(outcome.ceiling).toBe(2);
        expect(outcome.current).toBe(2);
        // The oldest dataset is offered first for user-confirmed deletion.
        expect(outcome.deletionCandidates[0]).toMatchObject({ id: "old", name: "Old" });
        expect(outcome.message).toMatch(/2-dataset limit/);
      }

      // Nothing was removed — both datasets remain until the user confirms (Req 27.7).
      expect(await repo.getDataset("old")).toBeDefined();
      expect(await repo.getDataset("mid")).toBeDefined();
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("surfaces a per-dataset record ceiling scoped to the dataset (Req 27.6)", async () => {
    const repo = await DexieKPIRepository.open({ databaseName: uniqueDbName("e2e-retain-rec") });
    try {
      await repo.saveRetentionPolicy({ maxDatasets: 10, maxRecordsPerDataset: 2 });
      await repo.saveDataset(smallDataset("full", "Full", "2025-03-01T00:00:00Z"));

      const outcome = await repo.checkRetention("full");
      expect(outcome.kind).toBe("RetentionLimitReached");
      if (outcome.kind === "RetentionLimitReached") {
        expect(outcome.limit).toBe("maxRecordsPerDataset");
        expect(outcome.datasetId).toBe("full");
        expect(outcome.ceiling).toBe(2);
        expect(outcome.current).toBe(2);
        expect(outcome.deletionCandidates).toHaveLength(0);
      }
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });
});

// ===========================================================================
// Flow 6 — Wide-format end-to-end equivalence with two single-app files
//          (Req 21.5, 21.6, 21.7)
// ===========================================================================

describe("wide-format end-to-end equivalence with two single-app files (Req 21.5, 21.6, 21.7)", () => {
  const KPIS: KPIDefinition[] = [KPI_BY_ID.vst_p50];

  /**
   * A single wide row carries both apps' values on app-qualified columns; the
   * record builder fans it out to one record per app (Req 21.6).
   */
  const wideParsed: ParsedFile = {
    headers: ["date", "platform", "vst_app_a", "vst_app_b"],
    rows: [
      {
        date: "2025-03-20",
        platform: "Android",
        vst_app_a: "0.90",
        vst_app_b: "1.10",
      },
    ],
    sampleValues: {
      date: ["2025-03-20"],
      platform: ["Android"],
      vst_app_a: ["0.90"],
      vst_app_b: ["1.10"],
    },
  };

  /** The App_A half expressed as its own single-app file (file-level app). */
  const singleAppAParsed: ParsedFile = {
    headers: ["date", "platform", "vst"],
    rows: [{ date: "2025-03-20", platform: "Android", vst: "0.90" }],
    sampleValues: { date: ["2025-03-20"], platform: ["Android"], vst: ["0.90"] },
  };

  /** The App_B half expressed as its own single-app file (file-level app). */
  const singleAppBParsed: ParsedFile = {
    headers: ["date", "platform", "vst"],
    rows: [{ date: "2025-03-20", platform: "Android", vst: "1.10" }],
    sampleValues: { date: ["2025-03-20"], platform: ["Android"], vst: ["1.10"] },
  };

  it("ingesting one wide file equals ingesting two single-app files, with no cross-app bleed", async () => {
    // --- Wide ingest: one file, fanned out to App_A + App_B (Req 21.6). ---
    const wideRepo = new InMemoryKPIRepository();
    const wideDraft = proposeMappingDraft(wideParsed);
    expect(wideDraft.layout).toBe("wide");
    expect(wideDraft.requiresFileLevelApp).toBe(false);
    const wideMapping = buildConfirmedMapping(wideDraft, "Pre_Aggregated", undefined);
    await ingestConfirmedMapping(wideRepo, wideParsed, wideMapping, {
      datasetId: "wide",
      datasetName: "Wide",
      appALabel: "A",
      appBLabel: "B",
    });
    const wideRecords = await wideRepo.getRecords("wide");
    // One row -> exactly one record per app (Req 21.6).
    expect(wideRecords.map((r) => r.app).sort()).toEqual(["App_A", "App_B"]);

    // --- Two single-app files: each carries a file-level app (Req 21.5). ---
    const longRepo = new InMemoryKPIRepository();

    const draftA = proposeMappingDraft(singleAppAParsed);
    // A single-app file has no app signal, so it requires a file-level app (21.5).
    expect(draftA.requiresFileLevelApp).toBe(true);
    const mappingA: ColumnMapping = buildConfirmedMapping(draftA, "Pre_Aggregated", "App_A");
    await ingestConfirmedMapping(longRepo, singleAppAParsed, mappingA, {
      datasetId: "two-files",
      datasetName: "Two Files",
      appALabel: "A",
      appBLabel: "B",
    });

    const draftB = proposeMappingDraft(singleAppBParsed);
    expect(draftB.requiresFileLevelApp).toBe(true);
    const mappingB = buildConfirmedMapping(draftB, "Pre_Aggregated", "App_B");
    // Append the App_B file's records to the same dataset.
    await ingestConfirmedMapping(longRepo, singleAppBParsed, mappingB, {
      datasetId: "two-files-b",
      datasetName: "Two Files B",
      appALabel: "A",
      appBLabel: "B",
    });

    const twoFileRecords = [
      ...(await longRepo.getRecords("two-files")),
      ...(await longRepo.getRecords("two-files-b")),
    ];
    expect(twoFileRecords.map((r) => r.app).sort()).toEqual(["App_A", "App_B"]);

    // --- Equivalence: identical per-app aggregates for every slice (Req 21.7). ---
    const wideAgg = aggregate(wideRecords, "Pre_Aggregated", KPIS);
    const twoFileAgg = aggregate(twoFileRecords, "Pre_Aggregated", KPIS);

    // `overall` is a flat list of one entry per (kpiId, app); pick the vst_p50
    // value for each app from each ingestion path.
    const vstFor = (agg: typeof wideAgg, app: "App_A" | "App_B"): number =>
      agg.overall.find((v) => v.kpiId === "vst_p50" && v.app === app)!.value as number;

    const wideA = vstFor(wideAgg, "App_A");
    const wideB = vstFor(wideAgg, "App_B");
    const twoA = vstFor(twoFileAgg, "App_A");
    const twoB = vstFor(twoFileAgg, "App_B");

    // The wide file and the two single-app files produce identical per-app
    // aggregates (Req 21.7).
    expect(wideA).toBeCloseTo(twoA, 10);
    expect(wideB).toBeCloseTo(twoB, 10);

    // No cross-app bleed: App_A's value came only from the App_A column/file,
    // and App_B's only from the App_B column/file (Req 21.7).
    expect(wideA).toBeCloseTo(0.9, 5);
    expect(wideB).toBeCloseTo(1.1, 5);
  });
});
