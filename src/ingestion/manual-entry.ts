/**
 * ManualEntry — the pure, DOM-free logic behind the ManualEntryForm
 * (design "Manual entry (Req 8)"; Req 8.1, 8.2, 8.3, 27.8, 27.9, 27.10, 27.11).
 *
 * The React component (`ManualEntryForm`) owns no ingestion logic of its own:
 * it renders the state this module derives and calls back into it. Keeping the
 * derivation here (pure, storage-free) makes the whole manual-entry decision
 * path unit-testable without mounting a component and reuses the same
 * `UnitNormalizer` + `TimestampNormalizer` the file pipeline and mock seeder use,
 * so every manually entered value lands in its KPI's canonical unit and every
 * date is normalized to UTC exactly like a file-ingested record.
 *
 * A manual entry is always **pre-aggregated**: the user types one value per KPI
 * per app for a chosen date and dimension selection (Req 8.1). Submitting turns
 * the dual-entry rows into canonical `KPIRecord`s stamped `origin: "manual"`
 * (Req 8.2), which are the only records the lifecycle later allows to be edited
 * or deleted (Req 27.8, 27.9).
 *
 * Per-field validation (Req 8.3): a KPI cell that carries a non-numeric value is
 * flagged invalid and contributes no metric — the rest of the row is still
 * submitted. A blank cell is simply "no value for that app/KPI", not an error.
 *
 * Requirements: 8.1, 8.2, 8.3, 27.8, 27.9, 27.10, 27.11.
 */

import type {
  AppAssignment,
  CanonicalKPIId,
  DataQualityAdvisory,
  DimensionId,
  KPIRecord,
} from "@/models";
import { getKPI } from "@/registry";
import { normalizeMappedValue } from "./unit-normalizer";
import { normalizeTimestamp } from "./timestamp-normalizer";

/**
 * A single KPI cell in the dual-entry table: the raw text the user typed for
 * each app, plus the source unit the values are entered in (defaults to the
 * KPI's canonical unit). Empty strings mean "no value for that app".
 */
export interface ManualEntryCell {
  kpiId: CanonicalKPIId;
  /** Raw text entered for App_A (may be empty). */
  appAValue: string;
  /** Raw text entered for App_B (may be empty). */
  appBValue: string;
  /** The unit the entered values are expressed in; defaults to the canonical unit. */
  unit?: string;
}

/**
 * The complete manual-entry draft the form collects before submission: the
 * shared date and dimension selections, plus one cell per KPI (Req 8.1).
 */
export interface ManualEntryDraft {
  /** The date the values apply to (a bare `YYYY-MM-DD` or any parseable timestamp). */
  date: string;
  /** Dimension selections shared by every value in the draft (Req 8.1). */
  dimensions: Partial<Record<DimensionId, string>>;
  /** One cell per KPI the user chose to enter. */
  cells: ManualEntryCell[];
}

/**
 * A single per-field validation problem: which KPI, which app, and why.
 * Surfaced by the form to flag the offending input without discarding the row
 * (Req 8.3).
 */
export interface FieldError {
  kpiId: CanonicalKPIId;
  app: AppAssignment;
  reason: string;
}

/** The outcome of validating a manual-entry draft against its per-field rules. */
export interface ManualEntryValidation {
  /** True when the draft carries no invalid field and at least one value. */
  valid: boolean;
  /** Per-field problems, one per invalid (non-numeric) cell value (Req 8.3). */
  fieldErrors: FieldError[];
  /** True when the date could not be parsed. */
  dateError?: string;
  /** True when no value was entered for any app (nothing to submit). */
  empty: boolean;
}

/** A single canonical value ready to stamp onto a record, keyed by KPI. */
interface ResolvedMetric {
  kpiId: CanonicalKPIId;
  /** Canonical-unit value. */
  value: number;
  advisory?: DataQualityAdvisory;
}

/**
 * Classify one raw cell string for a single app. Returns:
 *   - `{ kind: "blank" }` when the text is empty/whitespace (no value, no error);
 *   - `{ kind: "invalid" }` when the text is present but not a finite number
 *     (flagged, not submitted — Req 8.3);
 *   - `{ kind: "value", raw }` with the parsed number otherwise.
 */
function classifyCellValue(
  text: string,
): { kind: "blank" } | { kind: "invalid" } | { kind: "value"; raw: number } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "blank" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { kind: "invalid" };
  return { kind: "value", raw: n };
}

