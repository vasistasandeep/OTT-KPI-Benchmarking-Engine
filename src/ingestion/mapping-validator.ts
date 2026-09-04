/**
 * MappingValidator — validates a proposed column mapping before ingestion is
 * allowed to proceed (Req 6.4, 7.8, 7.9, 16.4; design "Column-mapping flow",
 * "Duplicate-KPI validation at (KPI, app) granularity").
 *
 * Three distinct checks gate a mapping, in increasing order of severity from
 * the user's point of view:
 *
 *   1. **No mappable columns** (Req 6.4, 16.4) — the file's schema maps to
 *      *nothing*: not a single column resolves to a KPI or a Dimension. This
 *      is a property of the file itself, not of the user's edits, so it is a
 *      hard *invalid-schema* verdict: the caller must surface the invalid-
 *      schema banner and MUST NOT persist the file's records. Confirmation is
 *      not even offered.
 *
 *   2. **No KPI mapped** (Req 7.8) — the schema is mappable (some column is a
 *      dimension, say) but the user has not mapped any column to a KPI. A
 *      dataset with zero KPIs has nothing to benchmark, so confirmation is
 *      blocked with a message asking for at least one KPI mapping. Unlike the
 *      no-mappable-columns case this is recoverable inside the modal — the user
 *      maps a KPI and re-confirms.
 *
 *   3. **Duplicate `(kpiId, app)` pair** (Req 7.9) — two or more columns map to
 *      the same canonical KPI *for the same app assignment*. Enforcing
 *      uniqueness on the `(kpiId, app)` pair rather than on the KPI alone is
 *      what lets a wide-layout file map `vst_app_a` and `vst_app_b` to the same
 *      KPI under different apps while still rejecting `vst_app_a` +
 *      `startup_time_a` (both → `vst_p50`/App_A), which the engine would have
 *      no defined way to disambiguate. In long and file-level layouts every KPI
 *      column shares one effective app, so this collapses to the plain per-KPI
 *      rule. Each conflict names the KPI, the app, and every offending column.
 *
 * The app assignment of a KPI column is read from the mapping target's optional
 * `app` field (present only in wide layout). Long and file-level columns carry
 * no per-column `app`; they all share the file's single effective app, which we
 * key under a stable sentinel so two long KPI columns for the same KPI still
 * collide.
 *
 * This module is pure: it reads the mapping and returns a verdict. It never
 * mutates its input, touches the DOM, or reads storage. Producing the banner or
 * the modal message from the verdict is the caller's job.
 *
 * Requirements: 6.4, 7.8, 7.9, 16.4.
 */

import type { CanonicalKPIId } from "@/models/ids";
import type { AppAssignment } from "@/models/records";
import type { MappingTarget } from "@/models/config";

/**
 * The set of column assignments a mapping proposes: source header → target.
 *
 * This is exactly the shape of `ColumnMapping.assignments`, extracted as its
 * own alias so a mapping can be validated before a full `ColumnMapping` is
 * assembled (the modal validates on every edit, well before it builds and
 * persists the confirmed mapping).
 */
export type MappingAssignments = Readonly<Record<string, MappingTarget>>;

/**
 * The effective app a KPI column contributes under. Wide-layout columns carry
 * an explicit `App_A` / `App_B`; every other layout shares one file-level app,
 * represented by the `FILE_LEVEL_APP` sentinel so same-KPI columns still
 * collide (Req 7.9; design "(KPI, app) granularity").
 */
export type EffectiveApp = AppAssignment | typeof FILE_LEVEL_APP;

/**
 * Sentinel effective-app for columns with no per-column app qualifier (long and
 * file-level layouts). Kept distinct from `App_A` / `App_B` so a wide column
 * explicitly assigned an app is never conflated with a file-level column.
 */
export const FILE_LEVEL_APP = "__file_level__" as const;

/** The kinds of blocking finding a mapping can carry, most-severe first. */
export type MappingValidationErrorKind = "no_mappable_columns" | "no_kpi_mapped" | "duplicate_kpi_app";

/**
 * A single duplicate `(kpiId, app)` conflict: one KPI mapped by 2+ columns for
 * one effective app (Req 7.9). `app` is `null` when the offending columns carry
 * no per-column qualifier (long / file-level), which the caller renders as the
 * file's single app assignment.
 */
export interface DuplicateKPIAppConflict {
  readonly kpiId: CanonicalKPIId;
  /** The explicit app for wide columns, or `null` for file-level/long columns. */
  readonly app: AppAssignment | null;
  /** Every source header mapped to this `(kpiId, app)` pair — always 2+. */
  readonly columns: readonly string[];
  /** A user-facing description naming the KPI, the app, and the columns. */
  readonly detail: string;
}

