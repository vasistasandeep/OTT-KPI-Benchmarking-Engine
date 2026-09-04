/**
 * IndexedDB-backed implementation of `KPIDataRepository`, built on Dexie.
 *
 * Schema (Req 3.2):
 *   - `datasets`   — one row of `DatasetMeta` per stored dataset, keyed by `id`.
 *   - `records`    — one row per `KPIRecord`, keyed by `id` and indexed by
 *                    `datasetId` so a dataset's records can be range-scanned and
 *                    read/written in chunks to support large session logs.
 *   - `slaConfig`  — a single-row table (fixed key) holding the `SLAConfig`.
 *   - `mappings`   — `ColumnMapping` rows keyed by `headerSetHash` (Req 7.6).
 *   - `retention`  — a single-row table (fixed key) holding the `RetentionPolicy`.
 *   - `appState`   — a single-row table (fixed key) holding cross-cutting state
 *                    such as the active dataset id.
 *
 * Every write is wrapped so a failure surfaces a notification through the
 * injected `onNotify` sink while the in-memory dataset is preserved (Req 3.5).
 * Reads and writes of a dataset's records are chunked (Req 3.2).
 *
 * Storage quota / persistence / retention guard (task 4.3, Req 27.1–27.7):
 *   - large writes (payload above `QUOTA_PREFLIGHT_THRESHOLD_BYTES`) run a
 *     `navigator.storage.estimate()` pre-flight and are refused up front with a
 *     `QuotaPreflightError` naming the dataset and the shortfall — nothing is
 *     written (Req 27.1, 27.2);
 *   - the first successful dataset save requests persistent storage exactly
 *     once via `requestPersistentStorage()`; a `false` result is recorded and
 *     surfaced as an advisory but never blocks ingestion (Req 27.3, 27.4);
 *   - a `QuotaExceededError` raised mid-write rolls the whole chunked append
 *     back inside one Dexie transaction, preserving persisted and in-memory
 *     data, and surfaces a notification naming the dataset (Req 27.5, 3.5);
 *   - `checkRetention` returns a `RetentionLimitReached` outcome (never prunes
 *     silently) when a ceiling is reached (Req 27.6, 27.7).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 7.6, 14.2, 19.7, 27.1–27.7.
 */

import Dexie, { type Table } from "dexie";

import type {
  ColumnMapping,
  Dataset,
  DatasetMeta,
  KPIRecord,
  QuotaEstimate,
  RetentionPolicy,
  SLAConfig,
} from "@/models";

import type { KPIDataRepository } from "./KPIDataRepository";
import {
  DEFAULT_RETENTION_POLICY,
  DEFAULT_SLA_CONFIG,
  DuplicateNameError,
  QUOTA_PREFLIGHT_THRESHOLD_BYTES,
  QuotaExceededError,
  QuotaPreflightError,
  RECORD_CHUNK_SIZE,
  RecordNotFoundError,
  estimateSerializedBytes,
  isQuotaExceeded,
  type NotifyFn,
  type RepositoryOptions,
  type RetentionCheckOutcome,
} from "./support";

/** Fixed primary key for the single-row configuration tables. */
const SINGLETON_KEY = "singleton" as const;

/** Row wrapper for a single-row table so we can key it deterministically. */
interface SingletonRow<T> {
  key: typeof SINGLETON_KEY;
  value: T;
}

/** Key under which the active dataset id lives in the `appState` table. */
const ACTIVE_DATASET_KEY = "activeDatasetId" as const;

interface AppStateRow {
  key: string;
  value: unknown;
}

/**
 * The Dexie database. Declared as its own class so the table typings are
 * available to the repository methods.
 */
export class KPIDatabase extends Dexie {
  datasets!: Table<DatasetMeta, string>;
  records!: Table<KPIRecord, string>;
  slaConfig!: Table<SingletonRow<SLAConfig>, string>;
  mappings!: Table<ColumnMapping, string>;
  retention!: Table<SingletonRow<RetentionPolicy>, string>;
  appState!: Table<AppStateRow, string>;