/**
 * Validate a manual-entry draft (Req 8.3). Flags every non-numeric KPI cell as a
 * per-field error and reports whether the date is parseable and whether anything
 * at all was entered. A draft is `valid` when the date parses, no field is
 * invalid, and at least one numeric value is present.
 */
export function validateManualEntry(draft: ManualEntryDraft): ManualEntryValidation {
  const fieldErrors: FieldError[] = [];
  let hasValue = false;

  for (const cell of draft.cells) {
    const a = classifyCellValue(cell.appAValue);
    const b = classifyCellValue(cell.appBValue);
    if (a.kind === "invalid") {
      fieldErrors.push({ kpiId: cell.kpiId, app: "App_A", reason: "not a number" });
    } else if (a.kind === "value") {
      hasValue = true;
    }
    if (b.kind === "invalid") {
      fieldErrors.push({ kpiId: cell.kpiId, app: "App_B", reason: "not a number" });
    } else if (b.kind === "value") {
      hasValue = true;
    }
  }

  const normalized = normalizeTimestamp(draft.date);
  const dateError = normalized.ok ? undefined : normalized.reason;

  return {
    valid: fieldErrors.length === 0 && dateError === undefined && hasValue,
    fieldErrors,
    dateError,
    empty: !hasValue,
  };
}

/** Resolve the canonical metrics for one app from the draft's valid cells. */
function resolveMetricsForApp(
  draft: ManualEntryDraft,
  app: AppAssignment,
): ResolvedMetric[] {
  const out: ResolvedMetric[] = [];
  for (const cell of draft.cells) {
    const text = app === "App_A" ? cell.appAValue : cell.appBValue;
    const classified = classifyCellValue(text);
    // Blank and invalid cells contribute no metric (Req 8.3); only submit valid.
    if (classified.kind !== "value") continue;
    const kpi = getKPI(cell.kpiId);
    if (!kpi) continue;
    // Normalize the entered value to the KPI's canonical unit. The unit token
    // is embedded in a synthetic source header so `normalizeMappedValue` infers
    // it exactly as it would for a file column (Req 22.5); an unknown token
    // falls back to the canonical unit with an ASSUMED_UNIT advisory (Req 22.6).
    const sourceHeader = `${cell.kpiId}_${cell.unit ?? kpi.canonicalUnit}`;
    const { value, advisory } = normalizeMappedValue(
      classified.raw,
      sourceHeader,
      cell.kpiId,
    );
    out.push({ kpiId: cell.kpiId, value, advisory });
  }
  return out;
}

/** Collect the dimension tags from the draft, dropping blank selections. */
function collectDimensions(
  draft: ManualEntryDraft,
): Record<DimensionId, string> {
  const dimensions = {} as Record<DimensionId, string>;
  for (const [dimId, member] of Object.entries(draft.dimensions)) {
    if (typeof member === "string" && member.trim().length > 0) {
      dimensions[dimId as DimensionId] = member.trim();
    }
  }
  return dimensions;
}

/** Context the record builder needs beyond the draft itself. */
export interface ManualRecordContext {
  /** The dataset the records belong to. */
  datasetId: string;
  /**
   * A stable id seed for a *new* submission, so the two per-app records get
   * deterministic, non-colliding ids. Defaults to a timestamp-based id.
   */
  idSeed?: string;
}

/** The outcome of building canonical records from a validated manual-entry draft. */
export interface ManualEntryBuildResult {
  /** One canonical record per app that carried at least one valid value (Req 8.2). */
  records: KPIRecord[];
  /** Assumed-unit advisories collected across the built records (Req 22.6). */
  advisories: DataQualityAdvisory[];
}

/**
 * Build canonical `KPIRecord`s from a validated manual-entry draft (Req 8.2).
 *
 * Produces one `origin: "manual"`, pre-aggregated record per app that carries at
 * least one valid value, sharing the draft's normalized UTC timestamp and
 * dimension selections. An app with no valid value yields no record (so a
 * one-sided entry submits a single record). Values are already normalized to
 * each KPI's canonical unit.
 *
 * Callers must validate the draft first; a draft whose date does not parse
 * yields an empty result rather than throwing.
 */
