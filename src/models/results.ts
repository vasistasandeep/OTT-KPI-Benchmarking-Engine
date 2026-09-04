/**
 * Aggregated and comparison result types plus the active filter slice.
 *
 * Requirements: 5.7, 4.3, 11.3, 11.4, 16.5, 20.4, 23.4, 23.8, 24.4, 25.2,
 * 25.3, 25.4, 26.6, 26.7, 10.3, 10.4.
 */

import type { CanonicalKPIId, DimensionId } from "./ids";
import type { AppAssignment, DataQualityAdvisory } from "./records";
import type { Numeric } from "./sentinels";

/** Whether an aggregate for a slice can be validly combined. */
export type Aggregability = "aggregable" | "not_aggregable";

/** A record excluded from an aggregate, with the reason. (Req 5.7, 4.3) */
export interface RejectedRecord {
  recordId: string;
  field?: string;
  reason: string;
}

/** The computed value for one KPI and one app over a slice. */
export interface AggregatedKPIValue {
  kpiId: CanonicalKPIId;
  app: AppAssignment;
  /** NO_DATA when absent, NOT_AGGREGABLE when invalid to combine. */
  value: Numeric;
  /** Always the KPI's canonicalUnit. */
  unit: string;
  /** "not_aggregable" when the slice would require an invalid merge. (Req 23.4) */
  aggregability: Aggregability;
  /** false triggers the unweighted advisory. (Req 20.4) */
  weighted: boolean;
  /** Drives the minimum-sample-size confidence gate. (Req 25.2, 25.3) */
  contributingRecords: number;
  /** Granularity this value is valid at, when not aggregable. (Req 23.5) */
  ingestedGranularity?: "hour" | "day";
  rejectedRecords: RejectedRecord[]; // Req 5.7, 4.3
  advisories: DataQualityAdvisory[];
  /** For sparkline / time-series. */
  series?: { date: string; value: Numeric }[];
}

/** All aggregated values, indexed per segment and overall. */
export interface AggregatedResultSet {
  bySegment: Map<string /* segmentKey */, AggregatedKPIValue[]>;
  overall: AggregatedKPIValue[];
  unweightedAdvisory: boolean;
}

/** Red/Amber/Green plus suppressed-verdict states. */
export type RAGStatus = "Red" | "Amber" | "Green" | "LowConfidence" | "NoData";

/** Reason a comparison was suppressed, so the UI can explain itself precisely. */
export type SuppressionReason =
  | "no_data" // one or both aggregates are NO_DATA
  | "not_aggregable" // one or both aggregates are NOT_AGGREGABLE (Req 23.8)
  | "below_min_sample"; // contributing volume under SLAConfig.minSampleSize (Req 25.4)

/** The App_A vs App_B comparison for a single KPI. */
export interface ComparisonResult {
  kpiId: CanonicalKPIId;
  appAValue: Numeric;
  appBValue: Numeric;
  /** appB - appA. (Req 11.3) */
  absoluteDelta: Numeric;
  /** NO_DATA/"N/A" when appA == 0. (Req 11.4) */
  percentDelta: Numeric | "N/A";
  rag: RAGStatus;
  suppressionReason?: SuppressionReason;
  appAContributingRecords: number;
  appBContributingRecords: number;
}

/** All comparison results for the active slice. */
export interface ComparisonResultSet {
  results: ComparisonResult[];
  slice: FilterSlice;
}

/** The active filter slice driving aggregation and comparison. */
export interface FilterSlice {
  /** from/to inclusive on both ends, evaluated against the UTC bucket. (Req 26.7) */
  dateRange: { preset: "7d" | "30d" | "custom"; from?: string; to?: string };
  /** Bucket granularity for series and rollup. (Req 26.6) */
  granularity: "hour" | "day";
  /** IANA zone for rendering only; "UTC" by default. (Req 26.8, 26.9) */
  displayTimezone: string;
  /** Multi-select dimension chips. (Req 10.3) */
  dimensionSelections: Partial<Record<DimensionId, string[]>>;
  /** App_A / App_B toggle. (Req 10.4) */
  apps: AppAssignment[];
}