  constructor(name = "ott-kpi-benchmarking-engine") {
    super(name);
    this.version(1).stores({
      // Primary key first; `&` marks a unique index on the dataset name so a
      // duplicate-name insert fails at the storage layer as a second guard.
      datasets: "id, &name, createdAt",
      // Records keyed by id, indexed by datasetId for range scans, plus a
      // compound [datasetId+id] index for efficient keyset-paginated chunking.
      records: "id, datasetId, [datasetId+id]",
      slaConfig: "key",
      mappings: "headerSetHash",
      retention: "key",
      appState: "key",
    });
  }
}

export class DexieKPIRepository implements KPIDataRepository {
  private readonly db: KPIDatabase;
  private readonly notify?: NotifyFn;
  private readonly chunkSize: number;
  private readonly quotaPreflightThresholdBytes: number;
  /**
   * Guards the one-time persistent-storage request (Req 27.3). Set the first
   * time a dataset is persisted so `requestPersistentStorage()` runs at most
   * once per repository instance.
   */
  private persistRequested = false;

  constructor(db: KPIDatabase, options: RepositoryOptions = {}) {
    this.db = db;
    this.notify = options.onNotify;
    this.chunkSize = options.recordChunkSize ?? RECORD_CHUNK_SIZE;
    this.quotaPreflightThresholdBytes =
      options.quotaPreflightThresholdBytes ?? QUOTA_PREFLIGHT_THRESHOLD_BYTES;
  }

  /**
   * Open a database and return a ready repository. Kept separate from the
   * constructor so callers can await the IndexedDB open and catch open/quota
   * exceptions (used by the boot factory to fall back to in-memory storage).
   */
  static async open(
    options: RepositoryOptions & { databaseName?: string } = {},
  ): Promise<DexieKPIRepository> {
    const db = new KPIDatabase(options.databaseName);
    await db.open();
    return new DexieKPIRepository(db, options);
  }

  /** Expose the underlying database (primarily for tests / teardown). */
  get database(): KPIDatabase {
    return this.db;
  }

  // ---------------------------------------------------------------------------
  // Write wrapper (Req 3.5)
  // ---------------------------------------------------------------------------

