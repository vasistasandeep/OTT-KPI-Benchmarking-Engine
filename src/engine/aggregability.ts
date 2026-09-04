/**
 * Unique-count computation and the aggregability guard.
 *
 * Two statistically-invalid merges have to be prevented structurally rather
 * than by convention (design "Unique-count KPIs" and "Percentile aggregability",
 * Req 23):
 *
 * - A **distinct count** (DAU / WAU / MAU) is a count of distinct users. It is
 *   not additive and not weight-averageable: a user active on two days is 1 —
 *   not 2 — in the two-day unique count, and a user active on two platforms is 1
 *   overall but appears in two platform segments. So in raw mode it is computed
 *   *directly* from the sessions in the active slice (dedupe by `userId`), never
 *   assembled from smaller groups' counts (Req 23.1, 23.3). With no sessions the
 *   value is `NO_DATA`; with no mapped `userId` the KPI is not computable and is
 *   `NO_DATA` with the "requires a mapped `userId` column" reason (Req 23.2).
 *
 * - A **pre-aggregated distinct count or percentile** has lost the underlying
 *   identities / distribution, so no valid recombination exists. Such a value is
 *   displayed only at the granularity it was ingested at; any slice that would
 *   require combining it across two or more time buckets or across two or more
 *   dimension segments resolves to `NOT_AGGREGABLE` — never a sum and never an
 *   average (Req 23.4, 23.5, 23.6). {@link resolveAggregability} is the guard
 *   that makes this decision.
 *
 * All functions here are pure: no DOM, no storage, no mutation of inputs.
 *
 * `distinctCount` is used by the raw-mode DAU/WAU/MAU path; the trailing 7-/30-
 * day WAU/MAU windows are selected by the caller filtering sessions before the
 * call, so this function is window-agnostic and simply dedupes what it is given.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7.
 */

import { NO_DATA, NOT_AGGREGABLE } from "@/models/sentinels";
import type { Numeric } from "@/models/sentinels";
import type { RawSessionFields } from "@/models/records";
import type { AggregationKind } from "@/registry/kpi-types";

/** The reason shown when a distinct count needs a mapped `userId`. (Req 23.2) */
export const REQUIRES_USER_ID_REASON = "requires a mapped `userId` column";

/**
 * The outcome of a raw-mode distinct-count computation: the value (a finite
 * count or the `NO_DATA` sentinel) and, when the value is `NO_DATA` because the
 * KPI could not be computed rather than because the slice is empty, the reason
 * to surface to the analyst (Req 23.2). `reason` is `null` for a genuine
 * empty-slice `NO_DATA` and for a successful count.
 */
export interface DistinctCountResult {
  value: Numeric;
  reason: string | null;
}

/**
 * Count the distinct users in a group's sessions, directly (Req 23.1, 23.3).
 *
 * The count is taken over the *set* of `userId` values present on the given
 * sessions, so duplicate session rows for one user collapse to a single unit.
 * It is computed independently from the sessions handed in — for the active
 * slice or any rollup the caller passes exactly the sessions in that slice, and
 * the count is never assembled by summing or averaging smaller groups' counts
 * (Req 23.3). WAU / MAU use this same function over the trailing 7-day / 30-day
 * UTC windows; the caller filters the sessions to the window first.
 *
 * Sentinel behavior (design "Unique-count KPIs"):
 * - No mapped `userId` column → not computable → `NO_DATA` with the
 *   {@link REQUIRES_USER_ID_REASON} reason (Req 23.2). This is decided by the
 *   `userIdMapped` flag, not by whether the sessions happen to carry values, so
 *   an unmapped column reports the specific reason even for a non-empty slice.
 * - `sessions.length === 0` → empty slice → `NO_DATA`, no reason (Req 23.1);
 *   the widen-the-slice advice applies, so no not-aggregable reason is attached.
 * - Otherwise → the number of distinct `userId` values. A session missing a
 *   `userId` value contributes no identity and is skipped; if every session
 *   lacks one the distinct set is empty and the count is a defined `0` (records
 *   exist, they simply carry no identity), which is not `NO_DATA`.
 *
 * @param sessions     The valid sessions of the group / slice (already rejected
 *   for missing / non-numeric / negative required fields upstream).
 * @param userIdMapped Whether the active mapping populates the `userId` field.
 *   Defaults to `true`, matching a dataset that has the column mapped.
 * @returns the count and reason (see {@link DistinctCountResult}).
 */
export function distinctCount(
  sessions: readonly RawSessionFields[],
  userIdMapped = true,
): DistinctCountResult {
  if (!userIdMapped) {
    return { value: NO_DATA, reason: REQUIRES_USER_ID_REASON };
  }
  if (sessions.length === 0) {
    return { value: NO_DATA, reason: null };
  }

  const users = new Set<string>();
  for (const s of sessions) {
    const id = s.userId;
    if (typeof id === "string" && id !== "") {
      users.add(id);
    }
  }
  return { value: users.size, reason: null };
}

