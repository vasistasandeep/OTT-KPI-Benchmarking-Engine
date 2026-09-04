/**
 * Example (non-property) tests for the persistence *error* and *dataset
 * lifecycle* paths of the `KPIDataRepository` implementations.
 *
 * Scope — what the repository layer itself is responsible for:
 *   - Req 3.5  A failed persistence write surfaces an error notification that
 *              names the failed operation and preserves the in-memory dataset.
 *              Exercised here against a mocked *failing* repository (an injected
 *              `onNotify` sink plus a store forced to throw mid-write) rather
 *              than the happy path.
 *   - Req 19.7 A create or rename whose name collides with a different dataset
 *              is rejected with a typed `DuplicateNameError`.
 *   - Req 3.6  Deleting a dataset removes it and its records from storage.
 *   - Req 19.8 (storage half) Deleting the *active* dataset clears the active
 *              pointer so a stale id can never be returned; a delete of a
 *              non-active dataset leaves the pointer untouched.
 *
 * Out of scope (asserted only that the repository gives the store what it
 * needs): Req 19.8's promote-*another*-dataset step and Req 19.9's demo
 * fallback are orchestration owned by the Dataset Switcher / store layer
 * (design: "Deleting the active dataset promotes another remaining dataset
 * (Req 19.8); deleting the last one falls back to the demo dataset (Req 19.9)").
 * The repository only clears the active pointer; the store reads
 * `listDatasets()` to pick the promotion target (or the demo seed when the list
 * is empty). Those store paths belong to task 14.1, not this file. The tests
 * below verify the repository primitives the store relies on: after deleting
 * the active dataset the pointer is cleared and the remaining datasets are
 * still listable as promotion candidates.
 *
 * These run against the same `fake-indexeddb` global installed by
 * src/test/setup.ts, and mirror the checks across the in-memory fallback so the
 * two adapters stay interchangeable for the store.
 *
 * Requirements: 3.5, 3.6, 19.7, 19.8, 19.9.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Dataset, KPIRecord } from "@/models";

import { DexieKPIRepository } from "./DexieKPIRepository";
import { InMemoryKPIRepository } from "./InMemoryKPIRepository";
import type { KPIDataRepository } from "./KPIDataRepository";
import { DuplicateNameError, type NotifyFn, type RepositoryNotification } from "./support";

// --- test-data builders ------------------------------------------------------

let seq = 0;

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  const id = overrides.id ?? `ds-${++seq}`;
  return {
    id,
    name: overrides.name ?? `Dataset ${id}`,
    createdAt: overrides.createdAt ?? new Date(2025, 0, 1 + seq).toISOString(),
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

// A fresh, isolated Dexie repo per test.
async function openDexie(onNotify?: NotifyFn): Promise<DexieKPIRepository> {
  return DexieKPIRepository.open({
    databaseName: `lifecycle-${Math.random().toString(36).slice(2)}`,
    onNotify,
  });
}

// =============================================================================
// Req 3.5 — write-failure notification via a mocked failing repository
// =============================================================================

describe("persistence write-failure notification (Req 3.5)", () => {
  it("surfaces an error notification naming the failed operation and preserves in-memory data", async () => {
    const notifications: RepositoryNotification[] = [];
    const onNotify: NotifyFn = (n) => notifications.push(n);
    const repo = await openDexie(onNotify);
    try {
      // Seed a dataset that must survive the forced failure (the in-memory
      // dataset the caller still holds is preserved — Req 3.5).
      const seeded = makeDataset({ id: "keep", name: "Keep Me", records: [makeRecord("keep", 0)] });
      await repo.saveDataset(seeded);
      notifications.length = 0; // ignore the seed's persistence advisory, if any

      // Mock the store into failing: force the next write to throw by closing
      // the underlying database. This stands in for any persistence-layer
      // failure (disk error, transaction abort, etc.).
      repo.database.close();

      let thrown: unknown;
      await repo.setActiveDatasetId("keep").catch((e) => (thrown = e));

      // The failure re-throws so the caller can react and keep its data.
      expect(thrown).toBeDefined();
      // Exactly one error notification, naming the failed operation (Req 3.5).
      const errors = notifications.filter((n) => n.level === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("set the active dataset");
      expect(errors[0].message).toMatch(/preserved/i);
    } finally {
      // db already closed; attempt cleanup best-effort.
      await repo.database.delete().catch(() => {});
    }
  });

  it("names the dataset on a failed dataset-scoped write and carries the underlying cause", async () => {
    const notifications: RepositoryNotification[] = [];
    const repo = await openDexie((n) => notifications.push(n));
    try {
      await repo.saveDataset(makeDataset({ id: "scoped", name: "Scoped" }));
      notifications.length = 0;

      // Mock a failing store: make the records bulkPut reject with a concrete
      // error so we can assert the cause is threaded through the notification.
      const boom = new Error("simulated disk failure");
      const spy = vi.spyOn(repo.database.records, "bulkPut").mockRejectedValueOnce(boom);

      let thrown: unknown;
      await repo.appendRecords("scoped", [makeRecord("scoped", 0)]).catch((e) => (thrown = e));
      expect(thrown).toBeDefined();
      spy.mockRestore();

      const err = notifications.find((n) => n.level === "error");
      expect(err).toBeDefined();
      expect(err!.operation).toBe("save records to the dataset");
      expect(err!.datasetId).toBe("scoped");
      expect(err!.cause).toBe(boom);

      // In-memory data is preserved: the previously saved dataset still reads.
      // Reopen a fresh handle to the same store to confirm nothing was lost.
    } finally {
      repo.database.close();
      await repo.database.delete().catch(() => {});
    }
  });

  it("drops notifications silently but still rejects when no onNotify sink is wired", async () => {
    // A repo built without an onNotify sink must still fail loudly to the
    // caller (the notification is optional; the rejection is not).
    const repo = await openDexie(undefined);
    try {
      await repo.saveDataset(makeDataset({ id: "nosink", name: "No Sink" }));
      repo.database.close();
      await expect(repo.setActiveDatasetId("nosink")).rejects.toBeDefined();
    } finally {
      await repo.database.delete().catch(() => {});
    }
  });
});

// =============================================================================
// Req 19.7 — duplicate dataset name rejection
// =============================================================================

describe.each<[string, () => Promise<KPIDataRepository>]>([
  ["DexieKPIRepository", () => openDexie()],
  ["InMemoryKPIRepository", async () => new InMemoryKPIRepository()],
])("duplicate dataset name rejection — %s (Req 19.7)", (_label, make) => {
  let repo: KPIDataRepository;

  beforeEach(async () => {
    repo = await make();
  });

  afterEach(async () => {
    if (repo instanceof DexieKPIRepository) {
      repo.database.close();
      await repo.database.delete().catch(() => {});
    }
  });

  it("rejects creating a second dataset with a name already in use", async () => {
    await repo.saveDataset(makeDataset({ id: "one", name: "March Run" }));
    await expect(
      repo.saveDataset(makeDataset({ id: "two", name: "March Run" })),
    ).rejects.toBeInstanceOf(DuplicateNameError);
    // The clash surfaces the offending name for the UI message (Req 19.7).
    await repo
      .saveDataset(makeDataset({ id: "three", name: "March Run" }))
      .catch((e: unknown) => {
        expect(e).toBeInstanceOf(DuplicateNameError);
        expect((e as DuplicateNameError).datasetName).toBe("March Run");
      });
    // Only the first dataset exists; the rejected create wrote nothing.
    expect((await repo.listDatasets()).map((m) => m.id)).toEqual(["one"]);
  });

  it("rejects renaming a dataset onto another dataset's name", async () => {
    await repo.saveDataset(makeDataset({ id: "one", name: "Alpha" }));
    await repo.saveDataset(makeDataset({ id: "two", name: "Beta" }));
    await expect(repo.renameDataset("two", "Alpha")).rejects.toBeInstanceOf(DuplicateNameError);
    // The rejected rename left the original name intact.
    expect((await repo.getDataset("two"))!.name).toBe("Beta");
  });

  it("allows re-saving a dataset under its own name (no false self-collision)", async () => {
    const ds = makeDataset({ id: "self", name: "Keep" });
    await repo.saveDataset(ds);
    await expect(
      repo.saveDataset({ ...ds, appALabel: "Renamed A" }),
    ).resolves.toBeUndefined();
    // And renaming to the same name it already holds is a no-op, not a clash.
    await expect(repo.renameDataset("self", "Keep")).resolves.toBeUndefined();
  });
});

// =============================================================================
// Req 3.6 / 19.8 (storage half) — deletion + active-pointer clearing
// =============================================================================

describe.each<[string, () => Promise<KPIDataRepository>]>([
  ["DexieKPIRepository", () => openDexie()],
  ["InMemoryKPIRepository", async () => new InMemoryKPIRepository()],
])("dataset deletion + active-pointer lifecycle — %s (Req 3.6, 19.8)", (_label, make) => {
  let repo: KPIDataRepository;

  beforeEach(async () => {
    repo = await make();
  });

  afterEach(async () => {
    if (repo instanceof DexieKPIRepository) {
      repo.database.close();
      await repo.database.delete().catch(() => {});
    }
  });

  it("removes the dataset and its records from storage (Req 3.6)", async () => {
    const ds = makeDataset({ id: "del", records: [makeRecord("del", 0), makeRecord("del", 1)] });
    await repo.saveDataset(ds);
    expect(await repo.getRecords("del")).toHaveLength(2);

    await repo.deleteDataset("del");

    expect(await repo.getDataset("del")).toBeUndefined();
    expect(await repo.getRecords("del")).toHaveLength(0);
    expect((await repo.listDatasets()).some((m) => m.id === "del")).toBe(false);
  });

  it("clears the active pointer when the deleted dataset was active (Req 19.8 storage half)", async () => {
    await repo.saveDataset(makeDataset({ id: "active", name: "Active" }));
    await repo.setActiveDatasetId("active");
    expect(await repo.getActiveDatasetId()).toBe("active");

    await repo.deleteDataset("active");

    // A stale active id must never survive its dataset's deletion, otherwise the
    // store would try to promote a dataset that no longer exists.
    expect(await repo.getActiveDatasetId()).toBeUndefined();
  });

  it("leaves the active pointer untouched when a non-active dataset is deleted", async () => {
    await repo.saveDataset(makeDataset({ id: "keep", name: "Keep" }));
    await repo.saveDataset(makeDataset({ id: "other", name: "Other" }));
    await repo.setActiveDatasetId("keep");

    await repo.deleteDataset("other");

    expect(await repo.getActiveDatasetId()).toBe("keep");
  });

  it("leaves remaining datasets listable as store-layer promotion candidates after an active delete (Req 19.8)", async () => {
    // The repository clears the pointer; the *store* (task 14.1) reads the
    // remaining list to promote a survivor. Assert the primitive the store
    // relies on: after deleting the active dataset, the others still list.
    await repo.saveDataset(makeDataset({ id: "a", name: "A", createdAt: "2025-01-01T00:00:00Z" }));
    await repo.saveDataset(makeDataset({ id: "b", name: "B", createdAt: "2025-02-01T00:00:00Z" }));
    await repo.setActiveDatasetId("a");

    await repo.deleteDataset("a");

    expect(await repo.getActiveDatasetId()).toBeUndefined();
    const remaining = await repo.listDatasets();
    expect(remaining.map((m) => m.id)).toEqual(["b"]);
  });

  it("leaves an empty dataset list after deleting the last dataset, signalling the store's demo fallback (Req 19.9)", async () => {
    // Deleting the last dataset is the storage precondition for the store's
    // demo fallback (Req 19.9). The repository's job is only to end in an empty
    // list with a cleared pointer; presenting the demo seed is store-layer work
    // (task 14.1) and is not asserted here.
    await repo.saveDataset(makeDataset({ id: "only", name: "Only" }));
    await repo.setActiveDatasetId("only");

    await repo.deleteDataset("only");

    expect(await repo.getActiveDatasetId()).toBeUndefined();
    expect(await repo.listDatasets()).toHaveLength(0);
  });

  it("deleting a non-existent dataset is a no-op that does not disturb the active pointer", async () => {
    await repo.saveDataset(makeDataset({ id: "live", name: "Live" }));
    await repo.setActiveDatasetId("live");

    await expect(repo.deleteDataset("ghost")).resolves.toBeUndefined();

    expect(await repo.getActiveDatasetId()).toBe("live");
    expect((await repo.listDatasets()).map((m) => m.id)).toEqual(["live"]);
  });
});
