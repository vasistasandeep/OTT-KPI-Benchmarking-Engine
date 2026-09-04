/**
 * Private-browsing / incognito fallback tests for the boot factory.
 *
 * When IndexedDB cannot be opened — the way incognito / private-browsing modes
 * (and quota-denied environments) manifest — `createKPIRepository` must degrade
 * to the in-memory `Map` adapter (`InMemoryKPIRepository`) transparently: it
 * reports `persistent: false`, carries an advisory string the UI renders as a
 * banner, and still satisfies the full `KPIDataRepository` contract so every
 * consumer keeps working unchanged.
 *
 * These tests exercise that degraded path two ways — the explicit
 * `forceInMemory` switch and a real Dexie open rejection (stubbed
 * `DexieKPIRepository.open`) — and then round-trip dataset, record, and config
 * CRUD through the returned adapter to prove the fallback handles them all.
 *
 * Intentionally a distinct file: it does not touch DexieKPIRepository.test.ts
 * or the persistence property/lifecycle suites.
 *
 * Requirements: 3.5 (advisory / graceful degradation).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ColumnMapping, Dataset, KPIRecord, SLAConfig } from "@/models";

import { DexieKPIRepository } from "./DexieKPIRepository";
import { InMemoryKPIRepository } from "./InMemoryKPIRepository";
import { createKPIRepository } from "./createKPIRepository";
import type { KPIDataRepository } from "./KPIDataRepository";
import type { RepositoryBootResult } from "./createKPIRepository";

// --- test-data builders ------------------------------------------------------

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  const id = overrides.id ?? "ds-1";
  return {
    id,
    name: overrides.name ?? `Dataset ${id}`,
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
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
    dimensions: {
      platform: "web",
      network: "wifi",
      cdn: "akamai",
      geography: "IN",
      streamType: "VOD",
    },
    metrics: { vst_p95: 1200 + i },
  };
}

function makeMapping(): ColumnMapping {
  return {
    headerSetHash: "hash-incognito",
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

/**
 * Round-trip dataset, record, and config CRUD through a booted fallback
 * repository, asserting the in-memory adapter transparently handles each. Kept
 * as a shared helper so both the `forceInMemory` and the open-rejection paths
 * verify identical behavior.
 */
async function assertTransparentCrud(repo: KPIDataRepository): Promise<void> {
  // Dataset CRUD ------------------------------------------------------------
  const ds = makeDataset({ id: "mem", name: "Session Log", records: [makeRecord("mem", 0)] });
  await repo.saveDataset(ds);
  await repo.setActiveDatasetId("mem");

  const loaded = await repo.getDataset("mem");
  expect(loaded).toBeDefined();
  expect(loaded!.name).toBe("Session Log");
  expect(loaded!.records).toHaveLength(1);
  expect(await repo.getActiveDatasetId()).toBe("mem");
  expect((await repo.listDatasets()).map((m) => m.id)).toContain("mem");

  await repo.renameDataset("mem", "Renamed Log");
  expect((await repo.getDataset("mem"))!.name).toBe("Renamed Log");

  // Record CRUD -------------------------------------------------------------
  await repo.appendRecords("mem", [makeRecord("mem", 1), makeRecord("mem", 2)]);
  expect(await repo.getRecords("mem")).toHaveLength(3);
  expect((await repo.getDataset("mem"))!.recordCount).toBe(3);

  const edited: KPIRecord = { ...makeRecord("mem", 1), metrics: { vst_p95: 9999 } };
  await repo.updateRecord("mem", edited);
  const afterEdit = await repo.getRecords("mem");
  expect(afterEdit.find((r) => r.id === "mem-r1")!.metrics!.vst_p95).toBe(9999);

  await repo.deleteRecord("mem", "mem-r2");
  expect(await repo.getRecords("mem")).toHaveLength(2);

  // Config CRUD -------------------------------------------------------------
  const sla: SLAConfig = { varianceBand: 2.5, thresholds: { vst_p95: 1500 }, minSampleSize: 50 };
  await repo.saveSLAConfig(sla);
  expect(await repo.getSLAConfig()).toEqual(sla);

  const mapping = makeMapping();
  await repo.saveColumnMapping(mapping);
  expect(await repo.getColumnMapping("hash-incognito")).toEqual(mapping);
  expect(await repo.getColumnMapping("missing")).toBeUndefined();

  // Deleting the active dataset clears the active pointer and its records.
  await repo.deleteDataset("mem");
  expect(await repo.getDataset("mem")).toBeUndefined();
  expect(await repo.getRecords("mem")).toHaveLength(0);
  expect(await repo.getActiveDatasetId()).toBeUndefined();
}

/** Every degraded boot must be non-persistent, advisory-bearing, and in-memory. */
function expectDegradedBoot(boot: RepositoryBootResult): void {
  expect(boot.persistent).toBe(false);
  expect(boot.repository).toBeInstanceOf(InMemoryKPIRepository);
  // Advisory string is set so the UI can render the "won't persist" banner.
  expect(typeof boot.advisory).toBe("string");
  expect(boot.advisory).toMatch(/private browsing/i);
  expect(boot.advisory).toMatch(/not persist/i);
}

describe("createKPIRepository private-browsing fallback (Req 3.5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("degrades to the in-memory adapter with an advisory when forced, and handles CRUD transparently", async () => {
    const boot = await createKPIRepository({ forceInMemory: true });

    expectDegradedBoot(boot);
    await assertTransparentCrud(boot.repository);
  });

  it("catches an IndexedDB open failure, sets the advisory-banner state, and notifies", async () => {
    // Simulate IndexedDB refusing to open — the way incognito manifests.
    const openSpy = vi
      .spyOn(DexieKPIRepository, "open")
      .mockRejectedValue(new DOMException("open denied", "InvalidStateError"));
    const notify = vi.fn();

    const boot = await createKPIRepository({ onNotify: notify });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expectDegradedBoot(boot);
    // The degradation surfaced through the notification channel as a warning
    // so the UI can raise the advisory banner (Req 3.5).
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        operation: "open persistent storage",
        message: boot.advisory,
      }),
    );
  });

  it("transparently handles dataset, record, and config CRUD after an open failure", async () => {
    vi.spyOn(DexieKPIRepository, "open").mockRejectedValue(
      new DOMException("open denied", "InvalidStateError"),
    );

    const boot = await createKPIRepository();

    expectDegradedBoot(boot);
    // The full KPIDataRepository contract is satisfied by the fallback adapter.
    await assertTransparentCrud(boot.repository);
  });
});