/**
 * A slice's shape for the aggregability decision: how many distinct time buckets
 * and dimension segments the slice spans. A pre-aggregated non-additive value is
 * valid only when the slice resolves to exactly one bucket and one segment (the
 * granularity it was ingested at); anything wider would require an invalid merge.
 */
export interface SliceExtent {
  /** Distinct UTC time buckets the slice spans (at the active granularity). */
  bucketCount: number;
  /** Distinct dimension segments (tag combinations) the slice spans. */
  segmentCount: number;
}

/**
 * Decide whether a KPI's value for a slice can be validly combined, or must be
 * reported as `NOT_AGGREGABLE` (Req 23.4).
 *
 * The guard only ever refuses the two non-recombinable kinds:
 * - `distinct_count` — pre-aggregated unique counts (raw-mode counts are handled
 *   by {@link distinctCount}, which recomputes directly, so they never reach a
 *   merge; a raw count is `aggregable`).
 * - `percentile` and `non_aggregable` — an ingested percentile column has lost
 *   its distribution and cannot be merged; averaging percentiles is never done
 *   (Req 23.6). Raw-mode percentiles are recomputed from the union of raw values
 *   for every slice and rollup (Req 23.7), so they too are `aggregable`.
 *
 * All additive / recomputable kinds (`sum`, `ratio`, `weighted_avg`,
 * `arithmetic_avg`) are always `aggregable`: they are recomputed from summed
 * components for the slice, so combining buckets or segments is valid.
 *
 * For a guarded kind the decision is purely the slice extent:
 * - one bucket AND one segment → matches the ingested granularity → `aggregable`
 *   (the ingested value is displayed as-is, Req 23.5).
 * - two or more buckets OR two or more segments → an invalid cross-bucket /
 *   cross-segment merge is required → `not_aggregable` (Req 23.4).
 *
 * A slice spanning zero buckets (no contributing records) is not a merge — it is
 * an empty slice handled by the `NO_DATA` path — so it resolves to `aggregable`
 * here; the caller's sentinel gate reports `NO_DATA` for it.
 *
 * @param aggregation The KPI's aggregation kind (from the registry).
 * @param isRawMode   Whether the value came from raw sessions. In raw mode both
 *   distinct counts and percentiles are recomputed directly, so the guard never
 *   fires; defaults to `false` (pre-aggregated), the case that needs guarding.
 * @param extent      How many buckets / segments the active slice spans.
 * @returns `"not_aggregable"` when the merge would be invalid, else `"aggregable"`.
 */
export function resolveAggregability(
  aggregation: AggregationKind,
  isRawMode: boolean,
  extent: SliceExtent,
): "aggregable" | "not_aggregable" {
  // Raw mode recomputes distinct counts and percentiles directly from the
  // sessions in the slice (Req 23.1, 23.3, 23.7), so no merge is ever performed.
  if (isRawMode) {
    return "aggregable";
  }

  if (!isGuardedKind(aggregation)) {
    return "aggregable";
  }

  // Pre-aggregated non-recombinable value: valid only at its ingested
  // granularity — exactly one bucket and one segment (Req 23.5). Spanning more
  // than one of either would require an invalid merge (Req 23.4). A slice with
  // no buckets is empty (NO_DATA territory), not a merge.
  const spansMultipleBuckets = extent.bucketCount > 1;
  const spansMultipleSegments = extent.segmentCount > 1;
  if (spansMultipleBuckets || spansMultipleSegments) {
    return "not_aggregable";
  }
  return "aggregable";
}

/**
 * Resolve a KPI value against the aggregability decision: pass the value through
 * when the slice is aggregable, or replace it with the `NOT_AGGREGABLE` sentinel
 * when it is not. A convenience for callers that hold both a computed value and
 * the guard's verdict.
 *
 * @param value         The value computed for the slice (may already be NO_DATA).
 * @param aggregability The verdict from {@link resolveAggregability}.
 * @returns `NOT_AGGREGABLE` when not aggregable, else the original value.
 */
export function applyAggregability(
  value: Numeric,
  aggregability: "aggregable" | "not_aggregable",
): Numeric {
  return aggregability === "not_aggregable" ? NOT_AGGREGABLE : value;
}

/** The two aggregation kinds that can never be validly merged across a slice. */
function isGuardedKind(aggregation: AggregationKind): boolean {
  return (
    aggregation === "distinct_count" ||
    aggregation === "percentile" ||
    aggregation === "non_aggregable"
  );
}
