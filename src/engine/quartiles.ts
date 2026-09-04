/**
 * Content-completion quartile logic — the authoritative home for both the
 * raw-mode quartile rates and the pre-aggregated funnel-monotonicity check.
 *
 * The completion quartiles form a funnel: a session that reached 75% necessarily
 * reached 50% and 25%, so for any group the computed rates must satisfy
 *
 *   completion(25%) >= completion(50%) >= completion(75%) >= completion(100%)
 *
 * There are two ingestion modes, handled here:
 *
 * - **Raw mode** ({@link completionQuartileRates}). Each quartile rate counts
 *   the sessions with `quartileReached >= q` over the same denominator (the
 *   number of sessions started), and the counted sets are nested, so the rates
 *   are monotonic non-increasing *by construction*. With no sessions every
 *   quartile is `NO_DATA` (Req 5.5, 16.1). This is the single source of truth
 *   for the raw formula; `raw-mode.ts` re-exports it so its own coverage-matrix
 *   surface stays intact (task 6.10 seeded a self-contained copy there).
 *
 * - **Pre-aggregated mode** ({@link checkQuartileMonotonicity}). Upstream
 *   summaries can arrive with quartile values that violate the funnel ordering
 *   (upstream bugs, mismatched denominators, quartiles computed over different
 *   populations). A record carrying two or more quartile values is checked; a
 *   violation raises a `NON_MONOTONIC_QUARTILES` advisory naming the record and
 *   the offending pair. The record is **retained and still aggregated**
 *   (Req 22.8) — discarding data because it looks wrong would silently change
 *   the totals, which is worse than flagging it (Req 22.9).
 *
 * All functions are pure: no mutation of inputs, no DOM, no storage.
 *
 * Requirements: 1.4, 22.8, 22.9 (and 5.5 / 16.1 for the empty-slice sentinel).
 */

import { NO_DATA } from "@/models/sentinels";
import type { Numeric } from "@/models/sentinels";
import type {
  CanonicalKPIId,
  DataQualityAdvisory,
  RawSessionFields,
} from "@/models";

/** The four completion quartiles, in funnel order (descending inclusiveness). */
export const QUARTILES = [25, 50, 75, 100] as const;

/** A completion-quartile threshold. */
export type Quartile = (typeof QUARTILES)[number];

/** The `CanonicalKPIId` carrying each quartile's pre-aggregated value. */
const KPI_BY_QUARTILE: Record<Quartile, CanonicalKPIId> = {
  25: "content_completion_25",
  50: "content_completion_50",
  75: "content_completion_75",
  100: "content_completion_100",
};

/** Round a finite number to 2 decimal places (percentage/rate presentation). */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Read a numeric field, treating a missing/undefined/non-finite value as 0. */
function num(session: RawSessionFields, field: keyof RawSessionFields): number {
  const v = session[field as string];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// Raw mode — authoritative rate(q)
// ---------------------------------------------------------------------------

/**
 * Completion-quartile rates over a group's valid sessions:
 *
 *   rate(q) = 100 * count(quartileReached >= q) / count(sessions started)
 *
 * for each `q` in {25, 50, 75, 100}. "Sessions started" is the number of valid
 * sessions in the group (each represents one started playback); callers reject
 * missing / non-numeric / negative rows first (Req 5.7). A session's furthest
 * quartile is nested — reaching 75% implies 25% and 50% — so the rates are
 * monotonic non-increasing by construction (`rate(25) >= rate(50) >= rate(75)
 * >= rate(100)`) and raw mode never triggers the monotonicity advisory.
 *
 * With no sessions every quartile is `NO_DATA` (Req 5.5, 16.1).
 *
 * @param sessions the valid sessions of the group.
 * @returns a record keyed by quartile threshold, each a percentage rounded to
 *   2 decimals, or `NO_DATA` for all four when the group is empty.
 */
export function completionQuartileRates(
  sessions: readonly RawSessionFields[],
): Record<Quartile, Numeric> {
  if (sessions.length === 0) {
    return { 25: NO_DATA, 50: NO_DATA, 75: NO_DATA, 100: NO_DATA };
  }

  const counts: Record<Quartile, number> = { 25: 0, 50: 0, 75: 0, 100: 0 };
  for (const s of sessions) {
    const reached = num(s, "quartileReached");
    for (const q of QUARTILES) {
      if (reached >= q) {
        counts[q] += 1;
      }
    }
  }

  const started = sessions.length;
  return {
    25: round2((100 * counts[25]) / started),
    50: round2((100 * counts[50]) / started),
    75: round2((100 * counts[75]) / started),
    100: round2((100 * counts[100]) / started),
  };
}

// ---------------------------------------------------------------------------
// Pre-aggregated mode — funnel monotonicity check (Req 22.8, 22.9)
// ---------------------------------------------------------------------------

/**
 * A single ordering violation between two adjacent-in-value quartiles: the
 * lower quartile's rate is *less than* the higher quartile's rate, which is
 * impossible for a real funnel.
 */
export interface QuartileViolation {
  /** The lower quartile whose value should have been the larger of the pair. */
  lower: Quartile;
  /** The higher quartile whose value exceeded it. */
  higher: Quartile;
  /** The offending value at `lower`. */
  lowerValue: number;
  /** The offending value at `higher`. */
  higherValue: number;
}

/**
 * The pre-aggregated quartile values carried by a record, keyed by threshold.
 * Any subset may be present; the check only considers quartiles that carry a
 * finite numeric value.
 */
export type QuartileValues = Partial<Record<Quartile, number>>;

/**
 * Read a record's pre-aggregated quartile values from its `metrics` map, if any.
 * A record with no `metrics` (e.g. a raw-session record) yields an empty object.
 * Non-finite entries are ignored so only comparable pairs are checked.
 */
export function readQuartileValues(record: {
  metrics?: Partial<Record<CanonicalKPIId, number>>;
}): QuartileValues {
  const out: QuartileValues = {};
  const metrics = record.metrics;
  if (!metrics) {
    return out;
  }
  for (const q of QUARTILES) {
    const v = metrics[KPI_BY_QUARTILE[q]];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[q] = v;
    }
  }
  return out;
}

