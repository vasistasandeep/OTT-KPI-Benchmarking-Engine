/**
 * In-memory `Map`-backed implementation of `KPIDataRepository`.
 *
 * This is the graceful degradation path for incognito / private-browsing
 * sessions (and any environment where IndexedDB cannot be opened): it
 * implements the full `KPIDataRepository` interface so every consumer keeps
 * working unchanged, but nothing survives a page reload. The boot factory
 * (`createKPIRepository`) selects it when the Dexie open throws, and raises a
 * one-time advisory so the UI can show a banner that data will not persist
 * across sessions (Req 3.1 substitutability; incognito fallback).
 *
 * Behavioral parity with `DexieKPIRepository`:
 *   - duplicate dataset names are rejected on create and rename (Req 19.7);
 *   - records are chunked on read for API symmetry (chunking is a no-op cost
 *     in memory but keeps the contract identical) (Req 3.2);
 *   - column mappings are keyed by header-set hash (Req 7.6);
 *   - SLA config get/save round-trips (Req 14.2);
 *   - deleting a dataset removes its records and clears the active pointer
 *     when it referenced the deleted dataset (Req 3.6).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 7.6, 14.2, 19.7.
 */

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
  RECORD_CHUNK_SIZE,
  RecordNotFoundError,
  type RepositoryOptions,
  type RetentionCheckOutcome,
} from "./support";

export class InMemoryKPIRepository implements KPIDataRepository {
  private readonly datasets = new Map<string, DatasetMeta>();
  /** datasetId -> ordered records for that dataset. */
  private readonly records = new Map<string, KPIRecord[]>();
  private readonly mappings = new Map<string, ColumnMapping>();
  private slaConfig: SLAConfig = { ...DEFAULT_SLA_CONFIG, thresholds: {} };
  private retention: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY };
  private activeDatasetId: string | undefined;

  // Options are accepted for construction-signature parity with the Dexie
  // implementation; the in-memory store cannot fail a write, so `onNotify`
  // is unused here but kept so the two are interchangeable.
  constructor(_options: RepositoryOptions = {}) {}

  // ---------------------------------------------------------------------------
  // Datasets
  // ---------------------------------------------------------------------------

  async listDatasets(): Promise<DatasetMeta[]> {
    return [...this.datasets.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getDataset(id: string): Promise<Dataset | undefined> {
    const meta = this.datasets.get(id);
    if (!meta) return undefined;
    return { ...meta, records: [...(this.records.get(id) ?? [])] };
  }

  async saveDataset(dataset: Dataset): Promise<void> {
    const { records, ...meta } = dataset;
    this.assertNameFree(meta.name, meta.id);
    this.datasets.set(meta.id, { ...meta, recordCount: records.length });
    this.records.set(meta.id, [...records]);
  }

  async renameDataset(id: string, name: string): Promise<void> {
    const target = this.datasets.get(id);
    if (!target) throw new RecordNotFoundError(id, id);
    this.assertNameFree(name, id);
    this.datasets.set(id, { ...target, name });
  }

  async deleteDataset(id: string): Promise<void> {
    this.datasets.delete(id);
    this.records.delete(id);
    if (this.activeDatasetId === id) this.activeDatasetId = undefined;
  }

  async getActiveDatasetId(): Promise<string | undefined> {
    return this.activeDatasetId;
  }

  async setActiveDatasetId(id: string): Promise<void> {
    this.activeDatasetId = id;
  }

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------

  async appendRecords(datasetId: string, records: KPIRecord[]): Promise<void> {
    if (records.length === 0) return;
    const existing = this.records.get(datasetId) ?? [];
    // Merge by id so a re-append of the same id updates in place, matching the
    // Dexie bulkPut semantics.
    const byId = new Map(existing.map((r) => [r.id, r]));
    for (const r of records) byId.set(r.id, r);
    const merged = [...byId.values()];
    this.records.set(datasetId, merged);
    const meta = this.datasets.get(datasetId);
    if (meta) this.datasets.set(datasetId, { ...meta, recordCount: merged.length });
  }

  async getRecords(datasetId: string): Promise<KPIRecord[]> {
    // Chunked assembly for contract symmetry with the Dexie implementation.
    const all = this.records.get(datasetId) ?? [];
    const out: KPIRecord[] = [];
    for (let i = 0; i < all.length; i += RECORD_CHUNK_SIZE) {
      out.push(...all.slice(i, i + RECORD_CHUNK_SIZE));
    }
    return out;
  }

  async updateRecord(datasetId: string, record: KPIRecord): Promise<void> {
    const list = this.records.get(datasetId);
    const idx = list?.findIndex((r) => r.id === record.id) ?? -1;
    if (!list || idx === -1) throw new RecordNotFoundError(record.id, datasetId);
    list[idx] = { ...record, datasetId };
  }

  async deleteRecord(datasetId: string, recordId: string): Promise<void> {
    const list = this.records.get(datasetId);
    const idx = list?.findIndex((r) => r.id === recordId) ?? -1;
    if (!list || idx === -1) throw new RecordNotFoundError(recordId, datasetId);
    list.splice(idx, 1);
    const meta = this.datasets.get(datasetId);
    if (meta) this.datasets.set(datasetId, { ...meta, recordCount: list.length });
  }

  // ---------------------------------------------------------------------------
  // Storage capacity and retention
  // ---------------------------------------------------------------------------

  async estimateQuota(): Promise<QuotaEstimate> {
    // No persistent backing store: report nothing persisted (task 4.3 owns the
    // real quota accounting for the Dexie path).
    return { usageBytes: 0, quotaBytes: 0, persisted: false };
  }

  async requestPersistentStorage(): Promise<boolean> {
    return false;
  }

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    return { ...this.retention };
  }

  async saveRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    this.retention = { ...policy };
  }

  /**
   * Evaluate the retention ceilings without pruning (Req 27.6, 27.7); mirrors
   * the Dexie implementation so the two stay interchangeable. Never prunes
   * silently — returns `RetentionLimitReached` naming the tripped ceiling.
   */
  async checkRetention(datasetId?: string): Promise<RetentionCheckOutcome> {
    const policy = this.retention;
    const metas = [...this.datasets.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    if (datasetId !== undefined && policy.maxRecordsPerDataset > 0) {
      const count = this.records.get(datasetId)?.length ?? 0;
      if (count >= policy.maxRecordsPerDataset) {
        const name = this.datasets.get(datasetId)?.name ?? datasetId;
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

    if (policy.maxDatasets > 0 && metas.length >= policy.maxDatasets) {
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
  // Configuration
  // ---------------------------------------------------------------------------

  async getSLAConfig(): Promise<SLAConfig> {
    return { ...this.slaConfig, thresholds: { ...this.slaConfig.thresholds } };
  }

  async saveSLAConfig(config: SLAConfig): Promise<void> {
    this.slaConfig = { ...config, thresholds: { ...config.thresholds } };
  }

  async getColumnMapping(headerSetHash: string): Promise<ColumnMapping | undefined> {
    return this.mappings.get(headerSetHash);
  }

  async saveColumnMapping(mapping: ColumnMapping): Promise<void> {
    this.mappings.set(mapping.headerSetHash, mapping);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Reject a create/rename whose name is taken by a *different* dataset (Req 19.7). */
  private assertNameFree(name: string, selfId: string): void {
    for (const meta of this.datasets.values()) {
      if (meta.name === name && meta.id !== selfId) {
        throw new DuplicateNameError(name);
      }
    }
  }
}
