/**
 * Property-based coverage for the weighted-average convex-combination invariant.
 *
 * Validates the volume-weighted mean used to aggregate percentage/rate KPIs,
 * together with its unweighted arithmetic-mean fallback and the `weighted`
 * flag that drives the "aggregated percentages are unweighted" advisory.
 *
 * Validates: Requirements 20.1, 20.2, 20.3, 20.4
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { weightedAverage } from "./weighted-average";
import type { AggRow } from "./weighted-average";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** A finite value in a range that keeps sums well away from overflow. */
const arbValue = fc.double({
  min: -1_000_000,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A finite, non-negative Volume_Weight. */
const arbWeight = fc.double({
  min: 0,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * A single contributing row: a value plus an optional non-negative weight.
 * The weight is present or absent with roughly even likelihood so generated
 * lists exercise both the all-weights-present and weights-absent branches.
 */
const arbAggRow: fc.Arbitrary<AggRow> = fc
  .record({
    value: arbValue,
    weight: fc.option(arbWeight, { nil: undefined }),
  })
  .map(({ value, weight }) =>
    weight === undefined ? { value } : { value, weight },
  );

/** Relative + absolute floating-point tolerance for a scale. */
function tolerance(scale: number): number {
  return 1e-6 + 1e-9 * Math.abs(scale);
}

describe("weightedAverage — convex combination (Property 6)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 6: For any non-empty list of values with non-negative weights whose sum is positive, the weighted average lies within [min(values), max(values)] and equals sum(vi·wi) / sum(wi); when weights are absent it equals the unweighted arithmetic mean sum(vi)/n, is still within [min, max], and the result is flagged weighted = false.
  it("all weights present with positive sum: weighted mean within [min, max] and equals sum(vi*wi)/sum(wi)", () => {
    fc.assert(
      fc.property(
        // Non-empty list of values, each paired with a non-negative weight.
        fc.array(fc.tuple(arbValue, arbWeight), {
          minLength: 1,
          maxLength: 200,
        }),
        (pairs) => {
          const weightTotal = pairs.reduce((acc, [, w]) => acc + w, 0);
          // Only exercise the weighted branch when the weights sum to > 0.
          fc.pre(weightTotal > 0);

          const rows: AggRow[] = pairs.map(([value, weight]) => ({
            value,
            weight,
          }));
          const values = pairs.map(([v]) => v);
          const min = Math.min(...values);
          const max = Math.max(...values);

          const result = weightedAverage(rows);

          expect(result.weighted).toBe(true);
          expect(typeof result.value).toBe("number");
          const value = result.value as number;

          // Convex combination: lies within [min(values), max(values)].
          const bound = tolerance(Math.max(Math.abs(min), Math.abs(max)));
          expect(value).toBeGreaterThanOrEqual(min - bound);
          expect(value).toBeLessThanOrEqual(max + bound);

          // Equals sum(vi*wi) / sum(wi).
          const weightedSum = pairs.reduce((acc, [v, w]) => acc + v * w, 0);
          const expected = weightedSum / weightTotal;
          expect(value).toBeCloseTo(expected, 6);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("weights absent: unweighted mean sum(vi)/n within [min, max], flagged weighted = false", () => {
    fc.assert(
      fc.property(
        // Non-empty list of bare values (no weights on any row).
        fc.array(arbValue, { minLength: 1, maxLength: 200 }),
        (values) => {
          const rows: AggRow[] = values.map((value) => ({ value }));
          const min = Math.min(...values);
          const max = Math.max(...values);

          const result = weightedAverage(rows);

          // Fallback path: unweighted arithmetic mean, advisory flag off.
          expect(result.weighted).toBe(false);
          expect(typeof result.value).toBe("number");
          const value = result.value as number;

          // Equals the unweighted arithmetic mean sum(vi)/n.
          const expected =
            values.reduce((acc, v) => acc + v, 0) / values.length;
          expect(value).toBeCloseTo(expected, 6);

          // Still lies within [min(values), max(values)].
          const bound = tolerance(Math.max(Math.abs(min), Math.abs(max)));
          expect(value).toBeGreaterThanOrEqual(min - bound);
          expect(value).toBeLessThanOrEqual(max + bound);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("mixed rows from arbAggRow: value stays within [min, max] and flag matches weight completeness", () => {
    fc.assert(
      fc.property(
        fc.array(arbAggRow, { minLength: 1, maxLength: 200 }),
        (rows) => {
          const values = rows.map((r) => r.value);
          const min = Math.min(...values);
          const max = Math.max(...values);

          const result = weightedAverage(rows);
          expect(typeof result.value).toBe("number");
          const value = result.value as number;

          // Whether weighted or unweighted, the result is a convex
          // combination of the values and stays within [min, max].
          const bound = tolerance(Math.max(Math.abs(min), Math.abs(max)));
          expect(value).toBeGreaterThanOrEqual(min - bound);
          expect(value).toBeLessThanOrEqual(max + bound);

          const allWeightsPresent = rows.every((r) => r.weight !== undefined);
          const weightTotal = rows.reduce(
            (acc, r) => acc + (r.weight ?? 0),
            0,
          );

          if (allWeightsPresent && weightTotal > 0) {
            expect(result.weighted).toBe(true);
          } else {
            expect(result.weighted).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
