/**
 * Core canonical records and datasets.
 *
 * Every value stored on a record is already expressed in its KPI's canonical
 * unit and every timestamp is normalized to UTC, so downstream comparison,
 * thresholding, and bucketing are always like-for-like.
 *
 * Requirements: 1.1, 3.1, 5.5, 5.8, 11.3, 16.1, 20, 21.5, 22.6, 22.9, 23.5,
 * 26.1, 26.2, 26.5, 27.8, 27.9.
 */

import type { CanonicalKPIId, DimensionId } from "./ids";

/** Whether a source arrived as pre-aggregated summaries or raw session logs. */
export type IngestionMode = "Pre_Aggregated" | "Raw_Session";

/** Which of the two compared applications a record belongs to. */
export type AppAssignment = "App_A" | "App_B";

/** Provenance of a dataset's records. (Req 19.1) */
export type SourceType = "Raw" | "Aggregated" | "Mock";

/** UTC hour and day buckets assigned at ingestion from `timestampUtc`. (Req 26.5) */
export interface TimeBucket {
  /** ISO 8601 UTC hour, e.g. "2025-03-14T09:00:00Z". */
  hourUtc: string;
  /** UTC calendar day, e.g. "2025-03-14". */
  dayUtc: string;
}

/** A data-quality note attached to a record or aggregated value. */
export interface DataQualityAdvisory {
  code:
    | "ASSUMED_UNIT" // unit could not be inferred; canonical unit assumed (Req 22.6)
    | "NON_MONOTONIC_QUARTILES" // completion quartiles violate 25% >= 50% >= 75% >= 100% (Req 22.9)
    | "UNWEIGHTED_AGGREGATE" // Req 20.4
    | "UNKNOWN_DIMENSION_MEMBER"; // Req 2.7
  detail: string;
}

/**
 * Raw per-session fields. All optional; presence depends on the source. Values
 * carry their unit in the field name (e.g. `bufferingMs`, `renderedBitrateKbps`)
 * and are normalized to the derived KPI's canonical unit at compute time.
 */
export interface RawSessionFields {
  // Playback quality
  bufferingMs?: number;
  playTimeMs?: number; // time spent playing content
  viewingTimeMs?: number; // total viewing time, denominator for per-hour rates
  rebufferEventCount?: number; // discrete rebuffer events, for Rebuffer Rate
  startFailure?: 0 | 1;
  playbackAttempt?: 0 | 1;
  exitBeforeStart?: 0 | 1; // EBVS numerator
  vstMs?: number;
  ttfbMs?: number;
  manifestFetchMs?: number;
  renderedBitrateKbps?: number; // session average rendered bitrate
  downshiftCount?: number; // bitrate downshifts in the session
  // Engagement
  userId?: string; // identifier for distinct-count KPIs (Req 23.1, 28.12)
  sessionDurationMs?: number;
  quartileReached?: 0 | 25 | 50 | 75 | 100; // furthest completion quartile reached
  browseEvent?: 0 | 1; // Browse-to-Play denominator
  playEvent?: 0 | 1; // Browse-to-Play numerator
  // Ad events
  adRequestCount?: number;
  adFilledCount?: number;
  adStartFailureCount?: number;
  adCompleteCount?: number;
  adPodStartCount?: number;
  adPodAbandonCount?: number;
  cacheHit?: 0 | 1; // CDN edge cache outcome for the manifest/segment request
  [field: string]: number | string | undefined;
}

/** A single canonical record, from a file, manual entry, or the mock seeder. */
export interface KPIRecord {
  id: string;
  datasetId: string;
  /** From an app column, an app-qualified column, or the file-level assignment. */
  app: AppAssignment;
  /** ISO 8601, always normalized to UTC with a Z suffix. (Req 26.1) */
  timestampUtc: string;
  /** Original UTC offset preserved; null when the source carried none. (Req 26.1, 26.2) */
  sourceUtcOffsetMinutes: number | null;
  /** Assigned at ingestion from `timestampUtc`. (Req 26.5) */
  bucket: TimeBucket;
  /** Manual rows are editable and deletable. (Req 27.8, 27.9) */
  origin: "file" | "manual" | "mock";
  /** Missing dimension -> filled with "Unknown" at slice time. (Req 16.2) */
  dimensions: Record<DimensionId, string>;
  /** Pre-aggregated payload; every value already in its KPI's canonicalUnit. */
  metrics?: Partial<Record<CanonicalKPIId, number>>;
  /** Session count / watch time. (Req 20) */
  volumeWeight?: number;
  /** Granularity at which non-aggregable KPIs remain valid. (Req 23.5) */
  ingestedGranularity?: "hour" | "day";
  /** Raw-session payload. */
  session?: RawSessionFields;
  /** Assumed unit, non-monotonic quartiles, etc. (Req 22.6, 22.9) */
  advisories?: DataQualityAdvisory[];
}

/** Metadata describing a stored dataset. */
export interface DatasetMeta {
  id: string;
  /** Unique across datasets. (Req 19.7) */
  name: string;
  /** ISO 8601 creation time. (Req 19.1) */
  createdAt: string;
  /** Custom App_A label. (Req 19.5) */
  appALabel: string;
  /** Custom App_B label. (Req 19.5) */
  appBLabel: string;
  recordCount: number;
  sourceType: SourceType; // Req 19.1
  ingestionMode: IngestionMode;
  /**
   * The per-dataset salt used when mapped user identifiers were replaced with a
   * salted SHA-256 hash at ingestion. Persisted with the dataset so the same
   * user collapses to one distinct-count bucket for the dataset's lifetime and
   * the pseudonymization stays reproducible. Undefined when hashing was not
   * applied. (Req 28.13)
   */
  userIdSalt?: string;
}

/** A dataset together with its records. */
export interface Dataset extends DatasetMeta {
  records: KPIRecord[];
}
