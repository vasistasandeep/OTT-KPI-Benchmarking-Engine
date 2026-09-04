/**
 * Cross-cutting support types shared by the concrete `KPIDataRepository`
 * implementations (`DexieKPIRepository`, `InMemoryKPIRepository`) and the
 * `createKPIRepository` boot factory.
 *
 * These types are owned by the persistence layer itself (not `src/models`)
 * because they describe *how* a store surfaces failures and degradation, not
 * the domain data it holds.
 *
 * Requirements: 3.5 (write-failure notification), 19.7 (duplicate-name
 * rejection), 27.6 (retention policy defaults).
 */

/** Severity of a repository-emitted notification. */
export type RepositoryNotificationLevel = "error" | "warning" | "info";

/**
 * A user-visible message emitted by the repository. The UI layer subscribes via
 * the `onNotify` callback passed at construction and renders these through the
 * shared notification channel described in the design's Error Handling section.
 */
export interface RepositoryNotification {
  level: RepositoryNotificationLevel;
  /** Names the failed operation so the message can identify it (Req 3.5). */
  operation: string;
  /** Human-readable message suitable for direct display. */
  message: string;
  /** Optional dataset the failure relates to, for messages that name it. */
  datasetId?: string;
  /** The underlying error, when the notification stems from a thrown failure. */
  cause?: unknown;
}

/** Sink the repository calls to surface a notification to the UI (Req 3.5). */
export type NotifyFn = (notification: RepositoryNotification) => void;

/**
 * Error thrown when a create/rename would collide with an existing dataset
 * name. Callers (and the tests) can branch on `instanceof DuplicateNameError`
 * rather than string-matching a message (Req 19.7).
 */
export class DuplicateNameError extends Error {
  readonly name = "DuplicateNameError";
  constructor(public readonly datasetName: string) {
    super(`A dataset named "${datasetName}" already exists. Dataset names must be unique.`);
  }
}

/**
 * Error thrown when an edit/delete targets a record that does not belong to the
 * given dataset, or a dataset that does not exist.
 */
export class RecordNotFoundError extends Error {
  readonly name = "RecordNotFoundError";
  constructor(public readonly recordId: string, public readonly datasetId: string) {
    super(`Record "${recordId}" was not found in dataset "${datasetId}".`);
  }
}

/**
 * Error thrown by the quota pre-flight when a write's projected payload would
 * exceed the browser's remaining storage capacity (Req 27.1, 27.2). It names
 * the affected dataset and reports the shortfall so the write is refused up
 * front and nothing is written. Callers can branch on
 * `instanceof QuotaPreflightError` rather than string-matching the message.
 */
export class QuotaPreflightError extends Error {
  readonly name = "QuotaPreflightError";
  constructor(
    /** Human-readable name of the dataset the refused write targeted. */
    public readonly datasetName: string,
    /** Projected serialized payload size of the refused write, in bytes. */
    public readonly projectedBytes: number,
    /** Remaining storage capacity at the time of the check, in bytes. */
    public readonly availableBytes: number,
  ) {
    super(
      `Cannot save to "${datasetName}": this write needs about ${formatBytes(
        projectedBytes,
      )} but only ${formatBytes(availableBytes)} of browser storage remains ` +
        `(short by ${formatBytes(Math.max(0, projectedBytes - availableBytes))}). ` +
        `Delete an older dataset to free space, then retry.`,
    );
  }

  /** Bytes this write fell short by (never negative). */
  get shortfallBytes(): number {
    return Math.max(0, this.projectedBytes - this.availableBytes);
  }
}

/**
 * Error thrown when a write fails because the browser's storage quota was
 * exceeded mid-write. The chunked append is rolled back inside a single
 * transaction so the dataset is never left half-written; persisted datasets and
 * the in-memory active dataset are both preserved (Req 27.5, 3.5). The message
 * names the dataset and suggests deleting older datasets to reclaim space.
 */
export class QuotaExceededError extends Error {
  readonly name = "QuotaExceededError";
  constructor(
    public readonly datasetId: string,
    public readonly cause?: unknown,
  ) {
    super(
      `Ran out of browser storage while saving dataset "${datasetId}". ` +
        `The whole write was rolled back and your existing data is preserved. ` +
        `Delete an older dataset to reclaim space, then retry.`,
    );
  }
}

