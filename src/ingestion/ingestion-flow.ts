/**
 * IngestionFlow — the ingestion orchestration that ties the parsed file to the
 * two ingestion modals and, on confirm, to the repository (design "Ingestion
 * Pipeline"; Req 6.5, 7.1–7.9, 21.5, 22.4, 26.2, 28.13).
 *
 * The React components (`IngestionModePrompt`, `ColumnMappingModal`) own no
 * ingestion logic of their own — they render the state this module derives and
 * call back into it. Keeping the derivation here (pure, DOM-free) means the
 * whole ingestion decision path is unit-testable without mounting a component.
 *
 * Three pieces live here:
 *
 *   1. {@link proposeMappingDraft} — from a `ParsedFile`, run the FuzzyMatcher
 *      over every header, feed those results to the LayoutDetector, infer each
 *      KPI column's unit, and produce an editable `MappingDraft` the modal
 *      pre-populates. A cached mapping (from the MappingCache) short-circuits
 *      this so a recurring header set is a one-click confirm (Req 7.7).
 *   2. {@link requiresFileLevelApp} — whether the parsed file carries neither an
 *      app column nor app-qualified KPI columns, in which case the mode prompt
 *      additionally requires a file-level App assignment (Req 21.5).
 *   3. {@link ingestConfirmedMapping} — build canonical records, persist the
 *      mapping, write through the repository (whose `appendRecords` runs the
 *      quota pre-flight internally, Req 27.1/27.2), and set the active dataset.
 *
 * Data residency (Req 28.10, 28.11): the whole ingestion → aggregate → export
 * flow is client-resident by construction. Nothing on this path issues a
 * `fetch`, `XMLHttpRequest`, or WebSocket — parsing, mapping, hashing, and
 * persistence all run against in-memory data and IndexedDB (via the repository),
 * so ingested record content, telemetry, and usage metrics never leave the
 * device. The optional userId hashing below uses the client-resident Web Crypto
 * SubtleCrypto primitive rather than any remote service.
 *
 * User identifiers (Req 28.12): a mapped `userId` feeds the distinct-count
 * aggregation only. It is never written into a display or an export — the CSV
 * builders render aggregated KPI results, never raw record fields, so no
 * user-identifier column is ever emitted.
 *
 * Requirements: 6.5, 7.1, 7.5, 21.5, 22.4, 26.2, 28.10, 28.11, 28.12, 28.13.
 */

import type {
  AppAssignment,
  CanonicalKPIId,
  ColumnMapping,
  Dataset,
  DatasetMeta,
  DimensionId,
  IngestionMode,
  KPIRecord,
  MappingTarget,
  SourceLayout,
} from "@/models";
import { getKPI } from "@/registry";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";
import { detectLayout, type ColumnMatch } from "./layout-detector";
import type { ParsedFile } from "./file-parser";
import { matchHeader } from "./fuzzy-matcher";
import { DIMENSION_REGISTRY } from "@/registry/dimensions";
import { inferUnit } from "./unit-normalizer";
import { buildRecords, type RecordBuildResult } from "./record-builder";
import { persistMapping } from "./mapping-cache";
import { computeHeaderSetHash } from "./mapping-cache";
import { normalizeTimestamp } from "./timestamp-normalizer";

/**
 * A single source column's editable mapping state, as the modal renders it.
 *
 * `target` is the confirmable per-column decision; `unit` is the resolved
 * source-unit token (only meaningful when `target.kind === "kpi"`); `assumedUnit`
 * marks a column whose unit could not be inferred so the modal can surface the
 * assumed-unit advisory (Req 22.6); `score` and `proposed` support showing the
 * fuzzy proposal separately from what the user has since chosen.
 */
export interface ColumnDraft {
  /** The source header exactly as parsed. */
  header: string;
  /** Up to five non-empty sample values for the preview (Req 7.1). */
  samples: string[];
  /** The current (editable) mapping target for the column. */
  target: MappingTarget;
  /** Resolved source-unit token for a KPI column, else undefined. */
  unit?: string;
  /** True when no unit token could be inferred and the canonical unit was assumed. */
  assumedUnit: boolean;
  /** Best fuzzy score in [0,1] for the auto proposal (0 when unmapped). */
  score: number;
  /** True when this column is a timestamp whose values carry no UTC offset (Req 26.2). */
  naiveTimestamp: boolean;
}

