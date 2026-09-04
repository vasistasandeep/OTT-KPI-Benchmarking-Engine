/**
 * RecordBuilder — turns a parsed, mapped source into canonical `KPIRecord`s
 * (design "Build canonical KPIRecords, app from column / row / file assignment").
 *
 * This is the step that immediately follows unit and timestamp normalization in
 * the ingestion flow. It resolves each source row's app assignment from one of
 * the three supported layouts and produces one canonical record per app, with
 * every metric value already in its KPI's canonical unit and every timestamp
 * normalized to UTC. It never reimplements unit, timestamp, or bucketing logic —
 * it delegates to `normalizeMappedValue`, `normalizeTimestamp`, and (through the
 * timestamp normalizer) `bucketTimestamp`.
 *
 * App resolution (Req 21.1):
 *
 * - **wide** — the app is encoded in the column name. Columns mapped to a KPI
 *   carry an `app` qualifier (`{ kind: "kpi", kpiId, app }`); each source row
 *   **fans out** into one record per app, each carrying the shared timestamp and
 *   dimension values plus only that app's metric values (Req 21.6, 21.7). A row
 *   with a value for one app and a blank for the other yields a single record
 *   for the app that carries a value (Req 21.8).
 * - **long** — the app is read per row from the column mapped `{ kind: "app" }`.
 *   One source row yields one record.
 * - **file-level** — neither an app column nor app-qualified columns are present;
 *   `fileAppAssignment` on the mapping is stamped onto every record (Req 21.5).
 *
 * Dimension values are retained verbatim. A value not present in a dimension's
 * seed member list is still kept on the record and reported as a newly-appended
 * member with an `UNKNOWN_DIMENSION_MEMBER` advisory (Req 2.7) — records are
 * never dropped for carrying an unfamiliar dimension value.
 *
 * The completion-quartile monotonicity check (Req 22.9) runs on each built
 * pre-aggregated record via the engine's `checkQuartileMonotonicity`; a
 * violation is reported as an advisory and the record is still emitted.
 *
 * Structurally invalid rows are rejected, not silently dropped: an unparseable
 * timestamp yields a `RejectedRow` with a reason (Req 26.4). Advisory-worthy but
 * usable data (assumed unit, unknown dimension member, non-monotonic quartiles)
 * is always retained and aggregated (Req 22.8).
 *
 * Pure function: no DOM, no storage, no randomness. Record ids are derived
 * deterministically from the dataset id, the source row index, and the app so
 * the same input always builds the same records.
 *
 * Requirements: 2.7, 21.5, 21.6, 21.7, 21.8, 22.9.
 */

import { checkQuartileMonotonicity } from "@/engine/quartiles";
import type {
  AppAssignment,
  CanonicalKPIId,
  DataQualityAdvisory,
  DimensionId,
  IngestionMode,
  KPIRecord,
  RawSessionFields,
} from "@/models";
import type { ColumnMapping, MappingTarget } from "@/models/config";
import { DIMENSION_REGISTRY, UNKNOWN_MEMBER } from "@/registry/dimensions";
import type { ParsedRow } from "./file-parser";
import { normalizeMappedValue } from "./unit-normalizer";
import { normalizeTimestamp } from "./timestamp-normalizer";

/** The two apps, in the order records fan out for a wide row. */
const APPS: readonly AppAssignment[] = ["App_A", "App_B"];

/** A source row that could not be turned into any record (Req 26.4). */
export interface RejectedRow {
  /** The zero-based index of the offending source row. */
  rowIndex: number;
  /** Human-readable reason the row was rejected. */
  reason: string;
}

/**
 * A dimension value seen at ingestion that was not among the dimension's seed
 * members and has been appended as a new member (Req 2.7).
 */
export interface AppendedMember {
  dimensionId: DimensionId;
  member: string;
}

/** The outcome of building canonical records from a parsed, mapped source. */
export interface RecordBuildResult {
  /** The canonical records, one per app per usable source row. */
  records: KPIRecord[];
  /** Source rows that could not be built into any record (Req 26.4). */
  rejected: RejectedRow[];
  /**
   * Distinct dimension values encountered that were not seed members and were
   * appended as new members, deduplicated across the file (Req 2.7).
   */
  appendedMembers: AppendedMember[];
}

