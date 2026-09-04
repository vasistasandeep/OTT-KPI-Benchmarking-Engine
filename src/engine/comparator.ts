/**
 * The comparator: delta computation and RAG classification with the two
 * suppression gates (sentinels, then minimum sample size).
 *
 * `computeDelta` and `classifyRAG` are pure functions and together own step 6
 * of the fixed execution order (delta -> confidence gate -> RAG). They take the
 * two already-aggregated App_A / App_B values for one KPI and slice, plus the
 * KPI's directionality and the active `SLAConfig`, and produce the numbers and
 * verdict a scorecard renders.
 *
 * Delta identities (Req 11.3, 11.4):
 *
 *   absoluteDelta = appB - appA                              (always, when both finite)
 *   percentDelta  = (appA == 0) ? "N/A" : round2(100 * (appB - appA) / appA)
 *
 * Two gates run before any Amber/Green/Red classification:
 *
 *   Gate 1 - sentinels (Req 16.5): if either value is NO_DATA the status is
 *     `NoData` with reason "no_data"; if either is NOT_AGGREGABLE the status is
 *     `NoData` with reason "not_aggregable". No finite delta is reported.
 *
 *   Gate 2 - minimum sample size (Req 25.2-25.7, 25.11): if either app's
 *     contributing volume is below `sla.minSampleSize` the status is
 *     `LowConfidence` with reason "below_min_sample". The values and both deltas
 *     are still computed and reported. `minSampleSize == 0` disables the gate.
 *
 * Only when both gates pass does directionality-aware classification against the
 * variance band decide Green / Amber / Red, including the `appA == 0`
 * absolute-sign path (Req 11.4, 11.5, 11.6).
 *
 * Requirements: 11.3, 11.4, 11.5, 11.6, 16.5, 25.2, 25.3, 25.4, 25.5, 25.6,
 * 25.7, 25.11.
 */

import { NO_DATA, NOT_AGGREGABLE } from "../models/sentinels";
import type { Numeric } from "../models/sentinels";
import type { RAGStatus, SuppressionReason } from "../models/results";
import type { SLAConfig } from "../models/config";
import type { Directionality } from "../registry/kpi-types";

/** Round a finite number to 2 decimal places. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** True when a `Numeric` is one of the two suppression sentinels, not a finite number. */
function isSentinel(value: Numeric): boolean {
  return value === NO_DATA || value === NOT_AGGREGABLE;
}

/** The deltas produced from a pair of App_A / App_B values. */
export interface DeltaResult {
  /** appB - appA when both are finite; NO_DATA when either is a sentinel. (Req 11.3) */
  absoluteDelta: Numeric;
  /** round2(100 * (appB - appA) / appA); "N/A" when appA == 0; NO_DATA when either is a sentinel. (Req 11.4) */
  percentDelta: Numeric | "N/A";
}

/**
 * Compute the absolute and percentage deltas for a pair of aggregated values
 * (Req 11.3, 11.4).
 *
 * When either value is a sentinel (`NO_DATA` / `NOT_AGGREGABLE`) no finite delta
 * exists, so both deltas are `NO_DATA` — the RAG gate then reports the precise
 * reason. When both are finite the absolute delta is always `appB - appA`. The
 * percentage delta is `"N/A"` exactly when `appA == 0` (division by zero is
 * undefined), otherwise `round2(100 * (appB - appA) / appA)`; because rounding
 * to 2 decimals preserves sign, `sign(percentDelta) == sign(absoluteDelta)`.
 */
export function computeDelta(appA: Numeric, appB: Numeric): DeltaResult {
  if (isSentinel(appA) || isSentinel(appB)) {
    return { absoluteDelta: NO_DATA, percentDelta: NO_DATA };
  }

  const a = appA as number;
  const b = appB as number;
  const absoluteDelta = b - a;

  if (a === 0) {
    return { absoluteDelta, percentDelta: "N/A" };
  }

  return { absoluteDelta, percentDelta: round2((100 * (b - a)) / a) };
}

/** The verdict produced by `classifyRAG`, with the reason when suppressed. */
export interface RAGResult {
  rag: RAGStatus;
  /** Present only when the status is a suppressed verdict (NoData / LowConfidence). */
  suppressionReason?: SuppressionReason;
}

/**
 * Classify a comparison into a RAG status, running the sentinel gate and then
 * the confidence gate before any variance-band classification (Req 11.5, 11.6,
 * 16.5, 25.4).
 *
 * Gate order matters: a slice with no data is `NoData` regardless of its
 * contributing counts, so the sentinel gate runs first. Only comparisons where
 * both apps have finite values and enough volume reach the directionality-aware
 * band classification.
 *
 * @param appA aggregated App_A value (may be a sentinel).
 * @param appB aggregated App_B value (may be a sentinel).
 * @param directionality whether higher or lower is better for this KPI (Req 1.2).
 * @param sla active SLA config supplying `varianceBand` and `minSampleSize`.
 * @param appAContributingRecords App_A's contributing volume (post-rejection
 *   count, or summed `volumeWeight` for pre-aggregated data — Req 25.2, 25.3).
 * @param appBContributingRecords App_B's contributing volume.
 */
export function classifyRAG(
  appA: Numeric,
  appB: Numeric,
  directionality: Directionality,
  sla: SLAConfig,
  appAContributingRecords: number,
  appBContributingRecords: number,
): RAGResult {
  // Gate 1 - sentinels (Req 16.5). NOT_AGGREGABLE is distinguished from NO_DATA
  // so the UI can tell the analyst to narrow rather than widen the slice.
  if (appA === NOT_AGGREGABLE || appB === NOT_AGGREGABLE) {
    return { rag: "NoData", suppressionReason: "not_aggregable" };
  }
  if (appA === NO_DATA || appB === NO_DATA) {
    return { rag: "NoData", suppressionReason: "no_data" };
  }

  // Gate 2 - minimum sample size (Req 25.4, 25.6). minSampleSize == 0 disables
  // the gate entirely (Req 25.11). If either app is below the floor the verdict
  // is suppressed to LowConfidence, but the caller still shows both deltas.
  if (
    sla.minSampleSize > 0 &&
    (appAContributingRecords < sla.minSampleSize ||
      appBContributingRecords < sla.minSampleSize)
  ) {
    return { rag: "LowConfidence", suppressionReason: "below_min_sample" };
  }

  const a = appA as number;
  const b = appB as number;
  const higherIsBetter = directionality === "higher_is_better";

  // appA == 0: percentage delta is undefined, so classify on the sign of the
  // absolute delta instead (Req 11.4).
  if (a === 0) {
    const sign = Math.sign(b - a);
    if (sign === 0) {
      return { rag: "Amber" };
    }
    const improved = higherIsBetter ? sign > 0 : sign < 0;
    return { rag: improved ? "Green" : "Red" };
  }

  // appA != 0: classify the percentage delta against the variance band (Req 11.5).
  const percentDelta = (100 * (b - a)) / a;
  if (Math.abs(percentDelta) <= sla.varianceBand) {
    return { rag: "Amber" };
  }
  const improved = higherIsBetter ? percentDelta > 0 : percentDelta < 0;
  return { rag: improved ? "Green" : "Red" };
}
