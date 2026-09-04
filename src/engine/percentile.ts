/**
 * Percentile computation via linear interpolation between the two nearest ranks.
 *
 * A percentile is a statement about a distribution: given the raw values you
 * can compute any percentile exactly. This is the pure numeric core used by the
 * aggregation engine to compute Video Start Time P50/P95, Manifest Fetch
 * Latency, and TTFB over a group's raw distribution.
 *
 * The estimator is the standard "linear interpolation between closest ranks"
 * method on the 0-based fractional rank `(p / 100) * (n - 1)`. It yields exact
 * values at integer ranks (e.g. P0 -> min, P100 -> max, P50 -> median for the
 * symmetric case) and produces monotonic non-decreasing output as `p` increases.
 *
 * Requirements: 5.4 (linear-interpolated percentiles), 5.8 (empty -> NO_DATA).
 */

import { NO_DATA, type Numeric } from "@/models";

/**
 * Compute the `p`-th percentile of `values` using linear interpolation between
 * the two nearest ranks.
 *
 * The input does not need to be pre-sorted; it is sorted internally (ascending,
 * numerically) without mutating the caller's array.
 *
 * @param values Distribution samples. May be empty or unsorted.
 * @param p      Percentile rank in the range 0–100.
 * @returns The interpolated percentile value, or `NO_DATA` for empty input.
 */
export function percentile(values: number[], p: number): Numeric {
  const n = values.length;
  if (n === 0) {
    return NO_DATA; // Req 5.8
  }

  // Sort a copy ascending so the function stays pure over its input array.
  const sorted = [...values].sort((a, b) => a - b);

  // A single sample has no distribution to interpolate over.
  if (n === 1) {
    return sorted[0];
  }

  // 0-based fractional rank across the sorted samples.
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;

  // When rank is an integer, lo === hi and this reduces to the exact sample.
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}