/**
 * Outcome of a retention check (Req 27.6, 27.7). The repository never prunes
 * silently: when a configured ceiling is reached it returns a
 * `RetentionLimitReached` outcome naming which ceiling tripped and the oldest
 * stored datasets (by `createdAt`) so the Dataset Switcher can present them as
 * user-confirmed deletion candidates.
 */
export type RetentionCheckOutcome =
  | { kind: "ok" }
  | RetentionLimitReached;

/** Details of a tripped retention ceiling (Req 27.7). */
export interface RetentionLimitReached {
  kind: "RetentionLimitReached";
  /** Which ceiling was reached. */
  limit: "maxDatasets" | "maxRecordsPerDataset";
  /** The configured ceiling value that was reached. */
  ceiling: number;
  /** The current count measured against the ceiling. */
  current: number;
  /** Dataset the per-dataset ceiling applies to (only for `maxRecordsPerDataset`). */
  datasetId?: string;
  /**
   * Oldest stored datasets (by `createdAt`, oldest first) offered as deletion
   * candidates for the user to confirm. Empty for a per-dataset ceiling.
   */
  deletionCandidates: { id: string; name: string; createdAt: string }[];
  /** Human-readable message suitable for direct display. */
  message: string;
}

/**
 * Options accepted by every concrete repository. `onNotify` lets the store wire
 * failures into the UI notification channel; when omitted, notifications are
 * dropped (useful in tests) but write failures still reject.
 */
export interface RepositoryOptions {
  onNotify?: NotifyFn;
  /**
   * Records read/written per chunk for large session logs (Req 3.2). Defaults
   * to `RECORD_CHUNK_SIZE`. Exposed so deployments can tune it and tests can
   * exercise multi-chunk paging without materializing huge fixtures.
   */
  recordChunkSize?: number;
  /**
   * Serialized-payload size (bytes) above which a write triggers the
   * `navigator.storage.estimate()` pre-flight (Req 27.1). Defaults to
   * `QUOTA_PREFLIGHT_THRESHOLD_BYTES` (10 MB). Exposed so tests can force the
   * pre-flight on small fixtures without building a 10 MB payload.
   */
  quotaPreflightThresholdBytes?: number;
}

/** Number of records written/read per chunk for large session logs (Req 3.2). */
export const RECORD_CHUNK_SIZE = 5_000;

/**
 * Only writes whose estimated serialized payload exceeds this threshold trigger
 * the `navigator.storage.estimate()` pre-flight (design: "any `appendRecords`
 * batch estimated above 10 MB of serialized payload"). Smaller writes skip the
 * async estimate and rely on the reactive `QuotaExceededError` rollback.
 */
export const QUOTA_PREFLIGHT_THRESHOLD_BYTES = 10 * 1024 * 1024;

/**
 * Estimate the serialized byte size of a value the way it will be stored. We
 * use the UTF-16-ish `JSON.stringify` length as a cheap, deterministic proxy
 * for the payload size; it is intentionally an upper-ish bound so the
 * pre-flight errs toward caution rather than under-counting.
 */
export function estimateSerializedBytes(value: unknown): number {
  try {
    // Two bytes per UTF-16 code unit approximates the stored footprint closely
    // enough for a capacity guard without serializing twice.
    return JSON.stringify(value)?.length * 2 || 0;
  } catch {
    return 0;
  }
}

/** Format a byte count into a compact human-readable string for messages. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** True when an error (or its cause chain) is a browser storage quota error. */
export function isQuotaExceeded(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (typeof DOMException !== "undefined" && e instanceof DOMException) {
      if (e.name === "QuotaExceededError") return true;
    }
    if (e instanceof Error) {
      if (e.name === "QuotaExceededError" || /quota.*exceed/i.test(e.message)) return true;
      // Dexie wraps the underlying error; follow the standard `cause` link.
      e = (e as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/** Default retention ceilings (Req 27.6); fleshed out further in task 4.3. */
export const DEFAULT_RETENTION_POLICY = {
  maxDatasets: 10,
  maxRecordsPerDataset: 500_000,
} as const;

/** Default SLA configuration used when none has been persisted yet. */
export const DEFAULT_SLA_CONFIG = {
  varianceBand: 1.5,
  thresholds: {},
  minSampleSize: 100,
} as const;