/** Inputs the builder needs beyond the mapping and rows. */
export interface RecordBuildContext {
  /** The dataset the records belong to; used to derive record ids. */
  datasetId: string;
  /** Pre-aggregated vs raw-session; controls whether metrics or session is set. */
  ingestionMode: IngestionMode;
}

/** Seed member set per dimension, for the unknown-member check (Req 2.7). */
const SEED_MEMBERS: Readonly<Record<DimensionId, ReadonlySet<string>>> =
  Object.fromEntries(
    DIMENSION_REGISTRY.map((d) => [d.id, new Set(d.members)] as const),
  ) as unknown as Record<DimensionId, ReadonlySet<string>>;

/**
 * Parse a source cell into a finite number, or `undefined` when the cell is
 * blank or not a number. A blank cell is how a wide row signals "this app has no
 * value" (Req 21.8); a non-numeric non-blank cell simply contributes no metric.
 */
function parseNumeric(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined;
  const trimmed = cell.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** A column's mapping paired with its source header, for iteration. */
interface MappedColumn {
  header: string;
  target: MappingTarget;
}

/** Flatten the mapping's assignments into an ordered list of mapped columns. */
function mappedColumns(mapping: ColumnMapping): MappedColumn[] {
  return mapping.headers
    .map((header) => ({ header, target: mapping.assignments[header] }))
    .filter((c): c is MappedColumn => c.target !== undefined);
}

/**
 * Resolve the app a given source row belongs to in a `long` layout: the value of
 * the column mapped `{ kind: "app" }`, normalized to `App_A` / `App_B`.
 *
 * Returns `null` when the row carries no recognizable app value, so the caller
 * can reject the row with a reason rather than guessing.
 */
function resolveRowApp(row: ParsedRow, appHeader: string): AppAssignment | null {
  const raw = (row[appHeader] ?? "").trim();
  if (raw.length === 0) return null;
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized === "appa" || normalized === "a") return "App_A";
  if (normalized === "appb" || normalized === "b") return "App_B";
  return null;
}

/**
 * Collect the dimension tags on a row, retaining every value verbatim. Values
 * not among a dimension's seed members are still kept and recorded as appended
 * members (Req 2.7). A blank dimension cell contributes no tag (it becomes the
 * grouping "Unknown" at slice time, per the grouping step, not here).
 */
function collectDimensions(
  row: ParsedRow,
  columns: MappedColumn[],
  onAppended: (dimensionId: DimensionId, member: string) => void,
): Record<DimensionId, string> {
  const dimensions = {} as Record<DimensionId, string>;
  for (const { header, target } of columns) {
    if (target.kind !== "dimension") continue;
    const value = (row[header] ?? "").trim();
    if (value.length === 0) continue;
    dimensions[target.dimensionId] = value;
    if (value !== UNKNOWN_MEMBER && !SEED_MEMBERS[target.dimensionId].has(value)) {
      onAppended(target.dimensionId, value);
    }
  }
  return dimensions;
}

/**
 * Read the row's volume weight, if a column is mapped to it. Non-numeric or
 * blank weights yield `undefined` (unweighted downstream, per Req 20.4).
 */
function readVolumeWeight(row: ParsedRow, columns: MappedColumn[]): number | undefined {
  for (const { header, target } of columns) {
    if (target.kind === "volumeWeight") {
      return parseNumeric(row[header]);
    }
  }
  return undefined;
}

/** The KPI columns that belong to a given app (or every KPI column in long/file mode). */
function kpiColumnsForApp(
  columns: MappedColumn[],
  app: AppAssignment,
  layout: ColumnMapping["layout"],
): { header: string; kpiId: CanonicalKPIId }[] {
  const out: { header: string; kpiId: CanonicalKPIId }[] = [];
  for (const { header, target } of columns) {
    if (target.kind !== "kpi") continue;
    // In wide layout a KPI column contributes only to its own app (Req 21.7).
    if (layout === "wide") {
      if (target.app === app) out.push({ header, kpiId: target.kpiId });
    } else {
      out.push({ header, kpiId: target.kpiId });
    }
  }
  return out;
}

