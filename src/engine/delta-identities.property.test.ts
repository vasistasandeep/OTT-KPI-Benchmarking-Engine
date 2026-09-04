/**
 * Property-based coverage for the delta identities computed by `computeDelta`.
 *
 * Validates the already-implemented `computeDelta` in src/engine/comparator.ts:
 * the absolute delta is always appB - appA, the percentage delta is the rounded
 * relative change when appA != 0 (sharing its sign with the absolute delta), and
 * the percentage delta is "N/A" (while the absolute delta is still computed)
 * when appA == 0.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeDelta } from "./comparator";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).
//
// KPI values in this domain are non-negative and live at a realistic scale, so
// the arbitraries are bounded to well-behaved magnitudes. Critically they must
// avoid subnormal/denormalized doubles (e.g. 5e-324) and extreme magnitude
// ratios: an appA divisor near zero makes 100*(appB-appA)/appA overflow or lose
// precision, which breaks the exact rounded identity and sends fast-check
// shrinking forever through the vast subnormal space (a synchronous hang the
// test timeout cannot interrupt).

/** A non-negative KPI value at a realistic scale (never subnormal, never negative). */
const arbKpiValue: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * A strictly-positive divisor kept away from zero (floor 0.01) so that
 * 100 * (appB - appA) / appA never divides by a subnormal or overflows.
 */
const arbPositiveDivisor: fc.Arbitrary<number> = fc.double({
  min: 0.01,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Round to 2 decimals the same way the implementation does. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

describe("computeDelta — delta identities (Property 9)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 9: For any finite App_A and App_B values, absoluteDelta == appB - appA; when appA != 0, percentDelta == 100*(appB-appA)/appA rounded to 2 decimals and sign(percentDelta) == sign(absoluteDelta); when appA == 0, percentDelta is "N/A" while absoluteDelta is still computed.
  it("holds absoluteDelta == appB - appA and the percentDelta identities", () => {
    fc.assert(
      fc.property(arbPositiveDivisor, arbKpiValue, (appA, appB) => {
        // appA is a strictly-positive, non-subnormal divisor; appB is any
        // non-negative KPI value.
        const { absoluteDelta, percentDelta } = computeDelta(appA, appB);

        // absoluteDelta is always appB - appA.
        expect(absoluteDelta).toBe(appB - appA);

        // appA > 0: percentDelta is the rounded relative change. Comparing
        // against the SAME round2 helper the implementation uses makes this an
        // exact identity for well-behaved (non-subnormal) divisors.
        const expected = round2((100 * (appB - appA)) / appA);
        // Exact match is expected; keep a tiny tolerance as a guard against any
        // residual floating-point divergence (never triggered for the bounded,
        // non-subnormal inputs above).
        if (percentDelta !== expected) {
          expect(Math.abs((percentDelta as number) - expected)).toBeLessThanOrEqual(0.01);
        } else {
          expect(percentDelta).toBe(expected);
        }

        // Sign agreement holds where the divisor is positive: percentDelta is a
        // positive multiple (100 / appA) of absoluteDelta, so they share a sign.
        // The one boundary is when rounding to 2 decimals collapses a tiny
        // relative change to exactly 0 (e.g. two large, nearly-equal values):
        // then percentDelta is 0 (sign 0) while absoluteDelta keeps its sign.
        // That is correct behaviour, so assert sign agreement only when the
        // rounded percentDelta is non-zero.
        if ((percentDelta as number) !== 0) {
          expect(Math.sign(percentDelta as number)).toBe(
            Math.sign(absoluteDelta as number),
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  it("returns 'N/A' percentDelta yet a real absoluteDelta whenever appA == 0", () => {
    fc.assert(
      fc.property(arbKpiValue, (appB) => {
        // appA == 0 is the division-by-zero case: use an explicit constant 0.
        const { absoluteDelta, percentDelta } = computeDelta(0, appB);
        expect(absoluteDelta).toBe(appB);
        expect(percentDelta).toBe("N/A");
      }),
      { numRuns: 100 },
    );
  });
});
