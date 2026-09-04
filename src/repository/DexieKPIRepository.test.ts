/**
 * Unit tests for the persistence layer, run against `fake-indexeddb` (installed
 * globally by src/test/setup.ts). They verify CRUD round-trips, chunked record
 * reads/writes, duplicate-name rejection on create and rename (Req 19.7), the
 * write-failure notification (Req 3.5), config/mapping round-trips (Req 14.2,
 * 7.6), dataset deletion (Req 3.6), and parity of the in-memory fallback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ColumnMapping, Dataset, KPIRecord, SLAConfig } from "@/models";

import { DexieKPIRepository, KPIDatabase } from "./DexieKPIRepository";
import { InMemoryKPIRepository } from "./InMemoryKPIRepository";
import { createKPIRepository } from "./createKPIRepository";
import type { KPIDataRepository } from "./KPIDataRepository";
import {
  DuplicateNameError,
  QuotaExceededError,
  QuotaPreflightError,
  RecordNotFoundError,
  estimateSerializedBytes,
  formatBytes,
  isQuotaExceeded,
  type NotifyFn,
} from "./support";

// --- test-data builders ------------------------------------------------------

let datasetSeq = 0;

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  const id = overrides.id ?? `ds-${++datasetSeq}`;
  return {
    id,
    name: overrides.name ?? `Dataset ${id}`,
    createdAt: overrides.createdAt ?? new Date(2025, 0, 1 + datasetSeq).toISOString(),
    appALabel: "App A",
    appBLabel: "App B",
    recordCount: 0,
    sourceType: "Aggregated",
    ingestionMode: "Pre_Aggregated",
    records: [],
    ...overrides,
  };
}

function makeRecord(datasetId: string, i: number): KPIRecord {
  return {
    id: `${datasetId}-r${i}`,
    datasetId,
    app: i % 2 === 0 ? "App_A" : "App_B",
    timestampUtc: "2025-03-14T09:00:00Z",
    sourceUtcOffsetMinutes: null,
    bucket: { hourUtc: "2025-03-14T09:00:00Z", dayUtc: "2025-03-14" },
    origin: "file",
    dimensions: { platform: "web", network: "wifi", cdn: "akamai", geography: "IN", streamType: "VOD" },
    metrics: { vst_p95: 1200 + i },
  };
}

function makeMapping(): ColumnMapping {
  return {
    headerSetHash: "hash-abc",
    headers: ["vst_ms", "app", "ts"],
    assignments: {
      vst_ms: { kind: "kpi", kpiId: "vst_p95" },
      app: { kind: "app" },
      ts: { kind: "timestamp" },
    },
    units: { vst_ms: "ms" },
    layout: "long",
    ingestionMode: "Pre_Aggregated",
  };
}

// --- Dexie-backed suite ------------------------------------------------------

describe("DexieKPIRepository", () => {
  let repo: DexieKPIRepository;
  let db: KPIDatabase;
  let notify: NotifyFn;

  beforeEach(async () => {
    notify = vi.fn();
    // Unique db name per test keeps fake-indexeddb state isolated.
    repo = await DexieKPIRepository.open({
      databaseName: `test-db-${Math.random().toString(36).slice(2)}`,
      onNotify: notify,
    });
    db = repo.database;
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it("round-trips a dataset with its records", async () => {
    const ds = makeDataset({ records: [makeRecord("ds-x", 0), makeRecord("ds-x", 1)], id: "ds-x" });
    await repo.saveDataset(ds);

    const loaded = await repo.getDataset("ds-x");
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe(ds.name);
    expect(loaded!.records).toHaveLength(2);
    expect(loaded!.recordCount).toBe(2);
  });

  it("lists datasets ordered by createdAt", async () => {
    await repo.saveDataset(makeDataset({ id: "a", createdAt: "2025-01-02T00:00:00Z" }));
    await repo.saveDataset(makeDataset({ id: "b", createdAt: "2025-01-01T00:00:00Z" }));
    const metas = await repo.listDatasets();
    expect(metas.map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("rejects a create with a duplicate name (Req 19.7)", async () => {
    await repo.saveDataset(makeDataset({ id: "one", name: "March Run" }));
    await expect(
      repo.saveDataset(makeDataset({ id: "two", name: "March Run" })),
    ).rejects.toBeInstanceOf(DuplicateNameError);
    // The write failure is surfaced as a notification (Req 3.5).
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
  });

  it("allows re-saving the same dataset id under its own name", async () => {
    const ds = makeDataset({ id: "same", name: "Keep" });
    await repo.saveDataset(ds);
    await expect(repo.saveDataset({ ...ds, appALabel: "Renamed A" })).resolves.toBeUndefined();
  });

  it("rejects a rename that collides with another dataset (Req 19.7)", async () => {
    await repo.saveDataset(makeDataset({ id: "one", name: "Alpha" }));
    await repo.saveDataset(makeDataset({ id: "two", name: "Beta" }));
    await expect(repo.renameDataset("two", "Alpha")).rejects.toBeInstanceOf(DuplicateNameError);
  });

  it("renames a dataset to a free name", async () => {
    await repo.saveDataset(makeDataset({ id: "one", name: "Alpha" }));
    await repo.renameDataset("one", "Gamma");
    expect((await repo.getDataset("one"))!.name).toBe("Gamma");
  });

  it("deletes a dataset and its records, clearing the active pointer (Req 3.6)", async () => {
    const ds = makeDataset({ id: "del", records: [makeRecord("del", 0)] });
    await repo.saveDataset(ds);
    await repo.setActiveDatasetId("del");

    await repo.deleteDataset("del");

    expect(await repo.getDataset("del")).toBeUndefined();
    expect(await repo.getRecords("del")).toHaveLength(0);
    expect(await repo.getActiveDatasetId()).toBeUndefined();
  });

  it("appends records across multiple chunks and updates the record count (Req 3.2)", async () => {
    // A tiny chunk size forces the keyset-paginated write/read loops to run
    // several iterations without needing a huge (and slow) fixture.
    const chunked = await DexieKPIRepository.open({
      databaseName: `chunk-${Math.random().toString(36).slice(2)}`,
      recordChunkSize: 3,
    });
    try {
      await chunked.saveDataset(makeDataset({ id: "big" }));
      const records = Array.from({ length: 20 }, (_, i) => makeRecord("big", i));
      await chunked.appendRecords("big", records);

      const read = await chunked.getRecords("big");
      expect(read).toHaveLength(20);
      // Every appended id is present exactly once (paging did not skip/duplicate).
      expect(new Set(read.map((r) => r.id)).size).toBe(20);
      expect((await chunked.getDataset("big"))!.recordCount).toBe(20);
    } finally {
      chunked.database.close();
      await chunked.database.delete();
    }
  });

  it("updates and deletes a single record, guarding wrong-dataset access", async () => {
    const ds = makeDataset({ id: "man", records: [makeRecord("man", 0), makeRecord("man", 1)] });
    await repo.saveDataset(ds);

    const edited: KPIRecord = { ...makeRecord("man", 0), metrics: { vst_p95: 9999 } };
    await repo.updateRecord("man", edited);
    const after = await repo.getRecords("man");
    expect(after.find((r) => r.id === "man-r0")!.metrics!.vst_p95).toBe(9999);

    await expect(repo.updateRecord("other", edited)).rejects.toBeInstanceOf(RecordNotFoundError);

    await repo.deleteRecord("man", "man-r1");
    expect(await repo.getRecords("man")).toHaveLength(1);
    expect((await repo.getDataset("man"))!.recordCount).toBe(1);
  });

  it("round-trips SLA config, defaulting when none saved (Req 14.2)", async () => {
    const def = await repo.getSLAConfig();
    expect(def.varianceBand).toBe(1.5);
    expect(def.minSampleSize).toBe(100);

    const cfg: SLAConfig = { varianceBand: 2.5, thresholds: { vst_p95: 1500 }, minSampleSize: 50 };
    await repo.saveSLAConfig(cfg);
    expect(await repo.getSLAConfig()).toEqual(cfg);
  });

  it("round-trips a column mapping keyed by header-set hash (Req 7.6)", async () => {
    const mapping = makeMapping();
    await repo.saveColumnMapping(mapping);
    expect(await repo.getColumnMapping("hash-abc")).toEqual(mapping);
    expect(await repo.getColumnMapping("missing")).toBeUndefined();
  });

  it("round-trips the retention policy, defaulting when none saved", async () => {
    const def = await repo.getRetentionPolicy();
    expect(def).toEqual({ maxDatasets: 10, maxRecordsPerDataset: 500_000 });
    await repo.saveRetentionPolicy({ maxDatasets: 3, maxRecordsPerDataset: 100 });
    expect(await repo.getRetentionPolicy()).toEqual({ maxDatasets: 3, maxRecordsPerDataset: 100 });
  });

  it("notifies and preserves state when a write fails (Req 3.5)", async () => {
    const ds = makeDataset({ id: "keep", name: "Keep Me", records: [makeRecord("keep", 0)] });
    await repo.saveDataset(ds);

    // Force the next write to throw by closing the underlying db.
    db.close();
    await expect(repo.setActiveDatasetId("keep")).rejects.toBeDefined();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", operation: "set the active dataset" }),
    );
  });
});

// --- shared behavior across both implementations -----------------------------

describe.each<[string, () => Promise<KPIDataRepository>]>([
  [
    "DexieKPIRepository",
    async () =>
      DexieKPIRepository.open({ databaseName: `shared-${Math.random().toString(36).slice(2)}` }),
  ],
  ["InMemoryKPIRepository", async () => new InMemoryKPIRepository()],
])("%s CRUD parity", (_label, make) => {
  let repo: KPIDataRepository;

  beforeEach(async () => {
    repo = await make();
  });

  it("round-trips a dataset, records, active id, and rejects duplicate names", async () => {
    const ds = makeDataset({ id: "p1", name: "Parity", records: [makeRecord("p1", 0)] });
    await repo.saveDataset(ds);
    await repo.appendRecords("p1", [makeRecord("p1", 1)]);
    await repo.setActiveDatasetId("p1");

    expect((await repo.getRecords("p1")).length).toBe(2);
    expect(await repo.getActiveDatasetId()).toBe("p1");

    await expect(
      repo.saveDataset(makeDataset({ id: "p2", name: "Parity" })),
    ).rejects.toBeInstanceOf(DuplicateNameError);
  });
});

// --- boot factory / incognito fallback --------------------------------------

describe("createKPIRepository", () => {
  it("returns a persistent Dexie-backed repository by default", async () => {
    const boot = await createKPIRepository({
      databaseName: `boot-${Math.random().toString(36).slice(2)}`,
    });
    expect(boot.persistent).toBe(true);
    expect(boot.repository).toBeInstanceOf(DexieKPIRepository);
    (boot.repository as DexieKPIRepository).database.close();
  });

  it("degrades to in-memory storage with an advisory when forced (incognito path)", async () => {
    const boot = await createKPIRepository({ forceInMemory: true });
    expect(boot.persistent).toBe(false);
    expect(boot.repository).toBeInstanceOf(InMemoryKPIRepository);
    expect(boot.advisory).toMatch(/private browsing/i);
    // The fallback still implements the full interface.
    await boot.repository.saveDataset(makeDataset({ id: "mem", name: "Mem" }));
    expect(await boot.repository.getDataset("mem")).toBeDefined();
  });
});

// --- quota / persistence / retention guard (task 4.3, Req 27.1–27.7) ---------

/**
 * Install a fake `navigator.storage` with the given estimate + persist behavior
 * and return a restore function. jsdom has no StorageManager, so we define one.
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

describe("support helpers", () => {
  it("estimateSerializedBytes counts UTF-16 bytes and never throws on cycles", () => {
    expect(estimateSerializedBytes("ab")).toBe(JSON.stringify("ab").length * 2);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateSerializedBytes(cyclic)).toBe(0);
  });

  it("formatBytes renders compact human-readable sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("isQuotaExceeded recognizes quota errors and their cause chain", () => {
    expect(isQuotaExceeded(new DOMException("full", "QuotaExceededError"))).toBe(true);
    const wrapped = new Error("write failed");
    (wrapped as { cause?: unknown }).cause = new DOMException("full", "QuotaExceededError");
    expect(isQuotaExceeded(wrapped)).toBe(true);
    expect(isQuotaExceeded(new Error("something else"))).toBe(false);
  });
});

describe("DexieKPIRepository quota pre-flight (Req 27.1, 27.2)", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("refuses a large write projected to exceed remaining quota, naming the dataset + shortfall, writing nothing", async () => {
    // Almost-full store: 10 bytes free. A tiny threshold forces the pre-flight.
    restore = stubStorageManager({ usage: 990, quota: 1000 });
    const notify = vi.fn();
    const repo = await DexieKPIRepository.open({
      databaseName: `q-${Math.random().toString(36).slice(2)}`,
      quotaPreflightThresholdBytes: 1, // any non-empty payload triggers the check
      onNotify: notify,
    });
    try {
      const ds = makeDataset({ id: "big", name: "March Logs", records: [makeRecord("big", 0)] });
      let thrown: unknown;
      await repo.saveDataset(ds).catch((e) => (thrown = e));
      expect(thrown).toBeInstanceOf(QuotaPreflightError);
      const err = thrown as QuotaPreflightError;
      expect(err.datasetName).toBe("March Logs");
      expect(err.shortfallBytes).toBeGreaterThan(0);
      expect(err.message).toMatch(/March Logs/);
      // Nothing was persisted (Req 27.2).
      expect(await repo.getDataset("big")).toBeUndefined();
      // The failure was surfaced as a notification (Req 3.5).
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("allows a large write that fits within remaining quota", async () => {
    restore = stubStorageManager({ usage: 0, quota: 1_000_000 });
    const repo = await DexieKPIRepository.open({
      databaseName: `q-${Math.random().toString(36).slice(2)}`,
      quotaPreflightThresholdBytes: 1,
    });
    try {
      const ds = makeDataset({ id: "ok", name: "Fits", records: [makeRecord("ok", 0)] });
      await expect(repo.saveDataset(ds)).resolves.toBeUndefined();
      expect(await repo.getDataset("ok")).toBeDefined();
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("skips the pre-flight for writes below the threshold", async () => {
    // Report an impossible full store; a sub-threshold write must NOT be refused.
    restore = stubStorageManager({ usage: 1000, quota: 1000 });
    const repo = await DexieKPIRepository.open({
      databaseName: `q-${Math.random().toString(36).slice(2)}`,
      quotaPreflightThresholdBytes: 10 * 1024 * 1024, // default 10 MB; tiny fixture is under it
    });
    try {
      const ds = makeDataset({ id: "small", name: "Small", records: [makeRecord("small", 0)] });
      await expect(repo.saveDataset(ds)).resolves.toBeUndefined();
      expect(await repo.getDataset("small")).toBeDefined();
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("degrades to a no-op when StorageManager reports an unknown quota", async () => {
    restore = stubStorageManager({ usage: 0, quota: 0 }); // unsupported -> zeroed
    const repo = await DexieKPIRepository.open({
      databaseName: `q-${Math.random().toString(36).slice(2)}`,
      quotaPreflightThresholdBytes: 1,
    });
    try {
      const ds = makeDataset({ id: "nq", name: "NoQuota", records: [makeRecord("nq", 0)] });
      await expect(repo.saveDataset(ds)).resolves.toBeUndefined();
      expect(await repo.getDataset("nq")).toBeDefined();
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });
});

describe("DexieKPIRepository QuotaExceededError rollback (Req 27.5, 3.5)", () => {
  it("rolls the whole append back and preserves persisted data on QuotaExceededError", async () => {
    const notify = vi.fn();
    const repo = await DexieKPIRepository.open({
      databaseName: `qe-${Math.random().toString(36).slice(2)}`,
      onNotify: notify,
    });
    try {
      // Seed a dataset that must survive the failed append (persisted data).
      const seeded = makeDataset({ id: "keep", name: "Keep", records: [makeRecord("keep", 0)] });
      await repo.saveDataset(seeded);

      // Make the next records bulkPut throw a quota error; Dexie rolls the
      // enclosing transaction back so no partial rows remain.
      const db = repo.database;
      const spy = vi
        .spyOn(db.records, "bulkPut")
        .mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));

      let thrown: unknown;
      await repo
        .appendRecords("keep", [makeRecord("keep", 1), makeRecord("keep", 2)])
        .catch((e) => (thrown = e));

      expect(thrown).toBeInstanceOf(QuotaExceededError);
      expect((thrown as QuotaExceededError).datasetId).toBe("keep");
      spy.mockRestore();

      // Rolled back: the original single record is intact, the append dropped.
      const records = await repo.getRecords("keep");
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("keep-r0");
      // The failure surfaced as a notification (Req 3.5).
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });
});

describe("DexieKPIRepository persistent-storage request (Req 27.3, 27.4)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("requests persistence exactly once across multiple saves", async () => {
    const persist = vi.fn(async () => true);
    restore = stubStorageManager({ quota: 1_000_000, persist });
    const repo = await DexieKPIRepository.open({
      databaseName: `p-${Math.random().toString(36).slice(2)}`,
    });
    try {
      await repo.saveDataset(makeDataset({ id: "one", name: "One" }));
      await repo.saveDataset(makeDataset({ id: "two", name: "Two" }));
      await repo.appendRecords("one", [makeRecord("one", 5)]);
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("records a denied persistence request as an advisory without blocking the save (Req 27.4)", async () => {
    const notify = vi.fn();
    restore = stubStorageManager({ quota: 1_000_000, persist: async () => false });
    const repo = await DexieKPIRepository.open({
      databaseName: `p-${Math.random().toString(36).slice(2)}`,
      onNotify: notify,
    });
    try {
      await expect(
        repo.saveDataset(makeDataset({ id: "adv", name: "Advisory" })),
      ).resolves.toBeUndefined();
      expect(await repo.getDataset("adv")).toBeDefined();
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ level: "warning", operation: "request persistent storage" }),
      );
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });
});

describe("DexieKPIRepository retention guard (Req 27.6, 27.7)", () => {
  it("returns ok while under both ceilings", async () => {
    const repo = await DexieKPIRepository.open({
      databaseName: `r-${Math.random().toString(36).slice(2)}`,
    });
    try {
      await repo.saveRetentionPolicy({ maxDatasets: 5, maxRecordsPerDataset: 100 });
      await repo.saveDataset(makeDataset({ id: "a", name: "A" }));
      expect(await repo.checkRetention()).toEqual({ kind: "ok" });
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("returns RetentionLimitReached with oldest deletion candidates at the dataset-count ceiling — never prunes silently", async () => {
    const repo = await DexieKPIRepository.open({
      databaseName: `r-${Math.random().toString(36).slice(2)}`,
    });
    try {
      await repo.saveRetentionPolicy({ maxDatasets: 2, maxRecordsPerDataset: 500_000 });
      await repo.saveDataset(makeDataset({ id: "old", name: "Old", createdAt: "2025-01-01T00:00:00Z" }));
      await repo.saveDataset(makeDataset({ id: "mid", name: "Mid", createdAt: "2025-02-01T00:00:00Z" }));

      const outcome = await repo.checkRetention();
      expect(outcome.kind).toBe("RetentionLimitReached");
      if (outcome.kind === "RetentionLimitReached") {
        expect(outcome.limit).toBe("maxDatasets");
        expect(outcome.ceiling).toBe(2);
        expect(outcome.current).toBe(2);
        // The oldest dataset is offered for user-confirmed deletion.
        expect(outcome.deletionCandidates[0]).toMatchObject({ id: "old", name: "Old" });
        expect(outcome.message).toMatch(/2-dataset limit/);
      }
      // Nothing was pruned: both datasets remain (Req 27.7).
      expect(await repo.getDataset("old")).toBeDefined();
      expect(await repo.getDataset("mid")).toBeDefined();
    } finally {
      repo.database.close();
      await repo.database.delete();
    }
  });

  it("returns RetentionLimitReached scoped to a dataset at the per-dataset record ceiling", async () => {
    const repo = await DexieKPIRepository.open({
      databaseName: `r-${Math.random().toString(36).slice(2)}`,
    });
    try {
      await repo.saveRetentionPolicy({ maxDatasets: 10, maxRecordsPerDataset: 2 });
      await repo.saveDataset(
        makeDataset({ id: "full", name: "Full", records: [makeRecord("full", 0), makeRecord("full", 1)] }),
      );

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

describe("InMemoryKPIRepository retention parity (Req 27.6, 27.7)", () => {
  it("mirrors the dataset-count ceiling outcome", async () => {
    const repo = new InMemoryKPIRepository();
    await repo.saveRetentionPolicy({ maxDatasets: 1, maxRecordsPerDataset: 500_000 });
    await repo.saveDataset(makeDataset({ id: "solo", name: "Solo", createdAt: "2025-01-01T00:00:00Z" }));
    const outcome = await repo.checkRetention();
    expect(outcome.kind).toBe("RetentionLimitReached");
    if (outcome.kind === "RetentionLimitReached") {
      expect(outcome.limit).toBe("maxDatasets");
      expect(outcome.deletionCandidates[0]).toMatchObject({ id: "solo" });
    }
  });
});