/**
 * The editable mapping state the ColumnMappingModal renders and mutates before
 * confirmation. Assembled by {@link proposeMappingDraft} from fuzzy matching (or
 * a cached mapping) and handed back to {@link buildConfirmedMapping} on confirm.
 */
export interface MappingDraft {
  headers: string[];
  columns: ColumnDraft[];
  /** Detected-or-cached layout default; the modal exposes it as a toggle (Req 21.3). */
  layout: SourceLayout;
  /** True when neither an app column nor app-qualified columns exist (Req 21.5). */
  requiresFileLevelApp: boolean;
  /** A user-facing layout ambiguity to surface, if any (Req 21.4). */
  layoutAmbiguity?: string;
  /** True when the draft was pre-populated from a cached mapping (Req 7.7). */
  fromCache: boolean;
}

/** Detect the naive-timestamp flag for a column from its sample values (Req 26.2). */
function hasNaiveTimestamp(samples: readonly string[]): boolean {
  if (samples.length === 0) return false;
  // A column is flagged when at least one sample parses as a timestamp that
  // carries no explicit UTC offset (the normalizer sets offsetAssumed).
  return samples.some((s) => {
    const r = normalizeTimestamp(s);
    return r.ok && r.offsetAssumed;
  });
}

/**
 * Recognize a structural column (timestamp, app, volume weight, user id) from
 * its header name. The FuzzyMatcher only scores KPI and dimension candidates,
 * so without this a realistic file's `date` and `app` columns would arrive
 * unmapped and the row builder would reject every row for lack of a timestamp.
 *
 * Matching is deliberately conservative — a small set of well-known tokens per
 * structural kind — and it is only a *default*: the modal lets the user
 * override any column (Req 7.5). A dimension whose name legitimately contains
 * one of these tokens is not at risk because the fuzzy dimension match is
 * preferred when it clears the auto-map threshold; structural detection only
 * fills columns the fuzzy matcher left unmapped.
 */
function detectStructuralTarget(header: string): MappingTarget | null {
  const norm = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const TIMESTAMP = new Set(["date", "day", "time", "timestamp", "datetime", "date_time", "ts", "hour", "event_time", "event_timestamp"]);
  const APP = new Set(["app", "application", "variant", "app_assignment", "app_id", "app_name"]);
  const VOLUME = new Set(["volume", "weight", "volume_weight", "sessions", "session_count", "count", "n", "sample_size", "records"]);
  const USER = new Set(["user", "user_id", "userid", "uid", "viewer_id", "device_id", "subscriber_id"]);
  if (TIMESTAMP.has(norm)) return { kind: "timestamp" };
  if (APP.has(norm)) return { kind: "app" };
  if (VOLUME.has(norm)) return { kind: "volumeWeight" };
  if (USER.has(norm)) return { kind: "userId" };

  // Dimensions carry verbose display names ("Platform / Form Factor") that a
  // short header ("platform") rarely clears the fuzzy threshold against, and the
  // registry seeds no dimension aliases. Recognize the dimension by its stable
  // id or a well-known short token so a plain `platform` / `cdn` / `network`
  // header defaults to its dimension (still overridable in the modal, Req 7.5).
  const DIM_TOKENS: Record<string, DimensionId> = {
    platform: "platform",
    form_factor: "platform",
    device: "platform",
    network: "network",
    isp: "network",
    connection: "network",
    cdn: "cdn",
    cdn_provider: "cdn",
    geography: "geography",
    geo: "geography",
    country: "geography",
    region: "geography",
    market: "geography",
    stream_type: "streamType",
    streamtype: "streamType",
    content_type: "streamType",
  };
  const dimId = DIM_TOKENS[norm] ?? DIMENSION_REGISTRY.find((d) => d.id.toLowerCase() === norm)?.id;
  if (dimId) return { kind: "dimension", dimensionId: dimId };

  return null;
}

