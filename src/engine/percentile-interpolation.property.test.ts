/**
 * Property-based coverage for the linear-interpolation percentile estimator.
 *
 * This suite implements design Property 2 (percentile interpolation exactness
 * at ranks) as a single fast-check property. Arbitraries are defined locally
 * here rather than in the shared test/arbitraries.ts module, because the
 * numeric distribution generators are specific to this estimator's input space.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { percentile } from "./percentile";

// A finite, non-NaN sample value. Bounds keep interpolation arithmetic exact
// enough to reason about without floating-point surprises overwhelming the
// property, while still exercising negatives, zero, and fractional values.
const arbSample = fc.double({
  min: -1_000_000,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

// A non-empty list of samples. The estimator sorts internally, so generating
// unsorted lists still exercises the "sorted list" premise of the property.
const arbNonEmptyValues = fc.array(arbSample, { minLength: 1, maxLength: 50 });

describe("percentile interpolation (Property 2)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 2: For any non-empty sorted list, the linear-interpolation percentile at a rank that lands exactly on an element index equals that element, and the interpolated value never falls outside the two nearest neighboring values.
  it("is exact at element-index ranks and stays within nearest neighbors", () => {
    fc.assert(
      fc.property(
        arbNonEmptyValues,
        // Percentile rank in [0, 100].
        fc.double({ min: 0, max: 100, noNaN: true }),
        (values, p) => {
          const n = values.length;
          const sorted = [...values].sort((a, b) => a - b);

          const result = percentile(values, p) as number;

          // The result is always a real number for non-empty input.
          expect(Number.isFinite(result)).toBe(true);

          // 0-based fractional rank used by the estimator.
          const rank = (p / 100) * (n - 1);
          const lo = Math.floor(rank);
          const hi = Math.ceil(rank);

          if (lo === hi) {
            // Rank lands exactly on an element index -> exact element value.
            // Add 0 to normalize signed zero (-0 -> +0); percentile values are
            // compared numerically, where +0 and -0 are the same magnitude,
            // and toBe uses Object.is which would otherwise distinguish them.
            expect(result + 0).toBe(sorted[lo] + 0);
          } else {
            // Interpolated value never falls outside the two nearest neighbors.
            const lower = sorted[lo];
            const upper = sorted[hi];
            expect(result).toBeGreaterThanOrEqual(lower);
            expect(result).toBeLessThanOrEqual(upper);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