/**
 * Build one canonical record for a single (row, app) pair. Returns `null` when
 * the pair carries no metric values at all (a wide row blank for this app —
 * Req 21.8), so the caller emits only records that carry data.
 */
function buildRecordForApp(
  row: ParsedRow,
  rowIndex: number,
  app: AppAssignment,
  ctx: RecordBuildContext,
  mapping: ColumnMapping,
  columns: MappedColumn[],
  normalized: ReturnType<typeof normalizeTimestamp> & { ok: true },
  dimensions: Record<DimensionId, string>,
  volumeWeight: number | undefined,
  advisories: DataQualityAdvisory[],
): KPIRecord | null {
  const kpiColumns = kpiColumnsForApp(columns, app, mapping.layout);

  const metrics: Partial<Record<CanonicalKPIId, number>> = {};
  const session: RawSessionFields = {};
  let hasValue = false;

  for (const { header, kpiId } of kpiColumns) {
    const value = parseNumeric(row[header]);
    if (value === undefined) continue;
    const { value: canonical, advisory } = normalizeMappedValue(value, header, kpiId);
    if (advisory) advisories.push(advisory);
    if (ctx.ingestionMode === "Pre_Aggregated") {
      metrics[kpiId] = canonical;
    } else {
      session[kpiId] = canonical;
    }
    hasValue = true;
  }

  // Read a mapped user-identifier column into the session so raw-mode
  // distinct-count KPIs can count distinct users, and the ingestion flow can
  // optionally pseudonymize it (Req 23.1, 28.13). Present only in raw mode.
  if (ctx.ingestionMode === "Raw_Session") {
    const userIdColumn = columns.find((c) => c.target.kind === "userId");
    if (userIdColumn) {
      const raw = (row[userIdColumn.header] ?? "").trim();
      if (raw.length > 0) {
        session.userId = raw;
        hasValue = true;
      }
    }
  }

  // A wide row blank for this app carries no metric — emit nothing (Req 21.8).
  if (!hasValue) return null;

  const record: KPIRecord = {
    id: `${ctx.datasetId}:${rowIndex}:${app}`,
    datasetId: ctx.datasetId,
    app,
    timestampUtc: normalized.timestampUtc,
    sourceUtcOffsetMinutes: normalized.sourceUtcOffsetMinutes,
    bucket: normalized.bucket,
    origin: "file",
    dimensions,
  };

  if (ctx.ingestionMode === "Pre_Aggregated") {
    record.metrics = metrics;
    // Quartile monotonicity is a pre-aggregated check (Req 22.9): raw sessions
    // are monotonic by construction.
    const quartileAdvisory = checkQuartileMonotonicity({ id: record.id, metrics });
    if (quartileAdvisory) advisories.push(quartileAdvisory);
  } else {
    record.session = session;
  }

  if (volumeWeight !== undefined) record.volumeWeight = volumeWeight;
  if (advisories.length > 0) record.advisories = advisories;

  return record;
}

/**
 * Which apps a source row fans out to, given the layout and mapping. In wide
 * layout both apps are candidates (blank-for-one collapses to a single record
 * downstream, Req 21.8); in long layout the row's own app; in file-level the
 * mapping's `fileAppAssignment`.
 *
 * Returns `null` with a reason string when the app cannot be resolved, so the
 * row is rejected rather than silently dropped.
 */
function appsForRow(
  row: ParsedRow,
  mapping: ColumnMapping,
  columns: MappedColumn[],
): readonly AppAssignment[] | { error: string } {
  if (mapping.layout === "wide") {
    return APPS;
  }

  const appColumn = columns.find((c) => c.target.kind === "app");
  if (appColumn) {
    const app = resolveRowApp(row, appColumn.header);
    if (app === null) {
      return { error: `unrecognized app value in column "${appColumn.header}"` };
    }
    return [app];
  }

  if (mapping.fileAppAssignment) {
    return [mapping.fileAppAssignment];
  }

  return {
    error:
      "no app column, no app-qualified columns, and no file-level app assignment",
  };
}

