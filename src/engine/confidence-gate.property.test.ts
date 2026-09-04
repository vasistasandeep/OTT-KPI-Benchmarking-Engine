/**
 * Property-based coverage for the minimum-sample-size confidence gate in
 * `classifyRAG` (src/engine/comparator.ts).
 *
 * Validates that, for finite App_A / App_B values (so the sentinel gate is not
 * involved), the confidence gate behaves exactly as specified: when either
 * app's contributing count is below `minSampleSize` the verdict is exactly
 * `LowConfidence` (never Green or Red) while the deltas are still computable;
 * and when both counts are at or above the floor the verdict is whatever the
 * variance-band / directionality rules alone produce, independent of the counts.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { SLAConfig } from "../models/config";
import type { Directionality } from "../registry/kpi-types";
import { classifyRAG, computeDelta } from "./comparator";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** A finite value; kept > 0 for App_A so the percentage-delta band path is exercised. */
const arbPositive: fc.Arbitrary<number> = fc.double({
  min: 1e-6,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A finite App_B value spanning negatives, zero, and positives. */
const arbFinite: fc.Arbitrary<number> = fc.double({
  min: -1_000_000,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

const arbDirectionality: fc.Arbitrary<Directionality> = fc.constantFrom(
  "higher_is_better",
  "lower_is_better",
);

/** A strictly positive variance band. */
const arbBand: fc.Arbitrary<number> = fc.double({
  min: 1e-6,
  max: 100,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A non-negative contributing record count. */
const arbCount: fc.Arbitrary<number> = fc.nat({ max: 10_000 });

describe("classifyRAG — thin-sample confidence gate (Property 23)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 23: For any pair of App_A and App_B values, any directionality, any positive variance band, any non-negative minimum sample size, and any contributing record counts: if either app's contributing count is below the minimum sample size, the status is exactly LowConfidence and is never Green or Red, while the values and both deltas are still computed and reported; and if both counts are at or above the minimum, the status is determined solely by the existing variance-band and directionality rules, unchanged by the counts.
  it("suppresses to LowConfidence below the floor and defers to the band rules at or above it", () => {
    fc.assert(
      fc.property(
        arbPositive, // appA (finite, > 0 -> uses the percentage-delta band path)
        arbFinite, // appB (finite)
        arbDirectionality,
        arbBand, // positive variance band
        fc.nat({ max: 10_000 }), // minSampleSize (>= 0)
        arbCount, // appA contributing count
        arbCount, // appB contributing count
        (appA, appB, directionality, varianceBand, minSampleSize, countA, countB) => {
          const sla: SLAConfig = { varianceBand, thresholds: {}, minSampleSize };

          const result = classifyRAG(
            appA,
            appB,
            directionality,
            sla,
            countA,
            countB,
          );

          // Deltas are always computable for finite inputs (Req 25.6).
          const { absoluteDelta, percentDelta } = computeDelta(appA, appB);
          expect(absoluteDelta).toBe(appB - appA);
          expect(percentDelta).not.toBe(undefined);

          const gateActive = minSampleSize > 0;
          const belowFloor =
            gateActive && (countA < minSampleSize || countB < minSampleSize);

          // The band verdict is the status the counts should NOT influence: it
          // is what classifyRAG returns when the gate is disabled entirely.
          const slaNoGate: SLAConfig = { ...sla, minSampleSize: 0 };
          const bandVerdict = classifyRAG(
            appA,
            appB,
            directionality,
            slaNoGate,
            countA,
            countB,
          );

          if (belowFloor) {
            // Exactly LowConfidence; never Green or Red (Req 25.4).
            expect(result.rag).toBe("LowConfidence");
            expect(result.suppressionReason).toBe("below_min_sample");
            expect(result.rag).not.toBe("Green");
            expect(result.rag).not.toBe("Red");
          } else {
            // At or above the floor (or gate disabled): the status is decided
            // solely by the variance-band / directionality rules, so it equals
            // the gate-disabled verdict regardless of the counts (Req 25.11).
            expect(result).toEqual(bandVerdict);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is unchanged by the counts once both are at or above the floor", () => {
    fc.assert(
      fc.property(
        arbPositive,
        arbFinite,
        arbDirectionality,
        arbBand,
        fc.integer({ min: 1, max: 1_000 }), // active floor
        (appA, appB, directionality, varianceBand, minSampleSize) => {
          const sla: SLAConfig = { varianceBand, thresholds: {}, minSampleSize };

          // Two different count pairs, both at or above the floor.
          const low = classifyRAG(
            appA,
            appB,
            directionality,
            sla,
            minSampleSize,
            minSampleSize,
          );
          const high = classifyRAG(
            appA,
            appB,
            directionality,
            sla,
            minSampleSize + 5_000,
            minSampleSize + 9_999,
          );

          // Counts above the floor do not affect the verdict.
          expect(low).toEqual(high);
          expect(low.rag).not.toBe("LowConfidence");
        },
      ),
      { numRuns: 100 },
    );
  });
});
