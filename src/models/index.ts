/**
 * Public entry point for the core data models.
 *
 * Aggregates the record, dataset, sentinel, result, and configuration types
 * defined in this module. Registry-owned identifier types (`CanonicalKPIId`,
 * `DimensionId`) are re-exported here as forward declarations until the
 * registry (tasks 3.x) refines them.
 */

// Identifier forward declarations (owned by the registry, tasks 3.x)
export type { CanonicalKPIId, DimensionId } from "./ids";

// Sentinels and numeric value types
export { NO_DATA, NOT_AGGREGABLE } from "./sentinels";
export type { Sentinel, Numeric } from "./sentinels";

// Core records and datasets
export type {
  IngestionMode,
  AppAssignment,
  SourceType,
  TimeBucket,
  DataQualityAdvisory,
  RawSessionFields,
  KPIRecord,
  DatasetMeta,
  Dataset,
} from "./records";

// Aggregated / comparison results and the active filter slice
export type {
  Aggregability,
  RejectedRecord,
  AggregatedKPIValue,
  AggregatedResultSet,
  RAGStatus,
  SuppressionReason,
  ComparisonResult,
  ComparisonResultSet,
  FilterSlice,
} from "./results";

// Mapping, SLA, and repository-support configuration
export type {
  SourceLayout,
  MappingTarget,
  ColumnMapping,
  SLAConfig,
  QuotaEstimate,
  RetentionPolicy,
} from "./config";
