/**
 * Property-based coverage for the "percentiles are never averaged" invariant.
 *
 * A pre-aggregated percentile column has lost its underlying distribution, so
 * there is no valid way to recombine it across time buckets or dimension
 * segments. The engine must refuse the merge structurally — resolving such a
 * slice to `NOT_AGGREGABLE` — rather than quietly returning the arithmetic mean
 * or the volume-weighted mean of the per-group percentile values, either of
 * which would be a statistically invalid number (design "Percentile
 * aggregability", Req 23.4, 23.6). In raw-session mode the same slice is instead
 * a genuine value: the percentile is recomputed from the union of the raw
 * samples across the groups (Req 23.7).
 *
 * This validates the already-implemented guard in `aggregability.ts`
 * (`resolveAggregability` / `applyAggregability`) together with the raw-mode
 * recomputation path (`percentile` over the union of raw values).
 *
 * Validates: Requirements 23.4, 23.6, 23.7
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NOT_AGGREGABLE } from "../models/sentinels";
import { resolveAggregability, applyAggregability } from "./aggregability";
import { percentile } from "./percentile";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** A finite, non-negative percentile value (e.g. a latency P95 in ms). */
const arbPercentileValue = fc.double({
  min: 0,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A finite, positive volume weight so the volume-weighted mean is defined. */
const arbVolumeWeight = fc.double({
  min: 1,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * A pre-aggregated group: an ingested percentile value plus the volume that
 * produced it. Drawn from two or more groups, these model a set of per-segment
 * (or per-bucket) percentiles that a wider slice would have to combine.
 */
const arbGroup = fc.record({
  percentileValue: arbPercentileValue,
  volumeWeight: arbVolumeWeight,
});

/**
 * Two or more groups spanning more than one bucket / segment — the shape that
 * forces the guard to fire. Both means below are always computable (finite
 * values, positive weights), so the test can assert the engine returns neither.
 */
const arbMultiGroup = fc.array(arbGroup, { minLength: 2, maxLength: 50 });

/** The slice extent implied by N groups drawn from distinct segments. */
function extentForGroups(groupCount: number) {
  return { bucketCount: groupCount, segmentCount: groupCount };
}

/** Arithmetic mean of the per-group percentile values. */
function arithmeticMean(values: readonly number[]): number {
  return values.reduce((a, v) => a + v, 0) / values.length;
}

/** Volume-weighted mean of the per-group percentile values. */
function volumeWeightedMean(
  values: readonly number[],
  weights: readonly number[],
): number {
  const weightTotal = weights.reduce((a, w) => a + w, 0);
  const weighted = values.reduce((a, v, i) => a + v * weights[i], 0);
  return weighted / weightTotal;
}

// Feature: ott-kpi-benchmarking-engine, Property 20: For any set of pre-aggregated percentile values drawn from two or more groups, a slice that requires merging them yields exactly NOT_AGGREGABLE, and the engine produces no numeric result for that slice — in particular never the arithmetic mean, and never the volume-weighted mean, of the group percentile values; in raw-session mode the same slice instead yields a percentile recomputed from the union of the underlying raw values.
describe("percentile aggregability — never averaged (Property 20)", () => {
  it("pre-aggregated percentiles across 2+ groups resolve to NOT_AGGREGABLE, never a mean", () => {
    fc.assert(
      fc.property(arbMultiGroup, (groups) => {
        const values = groups.map((g) => g.percentileValue);
        const weights = groups.map((g) => g.volumeWeight);
        const extent = extentForGroups(groups.length);

        // The guard must refuse the merge: pre-aggregated percentile, > 1
        // bucket AND > 1 segment.
        const verdict = resolveAggregability("percentile", false, extent);
        expect(verdict).toBe("not_aggregable");

        // Applying the verdict to any candidate numeric value replaces it with
        // the NOT_AGGREGABLE sentinel — the engine produces no number here.
        const arithMean = arithmeticMean(values);
        const volMean = volumeWeightedMean(values, weights);

        const result = applyAggregability(arithMean, verdict);
        expect(result).toBe(NOT_AGGREGABLE);

        // Crucially the result is neither the arithmetic mean nor the
        // volume-weighted mean of the per-group percentile values, both of
        // which are finite/computable here.
        expect(result).not.toBe(arithMean);
        expect(result).not.toBe(volMean);
        expect(typeof result).not.toBe("number");
      }),
      { numRuns: 100 },
    );
  });

  it("guard still fires when only the segment span (not the bucket span) exceeds one", () => {
    fc.assert(
      fc.property(arbMultiGroup, (groups) => {
        // A single time bucket but multiple dimension segments still requires
        // an invalid cross-segment merge of pre-aggregated percentiles.
        const extent = { bucketCount: 1, segmentCount: groups.length };
        const verdict = resolveAggregability("percentile", false, extent);
        expect(verdict).toBe("not_aggregable");
        expect(applyAggregability(arithmeticMean(groups.map((g) => g.percentileValue)), verdict)).toBe(
          NOT_AGGREGABLE,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("raw-session mode instead recomputes the percentile from the union of raw values", () => {
    fc.assert(
      fc.property(
        // Two or more groups, each carrying its own list of raw samples.
        fc.array(
          fc.array(arbPercentileValue, { minLength: 1, maxLength: 40 }),
          { minLength: 2, maxLength: 12 },
        ),
        fc.constantFrom(0, 25, 50, 90, 95, 99, 100),
        (groupSamples, p) => {
          const extent = extentForGroups(groupSamples.length);

          // In raw mode the percentile is aggregable — never guarded away.
          const verdict = resolveAggregability("percentile", true, extent);
          expect(verdict).toBe("aggregable");

          // The slice value is the percentile recomputed over the UNION of the
          // underlying raw samples across every group — not any function of the
          // per-group percentiles.
          const union = groupSamples.flat();
          const recomputed = percentile(union, p);
          const passedThrough = applyAggregability(recomputed, verdict);

          // Aggregable => the recomputed value passes through unchanged and is a
          // real number bounded by the union's own min / max.
          expect(passedThrough).toBe(recomputed);
          expect(typeof passedThrough).toBe("number");
          const value = passedThrough as number;
          const eps = 1e-9;
          expect(value).toBeGreaterThanOrEqual(Math.min(...union) - eps);
          expect(value).toBeLessThanOrEqual(Math.max(...union) + eps);
        },
      ),
      { numRuns: 100 },
    );
  });
});
