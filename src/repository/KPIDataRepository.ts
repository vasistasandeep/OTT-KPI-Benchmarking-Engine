/**
 * Persistence abstraction for the OTT KPI Benchmarking Engine.
 *
 * `KPIDataRepository` exposes every persistence operation behind a single
 * interface so the underlying storage implementation can be replaced without
 * changing any consuming code (Req 3.1). The default `DexieKPIRepository`
 * implements this over IndexedDB; a future `SupabaseKPIRepository` /
 * `RestKPIRepository` can be substituted with no change to callers.
 *
 * Supporting types (`Dataset`, `DatasetMeta`, `KPIRecord`, `QuotaEstimate`,
 * `RetentionPolicy`, `SLAConfig`, `ColumnMapping`) are owned by `src/models`
 * and imported here rather than redeclared.
 *
 * Requirements: 3.1.
 */

import type {
  Dataset,
  DatasetMeta,
  KPIRecord,
  QuotaEstimate,
  RetentionPolicy,
  SLAConfig,
  ColumnMapping,
} from "@/models";

import type { RetentionCheckOutcome } from "./support";

/**
 * Storage-adapter interface abstracting all persistence operations for
 * datasets, records, storage capacity/retention, and configuration.
 */
export interface KPIDataRepository {
  // Datasets
  listDatasets(): Promise<DatasetMeta[]>;
  getDataset(id: string): Promise<Dataset | undefined>;
  saveDataset(dataset: Dataset): Promise<void>;
  renameDataset(id: string, name: string): Promise<void>; // rejects duplicate name (Req 19.7)
  deleteDataset(id: string): Promise<void>; // Req 3.6, 19.8
  getActiveDatasetId(): Promise<string | undefined>;
  setActiveDatasetId(id: string): Promise<void>;

  // Records (chunked for large session logs)
  appendRecords(datasetId: string, records: KPIRecord[]): Promise<void>;
  getRecords(datasetId: string): Promise<KPIRecord[]>;
  updateRecord(datasetId: string, record: KPIRecord): Promise<void>; // manual-entry edit (Req 27.8)
  deleteRecord(datasetId: string, recordId: string): Promise<void>; // manual-entry delete (Req 27.8)

  // Storage capacity and retention
  estimateQuota(): Promise<QuotaEstimate>; // Req 27.1
  requestPersistentStorage(): Promise<boolean>; // Req 27.3
  getRetentionPolicy(): Promise<RetentionPolicy>; // Req 27.6
  saveRetentionPolicy(policy: RetentionPolicy): Promise<void>;
  /**
   * Evaluate the retention ceilings without pruning. Returns
   * `RetentionLimitReached` (never prunes silently) when a ceiling is reached so
   * the UI can offer the oldest datasets as user-confirmed deletion candidates
   * (Req 27.6, 27.7). `datasetId` scopes the per-dataset record ceiling check.
   */
  checkRetention(datasetId?: string): Promise<RetentionCheckOutcome>;

  // Configuration
  getSLAConfig(): Promise<SLAConfig>;
  saveSLAConfig(config: SLAConfig): Promise<void>; // Req 14.2
  getColumnMapping(headerSetHash: string): Promise<ColumnMapping | undefined>;
  saveColumnMapping(mapping: ColumnMapping): Promise<void>; // Req 7.6
}