/**
 * Find every funnel-ordering violation among a record's *present* quartile
 * values. Only quartiles carrying a finite value participate; the required
 * ordering is checked between each present quartile and the next present
 * quartile above it, so a record with values only at 25% and 75% is checked as
 * `25% >= 75%` (Req 22.9).
 *
 * A record carrying fewer than two quartile values cannot violate an ordering
 * and yields no violations. Equal adjacent values are allowed (the ordering is
 * `>=`, not `>`).
 *
 * @param values the quartile values to check (see {@link readQuartileValues}).
 * @returns the list of violations, empty when the values are monotonic.
 */
export function findQuartileViolations(values: QuartileValues): QuartileViolation[] {
  const present = QUARTILES.filter(
    (q) => typeof values[q] === "number" && Number.isFinite(values[q] as number),
  );
  const violations: QuartileViolation[] = [];
  for (let i = 0; i < present.length - 1; i += 1) {
    const lower = present[i];
    const higher = present[i + 1];
    const lowerValue = values[lower] as number;
    const higherValue = values[higher] as number;
    if (lowerValue < higherValue) {
      violations.push({ lower, higher, lowerValue, higherValue });
    }
  }
  return violations;
}

/**
 * Format a single violation as the advisory `detail` text, naming the offending
 * pair of quartile values (Req 22.9).
 */
function describeViolation(v: QuartileViolation): string {
  return `${v.lower}% completion (${v.lowerValue}) is below ${v.higher}% completion (${v.higherValue})`;
}

/**
 * Check a pre-aggregated record's completion-quartile values for funnel
 * monotonicity and, if it violates `25% >= 50% >= 75% >= 100%`, produce a
 * `NON_MONOTONIC_QUARTILES` advisory naming the record and the offending
 * pair(s) (Req 22.9).
 *
 * The record is never dropped: this function only *reports*. Callers retain and
 * still aggregate the record (Req 22.8); the returned advisory is attached to
 * the record so it can surface on the affected scorecards and in the
 * data-quality panel.
 *
 * A record carrying fewer than two quartile values is not checked and returns
 * `null` (nothing to compare).
 *
 * @param record a record with an optional `id` and pre-aggregated `metrics`.
 * @returns a `NON_MONOTONIC_QUARTILES` advisory, or `null` when the record's
 *   quartiles are monotonic (or too sparse to compare).
 */
export function checkQuartileMonotonicity(record: {
  id?: string;
  metrics?: Partial<Record<CanonicalKPIId, number>>;
}): DataQualityAdvisory | null {
  const values = readQuartileValues(record);
  const violations = findQuartileViolations(values);
  if (violations.length === 0) {
    return null;
  }

  const label = record.id ? `record ${record.id}` : "record";
  const detail = `${label}: ${violations.map(describeViolation).join("; ")}`;
  return { code: "NON_MONOTONIC_QUARTILES", detail };
}
