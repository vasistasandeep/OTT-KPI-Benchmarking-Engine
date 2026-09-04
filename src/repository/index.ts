/**
 * Public entry point for the persistence layer.
 *
 * Exposes the `KPIDataRepository` storage-adapter interface (Req 3.1), its
 * concrete implementations (`DexieKPIRepository` over IndexedDB and the
 * `InMemoryKPIRepository` incognito fallback), the `createKPIRepository` boot
 * factory that selects between them, and the shared support types.
 */

export type { KPIDataRepository } from "./KPIDataRepository";

export { DexieKPIRepository, KPIDatabase } from "./DexieKPIRepository";
export { InMemoryKPIRepository } from "./InMemoryKPIRepository";
export {
  createKPIRepository,
  type RepositoryBootResult,
  type CreateRepositoryOptions,
} from "./createKPIRepository";

export {
  DuplicateNameError,
  RecordNotFoundError,
  QuotaPreflightError,
  QuotaExceededError,
  RECORD_CHUNK_SIZE,
  QUOTA_PREFLIGHT_THRESHOLD_BYTES,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_SLA_CONFIG,
  estimateSerializedBytes,
  formatBytes,
  isQuotaExceeded,
  type NotifyFn,
  type RepositoryNotification,
  type RepositoryNotificationLevel,
  type RepositoryOptions,
  type RetentionCheckOutcome,
  type RetentionLimitReached,
} from "./support";
