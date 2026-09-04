/**
 * Sentinels and numeric value types.
 *
 * Two distinct sentinels are carried through the aggregation and comparison
 * pipeline so the UI can give the analyst the correct instruction:
 *
 * - `NO_DATA` means "no contributing records exist" -> widen the slice.
 * - `NOT_AGGREGABLE` means "records exist, but combining them for this slice
 *   would be statistically invalid" (unique counts or pre-aggregated
 *   percentiles across segments) -> narrow the slice to the granularity the
 *   value was ingested at.
 *
 * Requirements: 5.5, 5.8, 16.1 (NO_DATA); 23.4, 23.8 (NOT_AGGREGABLE).
 */

/** No contributing records exist for this slice. (Req 5.5, 5.8, 16.1) */
export const NO_DATA = null;

/** Records exist, but merging them for this slice is statistically invalid. (Req 23.4, 23.8) */
export const NOT_AGGREGABLE = "NOT_AGGREGABLE" as const;

/** Either sentinel value. */
export type Sentinel = typeof NO_DATA | typeof NOT_AGGREGABLE;

/** A numeric value that may instead be a sentinel. */
export type Numeric = number | Sentinel;