/**
 * Turn a single header's fuzzy-match result into an initial `MappingTarget`.
 * A KPI hit carries its inferred wide-layout app qualifier when the matcher
 * stripped one; a below-threshold header falls back to structural detection
 * (timestamp / app / volume / userId), else `unmapped` (Req 7.3, 7.5).
 */
function toInitialTarget(header: string): {
  target: MappingTarget;
  score: number;
  kpiApp?: AppAssignment;
} {
  const result = matchHeader(header);
  if (result.target === null) {
    const structural = detectStructuralTarget(header);
    if (structural) return { target: structural, score: result.score };
  }
  if (result.target === null) {
    return { target: { kind: "unmapped" }, score: result.score };
  }
  if (result.target.kind === "kpi" && result.target.kpiId) {
    const target: MappingTarget = { kind: "kpi", kpiId: result.target.kpiId };
    if (result.appAssignment) target.app = result.appAssignment;
    return { target, score: result.score, kpiApp: result.appAssignment };
  }
  if (result.target.kind === "dimension" && result.target.dimensionId) {
    return {
      target: { kind: "dimension", dimensionId: result.target.dimensionId },
      score: result.score,
    };
  }
  return { target: { kind: "unmapped" }, score: result.score };
}

/** Resolve the source-unit token and assumed-flag for a KPI-mapped column (Req 22.3, 22.6). */
export function resolveColumnUnit(
  header: string,
  kpiId: CanonicalKPIId,
): { unit: string; assumed: boolean } {
  const kpi = getKPI(kpiId);
  if (!kpi) return { unit: "", assumed: true };
  const inferred = inferUnit(header, kpi.id);
  if (inferred) return { unit: inferred.token, assumed: false };
  return { unit: kpi.canonicalUnit, assumed: true };
}

/**
 * Build the editable `MappingDraft` for a parsed file (Req 7.1, 7.2, 21.3, 22.4).
 *
 * Runs fuzzy matching over every header, hands the KPI/app-column results to the
 * LayoutDetector for the layout default and wide grouping, then resolves each
 * KPI column's unit. When a `cached` mapping is supplied (from the MappingCache),
 * its per-column decisions win over fresh fuzzy matching and `fromCache` is set.
 */
export function proposeMappingDraft(
  parsed: ParsedFile,
  cached?: ColumnMapping,
): MappingDraft {
  // First pass: an initial target per header (fuzzy or from cache).
  const initial = new Map<string, { target: MappingTarget; score: number }>();
  for (const header of parsed.headers) {
    if (cached && cached.assignments[header]) {
      initial.set(header, { target: cached.assignments[header], score: 1 });
    } else {
      const { target, score } = toInitialTarget(header);
      initial.set(header, { target, score });
    }
  }

  // Feed KPI / app-column results into the layout detector.
  const columnMatches: ColumnMatch[] = parsed.headers.map((header) => {
    const t = initial.get(header)!.target;
    return {
      header,
      kpiId: t.kind === "kpi" ? t.kpiId : null,
      isAppColumn: t.kind === "app",
    };
  });
  const detection = detectLayout(columnMatches);

  // The detected layout is the default unless a cached mapping fixed one (Req 21.3, 7.7).
  const layout: SourceLayout = cached?.layout ?? detection.layout;

  // Apply the detector's wide app qualifiers onto KPI targets (only in wide layout),
  // so a wide file arrives with `app` pre-filled per column.
  if (layout === "wide" && !cached) {
    for (const group of detection.wideGroups) {
      for (const col of group.columns) {
        const entry = initial.get(col.header);
        if (entry && entry.target.kind === "kpi") {
          entry.target = { ...entry.target, app: col.app };
        }
      }
    }
  }

  const columns: ColumnDraft[] = parsed.headers.map((header) => {
    const { target, score } = initial.get(header)!;
    const samples = parsed.sampleValues[header] ?? [];
    const draft: ColumnDraft = {
      header,
      samples,
      target,
      assumedUnit: false,
      score,
      naiveTimestamp: target.kind === "timestamp" && hasNaiveTimestamp(samples),
    };
    if (target.kind === "kpi") {
      const cachedUnit = cached?.units[header];
      if (cachedUnit) {
        draft.unit = cachedUnit;
        draft.assumedUnit = false;
      } else {
        const { unit, assumed } = resolveColumnUnit(header, target.kpiId);
        draft.unit = unit;
        draft.assumedUnit = assumed;
      }
    }
    return draft;
  });

  return {
    headers: [...parsed.headers],
    columns,
    layout,
    requiresFileLevelApp: requiresFileLevelApp(columns, layout),
    layoutAmbiguity: detection.ambiguity?.detail,
    fromCache: cached !== undefined,
  };
}

