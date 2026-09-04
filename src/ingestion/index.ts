/**
 * Public entry point for the ingestion pipeline.
 *
 * Currently re-exports the FuzzyMatcher (task 10.2). Later ingestion pieces
 * (FileParser, LayoutDetector, ColumnMapper, unit/timestamp normalizers) will
 * be re-exported here as well.
 */

export {
  AUTO_MAP_THRESHOLD,
  APP_SUFFIX_PAIRS,
  tokenizeHeader,
  normalizeHeader,
  diceSimilarity,
  matchHeader,
} from "./fuzzy-matcher";

export type {
  AppAssignment,
  MatchTargetKind,
  MatchTarget,
  FuzzyMatchResult,
} from "./fuzzy-matcher";

export { normalizeTimestamp } from "./timestamp-normalizer";

export type {
  NormalizedTimestamp,
  RejectedTimestamp,
  TimestampNormalizationResult,
} from "./timestamp-normalizer";

export { buildRecords, appendedMemberAdvisory } from "./record-builder";

export type {
  RejectedRow,
  AppendedMember,
  RecordBuildResult,
  RecordBuildContext,
} from "./record-builder";

export { validateMapping, FILE_LEVEL_APP } from "./mapping-validator";

export type {
  MappingAssignments,
  EffectiveApp,
  MappingValidationErrorKind,
  MappingValidationError,
  MappingValidationResult,
  DuplicateKPIAppConflict,
} from "./mapping-validator";

export { computeHeaderSetHash, persistMapping, lookupMapping } from "./mapping-cache";

export type { ReusedMapping } from "./mapping-cache";

export {
  seedMockDataset,
  DEMO_DAYS,
  DEFAULT_MOCK_SEED,
  DEFAULT_END_DAY,
  DEMO_APP_A_LABEL,
  DEMO_APP_B_LABEL,
} from "./mock-seeder";

export type { ScaleProfile, MockSeedOptions } from "./mock-seeder";

export {
  proposeMappingDraft,
  requiresFileLevelApp,
  resolveColumnUnit,
  buildConfirmedMapping,
  ingestConfirmedMapping,
  saltedHash,
} from "./ingestion-flow";

export type {
  ColumnDraft,
  MappingDraft,
  IngestOptions,
  IngestResult,
} from "./ingestion-flow";

export {
  validateManualEntry,
  buildManualRecords,
  applyManualEdit,
  isEditable,
  draftFromRecord,
} from "./manual-entry";

export type {
  ManualEntryCell,
  ManualEntryDraft,
  FieldError,
  ManualEntryValidation,
  ManualRecordContext,
  ManualEntryBuildResult,
} from "./manual-entry";
