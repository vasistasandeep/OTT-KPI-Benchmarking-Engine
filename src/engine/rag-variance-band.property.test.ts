/**
 * Property-based coverage for the comparator's variance-band / directionality
 * RAG classification (`classifyRAG` in ./comparator).
 *
 * Validates the within-band Amber rule, the directionality-aware Green/Red
 * split outside the band, and the symmetry that flipping directionality (with
 * values and band held fixed) swaps Green <-> Red while leaving Amber untouched.
 *
 * Validates: Requirements 11.5, 11.6
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { SLAConfig } from "../models/config";
import type { Directionality } from "../registry/kpi-types";
import { classifyRAG } from "./comparator";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** A finite App_A strictly greater than 0 (so percentDelta is defined). */
const arbAppA: fc.Arbitrary<number> = fc.double({
  min: 1e-6,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A finite App_B (any sign, may be zero). */
const arbAppB: fc.Arbitrary<number> = fc.double({
  min: -1_000_000,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A strictly positive variance band, in percent. */
const arbBand: fc.Arbitrary<number> = fc.double({
  min: 1e-6,
  max: 50,
  noNaN: true,
  noDefaultInfinity: true,
});

const arbDirectionality: fc.Arbitrary<Directionality> = fc.constantFrom(
  "higher_is_better",
  "lower_is_better",
);

/**
 * Build an SLA config with the given band and the confidence gate disabled, so
 * only the variance-band / directionality logic decides the verdict.
 */
function slaWith(band: number): SLAConfig {
  return { varianceBand: band, thresholds: {}, minSampleSize: 0 };
}

describe("classifyRAG — variance band & directionality (Property 10)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 10: For any finite appA > 0, appB, positive variance band, and directionality: if abs(percentDelta) <= band the status is Amber; otherwise the status is Green when the change is an improvement per directionality and Red when it is a degradation. Flipping the directionality (holding values and band fixed) swaps Green <-> Red and leaves Amber unchanged.
  it("classifies Amber within band, else Green/Red per directionality, and flipping swaps Green<->Red", () => {
    fc.assert(
      fc.property(
        arbAppA,
        arbAppB,
        arbBand,
        arbDirectionality,
        (appA, appB, band, directionality) => {
          const sla = slaWith(band);
          // Sample counts above any (disabled) floor so the confidence gate
          // never fires; only the band/directionality logic is exercised.
          const result = classifyRAG(appA, appB, directionality, sla, 1000, 1000);

          const percentDelta = (100 * (appB - appA)) / appA;
          const higherIsBetter = directionality === "higher_is_better";

          if (Math.abs(percentDelta) <= band) {
            // Within the band -> neutral Amber.
            expect(result.rag).toBe("Amber");
          } else {
            const improved = higherIsBetter
              ? percentDelta > 0
              : percentDelta < 0;
            expect(result.rag).toBe(improved ? "Green" : "Red");
          }

          // Symmetry: flip directionality, hold values and band fixed.
          const flipped: Directionality = higherIsBetter
            ? "lower_is_better"
            : "higher_is_better";
          const flippedResult = classifyRAG(
            appA,
            appB,
            flipped,
            sla,
            1000,
            1000,
          );

          if (result.rag === "Amber") {
            // Amber is directionality-independent.
            expect(flippedResult.rag).toBe("Amber");
          } else if (result.rag === "Green") {
            expect(flippedResult.rag).toBe("Red");
          } else {
            expect(result.rag).toBe("Red");
            expect(flippedResult.rag).toBe("Green");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