/**
 * The validator's verdict. `valid` is `true` only when no blocking finding was
 * raised. When `valid` is `false`, `errors` holds every finding; a single
 * mapping can carry more than one (e.g. several distinct duplicate pairs), and
 * the invalid-schema and no-KPI findings are mutually exclusive with each other
 * (a schema with no mappable columns trivially has no KPI, so only the more
 * specific no-mappable-columns finding is raised).
 */
export interface MappingValidationResult {
  readonly valid: boolean;
  readonly errors: readonly MappingValidationError[];
  /**
   * The duplicate `(kpiId, app)` conflicts, if any, surfaced directly so the
   * modal can annotate the offending columns without re-parsing the messages.
   */
  readonly duplicateConflicts: readonly DuplicateKPIAppConflict[];
}

/** A single blocking finding. */
export interface MappingValidationError {
  readonly kind: MappingValidationErrorKind;
  /** A user-facing message describing the finding. */
  readonly detail: string;
}

/** Human-readable app label for messages; file-level columns read as "the file's app". */
function appLabel(app: AppAssignment | null): string {
  return app === null ? "the file's app assignment" : app;
}

/**
 * Validate a proposed column mapping (Req 6.4, 7.8, 7.9, 16.4).
 *
 * Runs the three gates in severity order and short-circuits the no-mappable-
 * columns gate against the others (an empty schema is reported once, as the
 * invalid-schema finding, not also as a missing-KPI finding). The duplicate
 * gate always runs so every distinct conflict is reported together, letting the
 * user fix them in one pass.
 *
 * @param assignments source header → mapping target (a `ColumnMapping.assignments`).
 * @returns the verdict: `valid`, the list of blocking `errors`, and the
 *   structured `duplicateConflicts` for the modal to annotate columns.
 */
export function validateMapping(assignments: MappingAssignments): MappingValidationResult {
  const entries = Object.entries(assignments);

  const mappableCount = entries.filter(
    ([, target]) => target.kind === "kpi" || target.kind === "dimension",
  ).length;
  const kpiColumns = entries.filter(
    (entry): entry is [string, Extract<MappingTarget, { kind: "kpi" }>] => entry[1].kind === "kpi",
  );

  const errors: MappingValidationError[] = [];

  // Gate 1: no mappable columns at all → invalid schema (Req 6.4, 16.4).
  // This is a property of the file, not the edits; report it alone.
  if (mappableCount === 0) {
    errors.push({
      kind: "no_mappable_columns",
      detail:
        "This file's columns could not be mapped to any KPI or dimension. " +
        "The schema is invalid and its records were not saved.",
    });
    return { valid: false, errors, duplicateConflicts: [] };
  }

  // Gate 2: schema is mappable but no column maps to a KPI (Req 7.8).
  if (kpiColumns.length === 0) {
    errors.push({
      kind: "no_kpi_mapped",
      detail: "Map at least one column to a KPI before confirming.",
    });
  }

  // Gate 3: duplicate (kpiId, app) pairs (Req 7.9). Group KPI columns by their
  // effective (kpiId, app) key; any group with 2+ columns is a conflict.
  const groups = new Map<
    string,
    { kpiId: CanonicalKPIId; app: AppAssignment | null; columns: string[] }
  >();
  for (const [header, target] of kpiColumns) {
    const app = target.app ?? null;
    const key = `${target.kpiId}\u0000${app ?? FILE_LEVEL_APP}`;
    let group = groups.get(key);
    if (!group) {
      group = { kpiId: target.kpiId, app, columns: [] };
      groups.set(key, group);
    }
    group.columns.push(header);
  }

  const duplicateConflicts: DuplicateKPIAppConflict[] = [];
  for (const group of groups.values()) {
    if (group.columns.length < 2) {
      continue;
    }
    const conflict: DuplicateKPIAppConflict = {
      kpiId: group.kpiId,
      app: group.app,
      columns: group.columns,
      detail:
        `KPI "${group.kpiId}" is mapped by ${group.columns.length} columns ` +
        `(${group.columns.join(", ")}) for ${appLabel(group.app)}. ` +
        `Map each KPI at most once per app.`,
    };
    duplicateConflicts.push(conflict);
    errors.push({ kind: "duplicate_kpi_app", detail: conflict.detail });
  }

  return { valid: errors.length === 0, errors, duplicateConflicts };
}
