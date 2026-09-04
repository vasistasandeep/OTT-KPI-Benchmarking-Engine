/**
 * Volume-weighted average for percentage/rate KPIs, with an unweighted
 * arithmetic-mean fallback.
 *
 * When every contributing row carries a `weight` (a Volume_Weight such as
 * session count or total watch time) and those weights sum to a positive
 * number, the KPI is aggregated as a true volume-weighted mean:
 *
 *   sum(vi * wi) / sum(wi)            // weighted = true   (Req 20.1, 20.2)
 *
 * If any row is missing its weight (or the weights sum to 0, so no weighted
 * mean is definable), the engine falls back to the unweighted arithmetic mean
 * and flags the result so the caller can raise the "aggregated percentages are
 * unweighted" data-quality advisory:
 *
 *   sum(vi) / n                       // weighted = false  (Req 20.3, 20.4)
 *
 * With no contributing rows the value is undefined, so the function returns the
 * `NO_DATA` sentinel (Req 5.5, 16.1).
 *
 * The function is pure: it does not round, mutate its input, touch the DOM, or
 * read storage. Rounding and advisory presentation are the caller's concern.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4.
 */

import { NO_DATA } from "../models/sentinels";
import type { Numeric } from "../models/sentinels";

/** A single contributing row: a value and an optional Volume_Weight. */
export interface AggRow {
  /** The percentage/rate value contributed by this row. */
  readonly value: number;
  /** The Volume_Weight for this row (session count, watch time, ...). */
  readonly weight?: number;
}

/** Outcome of a weighted average: the numeric value plus the weighting flag. */
export interface WeightedAverageResult {
  /** Weighted or unweighted mean, or `NO_DATA` when there are no rows. */
  readonly value: Numeric;
  /**
   * `true` when a true volume-weighted mean was computed; `false` when the
   * unweighted arithmetic-mean fallback was used, which should raise the
   * `UNWEIGHTED_AGGREGATE` advisory (Req 20.4). `false` for empty input.
   */
  readonly weighted: boolean;
}

/**
 * Compute the volume-weighted average of `rows`, falling back to the unweighted
 * arithmetic mean when weights are absent or non-positive in aggregate.
 *
 * @param rows contributing rows, each a `{ value, weight? }`.
 * @returns the mean and a `weighted` flag; `NO_DATA` with `weighted: false`
 *   when `rows` is empty.
 */
export function weightedAverage(rows: readonly AggRow[]): WeightedAverageResult {
  const n = rows.length;
  if (n === 0) {
    return { value: NO_DATA, weighted: false };
  }

  const allWeightsPresent = rows.every((r) => r.weight !== undefined);

  if (allWeightsPresent) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of rows) {
      const w = r.weight as number;
      weightedSum += r.value * w;
      weightTotal += w;
    }
    if (weightTotal > 0) {
      return { value: weightedSum / weightTotal, weighted: true };
    }
  }

  // Fallback: unweighted arithmetic mean (Req 20.3), advisory (Req 20.4).
  let valueSum = 0;
  for (const r of rows) {
    valueSum += r.value;
  }
  return { value: valueSum / n, weighted: false };
}