/**
 * Whether the file needs a user-supplied file-level App assignment (Req 21.5):
 * true when the layout is not wide, no column is mapped as the app column, and
 * no KPI column carries a per-column app qualifier.
 */
export function requiresFileLevelApp(
  columns: readonly ColumnDraft[],
  layout: SourceLayout,
): boolean {
  if (layout === "wide") return false;
  const hasAppColumn = columns.some((c) => c.target.kind === "app");
  if (hasAppColumn) return false;
  const hasQualifiedKpi = columns.some(
    (c) => c.target.kind === "kpi" && c.target.app !== undefined,
  );
  return !hasQualifiedKpi;
}

/**
 * Assemble a confirmed {@link ColumnMapping} from the editable draft, the chosen
 * ingestion mode, and (when required) the file-level app assignment.
 *
 * The unit map only records KPI columns; the `fileAppAssignment` is set only
 * when the layout has no per-row / per-column app source (Req 21.5).
 */
export function buildConfirmedMapping(
  draft: MappingDraft,
  ingestionMode: IngestionMode,
  fileAppAssignment: AppAssignment | undefined,
): ColumnMapping {
  const assignments: Record<string, MappingTarget> = {};
  const units: Record<string, string> = {};
  for (const col of draft.columns) {
    assignments[col.header] = col.target;
    if (col.target.kind === "kpi" && col.unit) {
      units[col.header] = col.unit;
    }
  }

  const mapping: ColumnMapping = {
    headerSetHash: computeHeaderSetHash(draft.headers),
    headers: [...draft.headers],
    assignments,
    units,
    layout: draft.layout,
    ingestionMode,
  };

  if (requiresFileLevelApp(draft.columns, draft.layout) && fileAppAssignment) {
    mapping.fileAppAssignment = fileAppAssignment;
  }

  return mapping;
}

/** Options controlling how a confirmed mapping is turned into a stored dataset. */
export interface IngestOptions {
  /** The dataset id to write under. */
  datasetId: string;
  /** Unique dataset name (Req 19.7). */
  datasetName: string;
  /** App_A display label (Req 19.5). */
  appALabel: string;
  /** App_B display label (Req 19.5). */
  appBLabel: string;
  /**
   * When set, mapped userId values are replaced with a salted SHA-256 hash at
   * ingestion (Req 28.13). Applied to every record's `session.userId`.
   */
  hashUserIds?: boolean;
  /**
   * Per-dataset salt for the userId hash; defaults to the dataset id when
   * omitted. The resolved salt is persisted on the stored dataset's
   * {@link DatasetMeta.userIdSalt} so the hashing is reproducible.
   */
  userIdSalt?: string;
}

/** The result of a successful ingestion. */
export interface IngestResult {
  /** The meta of the dataset that was written and set active. */
  dataset: DatasetMeta;
  /** The build result (rejected rows, appended dimension members) for advisories. */
  build: RecordBuildResult;
  /** The header-set hash the mapping was persisted under (Req 7.6). */
  headerSetHash: string;
}

/**
 * A per-column salted SHA-256 hash for userId pseudonymization (Req 28.13).
 *
 * The identifier is concatenated with the per-dataset salt (separated by a NUL
 * so `salt+value` can never collide with a different `salt`/`value` split) and
 * digested with the Web Crypto SubtleCrypto SHA-256 primitive — the same
 * client-resident API in the browser and under the test runner, so no external
 * service ever sees an identifier (Req 28.10, 28.11).
 *
 * The digest is deterministic: the same identifier under the same salt always
 * yields the same hash, so a user collapses to exactly one distinct-count
 * bucket for the dataset's lifetime while the raw identifier never reaches
 * storage, a display, or an export. Async because `subtle.digest` returns a
 * promise; callers thread the await through the ingestion path.
 */