  /**
   * Run a write, and on failure surface a notification naming the operation
   * while re-throwing so the caller keeps its in-memory dataset and can react.
   * The persisted store is never left partially written because callers that
   * touch multiple rows do so inside a Dexie transaction.
   */
  private async write<T>(
    operation: string,
    fn: () => Promise<T>,
    datasetId?: string,
  ): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      this.notify?.({
        level: "error",
        operation,
        datasetId,
        message: `Failed to ${operation}. Your current data has been preserved; please retry.`,
        cause,
      });
      throw cause;
    }
  }

  // ---------------------------------------------------------------------------
  // Datasets
  // ---------------------------------------------------------------------------

  async listDatasets(): Promise<DatasetMeta[]> {
    return this.db.datasets.orderBy("createdAt").toArray();
  }

  async getDataset(id: string): Promise<Dataset | undefined> {
    const meta = await this.db.datasets.get(id);
    if (!meta) return undefined;
    const records = await this.getRecords(id);
    return { ...meta, records };
  }

  async saveDataset(dataset: Dataset): Promise<void> {
    const { records, ...meta } = dataset;
    // Pre-flight the storage quota for large saves; refused up front, nothing
    // written (Req 27.1, 27.2). `dataset` is the full serialized payload here.
    await this.quotaPreflight(meta.name, dataset);
    await this.write(
      "save the dataset",
      () =>
        this.runWriteWithQuotaRollback(meta.id, () =>
          this.db.transaction("rw", this.db.datasets, this.db.records, async () => {
            // Reject a create/rename that collides with a different dataset's name.
            const clash = await this.db.datasets.where("name").equals(meta.name).first();
            if (clash && clash.id !== meta.id) {
              throw new DuplicateNameError(meta.name);
            }
            await this.db.datasets.put({ ...meta, recordCount: records.length });
            // Replace this dataset's records wholesale, chunked for large logs.
            await this.db.records.where("datasetId").equals(meta.id).delete();
            await this.putRecordsChunked(records);
          }),
        ),
      dataset.id,
    );
    // First successful persist: request persistent storage exactly once (Req 27.3).
    await this.maybeRequestPersistence();
  }

  async renameDataset(id: string, name: string): Promise<void> {
    await this.write(
      "rename the dataset",
      () =>
        this.db.transaction("rw", this.db.datasets, async () => {
          const target = await this.db.datasets.get(id);
          if (!target) throw new RecordNotFoundError(id, id);
          const clash = await this.db.datasets.where("name").equals(name).first();
          if (clash && clash.id !== id) {
            throw new DuplicateNameError(name);
          }
          await this.db.datasets.update(id, { name });
        }),
      id,
    );
  }

  async deleteDataset(id: string): Promise<void> {
    await this.write(
      "delete the dataset",
      () =>
        this.db.transaction("rw", this.db.datasets, this.db.records, this.db.appState, async () => {
          await this.db.records.where("datasetId").equals(id).delete();
          await this.db.datasets.delete(id);
          // Clear the active pointer if it referenced the deleted dataset.
          const active = await this.db.appState.get(ACTIVE_DATASET_KEY);
          if (active?.value === id) {
            await this.db.appState.delete(ACTIVE_DATASET_KEY);
          }
        }),
      id,
    );
  }

  async getActiveDatasetId(): Promise<string | undefined> {
    const row = await this.db.appState.get(ACTIVE_DATASET_KEY);
    return (row?.value as string | undefined) ?? undefined;
  }

  async setActiveDatasetId(id: string): Promise<void> {
    await this.write("set the active dataset", () =>
      this.db.appState.put({ key: ACTIVE_DATASET_KEY, value: id }),
    );
  }

  // ---------------------------------------------------------------------------
  // Records (chunked — Req 3.2)
  // ---------------------------------------------------------------------------

  async appendRecords(datasetId: string, records: KPIRecord[]): Promise<void> {
    if (records.length === 0) return;
    // Pre-flight the storage quota for large appends; refused up front with a
    // QuotaPreflightError naming the dataset + shortfall, nothing written
    // (Req 27.1, 27.2). Use the dataset's display name for the message.
    const preflightName = (await this.db.datasets.get(datasetId))?.name ?? datasetId;
    await this.quotaPreflight(preflightName, records);
    await this.write(
      "save records to the dataset",
      () =>
        // A single transaction so a mid-write failure — including a
        // QuotaExceededError — rolls the whole chunked append back, leaving the
        // persisted and in-memory datasets intact (Req 27.5, 3.5).
        this.runWriteWithQuotaRollback(datasetId, () =>
          this.db.transaction("rw", this.db.datasets, this.db.records, async () => {
            await this.putRecordsChunked(records);
            const meta = await this.db.datasets.get(datasetId);
            if (meta) {
              const count = await this.db.records.where("datasetId").equals(datasetId).count();
              await this.db.datasets.update(datasetId, { recordCount: count });
            }
          }),
        ),
      datasetId,
    );
    await this.maybeRequestPersistence();
  }

  async getRecords(datasetId: string): Promise<KPIRecord[]> {
    // Read in chunks so a very large log is never materialized in one Dexie
    // call. Pages forward with keyset pagination over the [datasetId+id]
    // compound index (each page starts after the last-seen id), which stays
    // cheap for large logs where offset-based paging would re-scan (Req 3.2).
    const out: KPIRecord[] = [];
    let lowerId: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const range =
        lowerId === undefined
          ? this.db.records
              .where("[datasetId+id]")
              .between([datasetId, Dexie.minKey], [datasetId, Dexie.maxKey])
          : this.db.records
              .where("[datasetId+id]")
              .between([datasetId, lowerId], [datasetId, Dexie.maxKey], false, true);
      const chunk = await range.limit(this.chunkSize).toArray();
      if (chunk.length === 0) break;
      out.push(...chunk);
      lowerId = chunk[chunk.length - 1].id;
      if (chunk.length < this.chunkSize) break;
    }
    return out;
  }

  async updateRecord(datasetId: string, record: KPIRecord): Promise<void> {
    await this.write(
      "update the record",
      () =>
        this.db.transaction("rw", this.db.records, async () => {
          const existing = await this.db.records.get(record.id);
          if (!existing || existing.datasetId !== datasetId) {
            throw new RecordNotFoundError(record.id, datasetId);
          }
          await this.db.records.put({ ...record, datasetId });
        }),
      datasetId,
    );
  }

  async deleteRecord(datasetId: string, recordId: string): Promise<void> {
    await this.write(
      "delete the record",
      () =>
        this.db.transaction("rw", this.db.datasets, this.db.records, async () => {
          const existing = await this.db.records.get(recordId);
          if (!existing || existing.datasetId !== datasetId) {
            throw new RecordNotFoundError(recordId, datasetId);
          }
          await this.db.records.delete(recordId);
          const count = await this.db.records.where("datasetId").equals(datasetId).count();
          await this.db.datasets.update(datasetId, { recordCount: count });
        }),
      datasetId,
    );
  }

  /** Write records in fixed-size chunks (Req 3.2). Caller supplies the transaction. */
  private async putRecordsChunked(records: KPIRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += this.chunkSize) {
      const chunk = records.slice(i, i + this.chunkSize);
      await this.db.records.bulkPut(chunk);
    }
  }

  // ---------------------------------------------------------------------------
  // Storage capacity and retention (Req 27.1–27.7)
  // ---------------------------------------------------------------------------

  /**
   * Snapshot the browser's storage capacity via the StorageManager (Req 27.1).
   * When `StorageManager` is unavailable (older browsers, some test runtimes)
   * this degrades to zeroed values so the pre-flight becomes a no-op and writes
   * fall back to reactive `QuotaExceededError` handling (design note).
   */
  async estimateQuota(): Promise<QuotaEstimate> {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const persisted = (await navigator.storage.persisted?.()) ?? false;
      return {
        usageBytes: est.usage ?? 0,
        quotaBytes: est.quota ?? 0,
        persisted,
      };
    }
    // StorageManager unsupported: pre-flight degrades to a no-op (design note).
    return { usageBytes: 0, quotaBytes: 0, persisted: false };
  }

  /**
   * Request persistent storage from the browser (Req 27.3). Returns the
   * granted state; `false` when denied or unsupported (Req 27.4). This is the
   * raw capability call — the once-per-instance gating lives in
   * `maybeRequestPersistence`, which callers invoke after a successful save.
   */
  async requestPersistentStorage(): Promise<boolean> {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      try {
        return await navigator.storage.persist();
      } catch {
        return false;
      }
    }
    return false;
  }

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const row = await this.db.retention.get(SINGLETON_KEY);
    return row?.value ?? { ...DEFAULT_RETENTION_POLICY };
  }

  async saveRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    await this.write("save the retention policy", () =>
      this.db.retention.put({ key: SINGLETON_KEY, value: policy }),
    );
  }

  /**
   * Evaluate the retention ceilings without pruning (Req 27.6, 27.7). Returns
   * `RetentionLimitReached` — never prunes silently — naming the tripped
   * ceiling and, for the dataset-count ceiling, the oldest stored datasets as
   * user-confirmed deletion candidates. `datasetId` scopes the per-dataset
   * record ceiling.
   */
  async checkRetention(datasetId?: string): Promise<RetentionCheckOutcome> {
    const policy = await this.getRetentionPolicy();
    const metas = await this.db.datasets.orderBy("createdAt").toArray();

    // Per-dataset record ceiling.
    if (datasetId !== undefined && policy.maxRecordsPerDataset > 0) {
      const count = await this.db.records.where("datasetId").equals(datasetId).count();
      if (count >= policy.maxRecordsPerDataset) {
        const name = metas.find((m) => m.id === datasetId)?.name ?? datasetId;
        return {
          kind: "RetentionLimitReached",
          limit: "maxRecordsPerDataset",
          ceiling: policy.maxRecordsPerDataset,
          current: count,
          datasetId,
          deletionCandidates: [],
          message:
            `Dataset "${name}" has reached its ${policy.maxRecordsPerDataset.toLocaleString()}-record ` +
            `limit. Remove some records or raise the retention ceiling before adding more.`,
        };
      }
    }

    // Stored-dataset-count ceiling.
    if (policy.maxDatasets > 0 && metas.length >= policy.maxDatasets) {
      // Offer the oldest datasets (by createdAt, oldest first) for the user to
      // confirm deletion — the engine never removes them automatically.
      const deletionCandidates = metas
        .slice(0, Math.max(1, metas.length - policy.maxDatasets + 1))
        .map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt }));
      return {
        kind: "RetentionLimitReached",
        limit: "maxDatasets",
        ceiling: policy.maxDatasets,
        current: metas.length,
        deletionCandidates,
        message:
          `You have reached the ${policy.maxDatasets}-dataset limit. Delete one of the ` +
          `oldest datasets to make room; nothing is removed until you confirm.`,
      };
    }

    return { kind: "ok" };
  }

  // ---------------------------------------------------------------------------
  // Quota-guard internals (task 4.3)
  // ---------------------------------------------------------------------------

  /**
   * Refuse a write up front when its projected serialized payload would exceed
   * the browser's remaining storage capacity (Req 27.1, 27.2). Only writes
   * above `quotaPreflightThresholdBytes` incur the async estimate; smaller
   * writes skip it and rely on the reactive rollback. When `StorageManager`
   * reports a zero quota (unsupported), the pre-flight is a no-op.
   *
   * Throws `QuotaPreflightError` (naming the dataset + shortfall) before any
   * write begins, so nothing is persisted.
   */
  private async quotaPreflight(datasetName: string, payload: unknown): Promise<void> {
    const projectedBytes = estimateSerializedBytes(payload);
    if (projectedBytes < this.quotaPreflightThresholdBytes) return;

    const { usageBytes, quotaBytes } = await this.estimateQuota();
    // A zero/unknown quota means StorageManager is unsupported: degrade to a
    // no-op and let the reactive QuotaExceededError path handle any overflow.
    if (quotaBytes <= 0) return;

    const availableBytes = Math.max(0, quotaBytes - usageBytes);
    if (projectedBytes > availableBytes) {
      const error = new QuotaPreflightError(datasetName, projectedBytes, availableBytes);
      // Surface the up-front refusal through the same notification channel as
      // any other write failure so the UI can display it (Req 27.2, 3.5).
      this.notify?.({
        level: "error",
        operation: "save records to the dataset",
        message: error.message,
        cause: error,
      });
      throw error;
    }
  }

  /**
   * Run a chunked-write function and translate a browser storage-quota failure
   * into a `QuotaExceededError` naming the dataset (Req 27.5). The write runs
   * inside a single Dexie transaction supplied by the caller, so a throw rolls
   * the entire append back — the dataset is never left half-written and both
   * persisted datasets and the in-memory active dataset are preserved.
   */
  private async runWriteWithQuotaRollback<T>(
    datasetId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      if (isQuotaExceeded(cause)) {
        // The transaction has already rolled back by the time the throw
        // surfaces here; re-throw a typed, dataset-named error for the UI.
        throw new QuotaExceededError(datasetId, cause);
      }
      throw cause;
    }
  }

  /**
   * Request persistent storage exactly once per instance, on the first
   * successful save (Req 27.3). A `false` (denied/unsupported) result is
   * recorded and surfaced as an advisory that stored datasets may be evicted
   * under storage pressure; it never blocks ingestion (Req 27.4).
   */
  private async maybeRequestPersistence(): Promise<void> {
    if (this.persistRequested) return;
    this.persistRequested = true;
    const granted = await this.requestPersistentStorage();
    if (!granted) {
      this.notify?.({
        level: "warning",
        operation: "request persistent storage",
        message:
          "Persistent storage was not granted. Stored datasets may be evicted under " +
          "storage pressure; export anything you want to keep.",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  async getSLAConfig(): Promise<SLAConfig> {
    const row = await this.db.slaConfig.get(SINGLETON_KEY);
    return row?.value ?? { ...DEFAULT_SLA_CONFIG };
  }

  async saveSLAConfig(config: SLAConfig): Promise<void> {
    await this.write("save the SLA configuration", () =>
      this.db.slaConfig.put({ key: SINGLETON_KEY, value: config }),
    );
  }

  async getColumnMapping(headerSetHash: string): Promise<ColumnMapping | undefined> {
    return this.db.mappings.get(headerSetHash);
  }

  async saveColumnMapping(mapping: ColumnMapping): Promise<void> {
    await this.write("save the column mapping", () =>
      this.db.mappings.put(mapping),
    );
  }
}