/**
 * Build canonical `KPIRecord`s from a parsed file's rows and a confirmed column
 * mapping (design "Build canonical KPIRecords").
 *
 * Each source row is normalized (timestamp → UTC, values → canonical units) and
 * resolved to one or more app assignments per the mapping's layout, then emitted
 * as one record per app that carries data. Structurally invalid rows (no
 * mappable timestamp) are collected in `rejected` with a reason (Req 26.4);
 * advisory-worthy rows are retained and flagged (Req 22.8). Dimension values not
 * in the seed sets are kept and reported as appended members (Req 2.7).
 *
 * @param rows the parsed source rows (header → cell string).
 * @param mapping the confirmed column mapping (targets, layout, units, app).
 * @param ctx the dataset id and ingestion mode.
 * @returns the built records, rejected rows, and newly appended dimension members.
 */
export function buildRecords(
  rows: readonly ParsedRow[],
  mapping: ColumnMapping,
  ctx: RecordBuildContext,
): RecordBuildResult {
  const columns = mappedColumns(mapping);
  const timestampColumn = columns.find((c) => c.target.kind === "timestamp");

  const records: KPIRecord[] = [];
  const rejected: RejectedRow[] = [];

  // Deduplicate appended members across the whole file (Req 2.7).
  const appended = new Map<DimensionId, Set<string>>();
  const noteAppended = (dimensionId: DimensionId, member: string) => {
    let set = appended.get(dimensionId);
    if (!set) {
      set = new Set();
      appended.set(dimensionId, set);
    }
    set.add(member);
  };

  rows.forEach((row, rowIndex) => {
    if (!timestampColumn) {
      rejected.push({ rowIndex, reason: "no timestamp column is mapped" });
      return;
    }

    const normalized = normalizeTimestamp(row[timestampColumn.header] ?? "");
    if (!normalized.ok) {
      rejected.push({ rowIndex, reason: normalized.reason });
      return;
    }

    const apps = appsForRow(row, mapping, columns);
    if (!Array.isArray(apps)) {
      rejected.push({ rowIndex, reason: (apps as { error: string }).error });
      return;
    }

    // Dimension tags and volume weight are shared across an app fan-out.
    const dimensions = collectDimensions(row, columns, noteAppended);
    const volumeWeight = readVolumeWeight(row, columns);

    let emittedForRow = 0;
    for (const app of apps) {
      // A fresh advisory list per record. Unit-assumption and quartile advisories
      // are appended inside buildRecordForApp; the naive-timestamp advisory
      // (Req 26.2) is owned by the timestamp-normalizer step, not the builder.
      const advisories: DataQualityAdvisory[] = [];
      const record = buildRecordForApp(
        row,
        rowIndex,
        app,
        ctx,
        mapping,
        columns,
        normalized,
        // Each record gets its own copy of the shared dimension map so callers
        // can mutate one record without affecting the other app's record.
        { ...dimensions },
        volumeWeight,
        advisories,
      );
      if (record) {
        records.push(record);
        emittedForRow += 1;
      }
    }

    // A row that resolved to app(s) but carried no metric value for any of them
    // (all cells blank/non-numeric) produces no record; that is legitimate for a
    // wide row blank on both sides, so it is not a rejection.
    void emittedForRow;
  });

  const appendedMembers: AppendedMember[] = [];
  for (const [dimensionId, members] of appended) {
    for (const member of members) {
      appendedMembers.push({ dimensionId, member });
    }
  }

  return { records, rejected, appendedMembers };
}

/**
 * Build the `UNKNOWN_DIMENSION_MEMBER` advisory for a newly appended dimension
 * value (Req 2.7). Exposed so callers surfacing the build result can render a
 * single consolidated advisory per appended member.
 */
export function appendedMemberAdvisory(appended: AppendedMember): DataQualityAdvisory {
  return {
    code: "UNKNOWN_DIMENSION_MEMBER",
    detail:
      `Dimension "${appended.dimensionId}" value "${appended.member}" was not a ` +
      `known member; it was retained and added as a new member.`,
  };
}