export function buildManualRecords(
  draft: ManualEntryDraft,
  ctx: ManualRecordContext,
): ManualEntryBuildResult {
  const normalized = normalizeTimestamp(draft.date);
  if (!normalized.ok) return { records: [], advisories: [] };

  const dimensions = collectDimensions(draft);
  const seed = ctx.idSeed ?? `manual:${Date.now()}`;
  const advisories: DataQualityAdvisory[] = [];
  const records: KPIRecord[] = [];

  for (const app of ["App_A", "App_B"] as const) {
    const metrics = resolveMetricsForApp(draft, app);
    if (metrics.length === 0) continue;

    const metricMap: Partial<Record<CanonicalKPIId, number>> = {};
    const recordAdvisories: DataQualityAdvisory[] = [];
    for (const m of metrics) {
      metricMap[m.kpiId] = m.value;
      if (m.advisory) {
        recordAdvisories.push(m.advisory);
        advisories.push(m.advisory);
      }
    }

    const record: KPIRecord = {
      id: `${ctx.datasetId}:${seed}:${app}`,
      datasetId: ctx.datasetId,
      app,
      timestampUtc: normalized.timestampUtc,
      sourceUtcOffsetMinutes: normalized.sourceUtcOffsetMinutes,
      bucket: normalized.bucket,
      origin: "manual",
      dimensions: { ...dimensions },
      metrics: metricMap,
      ingestedGranularity: normalized.dateOnly ? "day" : "hour",
    };
    if (recordAdvisories.length > 0) record.advisories = recordAdvisories;
    records.push(record);
  }

  return { records, advisories };
}

/**
 * Re-normalize an edited manual row and write it back onto its existing record,
 * **preserving the record `id`** so an edit updates in place and never
 * duplicates (Req 27.8; design "Edit reopens the row … written back via
 * updateRecord — preserving the record id").
 *
 * Only the mutable fields a manual edit can touch are rewritten: the timestamp
 * (and its derived bucket / offset), the dimension selections, and the per-KPI
 * metric values for this record's single app. Everything else on the record —
 * its `id`, `datasetId`, `app`, and `origin` — is carried through unchanged.
 *
 * Returns `null` when the edited date does not parse, so the caller can keep the
 * form open and surface the date error rather than persist an invalid record.
 */
export function applyManualEdit(
  original: KPIRecord,
  draft: ManualEntryDraft,
): KPIRecord | null {
  const normalized = normalizeTimestamp(draft.date);
  if (!normalized.ok) return null;

  const metrics = resolveMetricsForApp(draft, original.app);
  const metricMap: Partial<Record<CanonicalKPIId, number>> = {};
  const advisories: DataQualityAdvisory[] = [];
  for (const m of metrics) {
    metricMap[m.kpiId] = m.value;
    if (m.advisory) advisories.push(m.advisory);
  }

  const updated: KPIRecord = {
    ...original,
    timestampUtc: normalized.timestampUtc,
    sourceUtcOffsetMinutes: normalized.sourceUtcOffsetMinutes,
    bucket: normalized.bucket,
    dimensions: collectDimensions(draft),
    metrics: metricMap,
    ingestedGranularity: normalized.dateOnly ? "day" : "hour",
  };
  if (advisories.length > 0) {
    updated.advisories = advisories;
  } else {
    delete updated.advisories;
  }
  return updated;
}

/**
 * Whether a record may be edited or deleted through the manual-entry lifecycle:
 * only records with `origin: "manual"` (Req 27.8, 27.9). File-ingested and
 * mock-seeded rows are read-only, because editing them would silently diverge
 * the dataset from its source.
 */
export function isEditable(record: Pick<KPIRecord, "origin">): boolean {
  return record.origin === "manual";
}

/**
 * Reconstruct an editable draft from an existing manual record so the form can
 * reopen it (design "Edit reopens the row in the same validated form"). Metric
 * values are shown in the KPI's canonical unit (the unit they are stored in), so
 * the draft's cell unit is the canonical unit and no conversion is needed on
 * open; re-normalization on save is therefore a no-op unless the user changes
 * the unit.
 */
export function draftFromRecord(record: KPIRecord): ManualEntryDraft {
  const cells: ManualEntryCell[] = [];
  const metrics = record.metrics ?? {};
  for (const [kpiId, value] of Object.entries(metrics)) {
    if (typeof value !== "number") continue;
    const kpi = getKPI(kpiId as CanonicalKPIId);
    const unit = kpi?.canonicalUnit;
    const text = String(value);
    cells.push({
      kpiId: kpiId as CanonicalKPIId,
      appAValue: record.app === "App_A" ? text : "",
      appBValue: record.app === "App_B" ? text : "",
      unit,
    });
  }
  return {
    date: record.bucket.dayUtc,
    dimensions: { ...record.dimensions },
    cells,
  };
}
