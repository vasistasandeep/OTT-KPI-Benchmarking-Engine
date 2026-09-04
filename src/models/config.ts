/**
 * Column mapping, SLA configuration, and repository-support types
 * (quota estimate, retention policy).
 *
 * Requirements: 7.6, 7.7, 11.6, 14.1, 14.2, 21.3, 21.5, 22.4, 23.1, 23.2,
 * 25.1, 27.1, 27.3, 27.6.
 */

import type { CanonicalKPIId, DimensionId } from "./ids";
import type { AppAssignment, IngestionMode } from "./records";

/** Detected source layout: one row per app-period ("long") or one column per app ("wide"). */
export type SourceLayout = "long" | "wide";

/** What a source column maps to. `app` is present only in wide layout. */
export type MappingTarget =
  | { kind: "kpi"; kpiId: CanonicalKPIId; app?: AppAssignment }
  | { kind: "dimension"; dimensionId: DimensionId }
  | { kind: "app" }
  | { kind: "timestamp" }
  | { kind: "volumeWeight" }
  | { kind: "userId" } // enables distinct-count KPIs in raw mode (Req 23.1, 23.2)
  | { kind: "unmapped" };

/** A confirmed column mapping, reusable across files with the same header set. */
export interface ColumnMapping {
  /** Key for reuse. (Req 7.6, 7.7) */
  headerSetHash: string;
  headers: string[];
  /** sourceHeader -> target. */
  assignments: Record<string, MappingTarget>;
  /** sourceHeader -> resolved source unit token. (Req 22.4) */
  units: Record<string, string>;
  /** Detected, user-confirmable. (Req 21.3) */
  layout: SourceLayout;
  /** Set when the file carries no app column and no app-qualified columns. (Req 21.5) */
  fileAppAssignment?: AppAssignment;
  ingestionMode: IngestionMode;
}

/** SLA thresholds and confidence gating. */
export interface SLAConfig {
  /** Default 1.5 (%). (Req 11.6, 14.1) */
  varianceBand: number;
  /** Overrides of each KPI's defaultSLA. (Req 14.2) */
  thresholds: Partial<Record<CanonicalKPIId, number>>;
  /** Default 100 contributing records per app. (Req 25.1) */
  minSampleSize: number;
}

/** Browser storage capacity snapshot. (Req 27.1) */
export interface QuotaEstimate {
  usageBytes: number;
  quotaBytes: number;
  /** StorageManager.persisted() result. */
  persisted: boolean;
}

/** Caps on stored datasets and per-dataset record count. (Req 27.6) */
export interface RetentionPolicy {
  /** Default 10. */
  maxDatasets: number;
  /** Default 500_000. */
  maxRecordsPerDataset: number;
}