export async function saltedHash(value: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}\u0000${value}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `u_${hex}`;
}

/**
 * Replace each record's mapped `session.userId` with its salted SHA-256 hash
 * under the given per-dataset salt (Req 28.13). Hashing runs entirely on the
 * client; the raw identifiers are overwritten in place before the records are
 * ever persisted.
 */
async function pseudonymizeUserIds(records: KPIRecord[], salt: string): Promise<void> {
  for (const record of records) {
    const uid = record.session?.userId;
    if (typeof uid === "string" && uid.length > 0) {
      record.session!.userId = await saltedHash(uid, salt);
    }
  }
}

/**
 * Ingest a confirmed mapping into a stored, active dataset (design "Ingestion
 * Pipeline"; Req 7.6, 21.5, 27.1).
 *
 * Steps, in order:
 *   1. build canonical records from the parsed rows and the confirmed mapping;
 *   2. optionally pseudonymize mapped userId values (Req 28.13);
 *   3. persist the mapping keyed by its header-set hash (Req 7.6);
 *   4. write the dataset through the repository — `appendRecords` runs the quota
 *      pre-flight and throws `QuotaPreflightError` when the write would not fit,
 *      leaving nothing persisted (Req 27.1, 27.2);
 *   5. set the new dataset active so the dashboard recomputes.
 *
 * The mapping is persisted before the write so a recurring header set is cached
 * even if this particular write is later rejected for quota; the caller surfaces
 * any thrown `QuotaPreflightError` as the storage-shortfall banner.
 */
export async function ingestConfirmedMapping(
  repository: KPIDataRepository,
  parsed: ParsedFile,
  mapping: ColumnMapping,
  options: IngestOptions,
): Promise<IngestResult> {
  const build = buildRecords(parsed.rows, mapping, {
    datasetId: options.datasetId,
    ingestionMode: mapping.ingestionMode,
  });

  // When requested, replace mapped userId values with a salted SHA-256 hash
  // using a per-dataset salt (defaults to the dataset id) that is persisted with
  // the dataset below, so the pseudonymization is reproducible and distinct
  // counts stay stable for the dataset's lifetime (Req 28.13).
  const userIdSalt = options.hashUserIds
    ? options.userIdSalt ?? options.datasetId
    : undefined;
  if (userIdSalt !== undefined) {
    await pseudonymizeUserIds(build.records, userIdSalt);
  }

  const headerSetHash = await persistMapping(repository, mapping);

  const dataset: Dataset = {
    id: options.datasetId,
    name: options.datasetName,
    createdAt: new Date().toISOString(),
    appALabel: options.appALabel,
    appBLabel: options.appBLabel,
    recordCount: build.records.length,
    sourceType: mapping.ingestionMode === "Raw_Session" ? "Raw" : "Aggregated",
    ingestionMode: mapping.ingestionMode,
    // Persist the salt with the dataset so the SHA-256 pseudonymization stays
    // reproducible for its lifetime (Req 28.13); omitted when hashing was off.
    ...(userIdSalt !== undefined ? { userIdSalt } : {}),
    records: [],
  };

  // Save the dataset shell, then write records via the chunked, quota-guarded
  // append so a large session log triggers the pre-flight (Req 27.1).
  await repository.saveDataset(dataset);
  await repository.appendRecords(options.datasetId, build.records);
  await repository.setActiveDatasetId(options.datasetId);

  const { records: _records, ...meta } = dataset;
  void _records;
  return { dataset: { ...meta, recordCount: build.records.length }, build, headerSetHash };
}

/**
 * A `DimensionId` union guard used by the modal to offer dimension targets; the
 * registry owns the list, re-exported through `@/registry` — this alias keeps
 * the modal's import surface small.
 */
export type { DimensionId };
