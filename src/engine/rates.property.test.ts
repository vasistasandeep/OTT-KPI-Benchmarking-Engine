/**
 * Property-based coverage for the Rebuffer Ratio raw-session rate KPI.
 *
 * Validates the numeric core used to compute the group Rebuffer Ratio from
 * summed buffering and play-time milliseconds across a set of raw sessions.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NO_DATA } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";
import { rebufferRatio } from "./rates";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** A raw session carrying non-negative bufferingMs and playTimeMs. */
const arbSession: fc.Arbitrary<RawSessionFields> = fc.record(
  {
    bufferingMs: fc.double({
      min: 0,
      max: 1_000_000,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    playTimeMs: fc.double({
      min: 0,
      max: 1_000_000,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  },
  // Occasionally omit fields so partially-mapped sessions (treated as 0) are exercised.
  { requiredKeys: [] },
) as fc.Arbitrary<RawSessionFields>;

/** Round to 2 decimals the same way the implementation does. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

describe("rebufferRatio — value, bounds, and NO_DATA (Property 3)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 3: For any group of raw sessions with non-negative buffering and play-time milliseconds, the Rebuffer Ratio equals 100 * sum(buffering) / (sum(playTime) + sum(buffering)) rounded to 2 decimals and lies in [0, 100]; when sum(playTime) + sum(buffering) == 0 the result is exactly NO_DATA.
  it("matches the rounded formula and stays within [0, 100]", () => {
    fc.assert(
      fc.property(fc.array(arbSession, { maxLength: 200 }), (sessions) => {
        const sumBuffering = sessions.reduce(
          (acc, s) => acc + (s.bufferingMs ?? 0),
          0,
        );
        const sumPlayTime = sessions.reduce(
          (acc, s) => acc + (s.playTimeMs ?? 0),
          0,
        );
        const denominator = sumPlayTime + sumBuffering;

        const result = rebufferRatio(sessions);

        if (denominator === 0) {
          // No contributing quantity -> NO_DATA sentinel.
          expect(result).toBe(NO_DATA);
          return;
        }

        expect(typeof result).toBe("number");
        const value = result as number;

        // Equals the rounded formula.
        const expected = round2((100 * sumBuffering) / denominator);
        expect(value).toBeCloseTo(expected, 10);

        // Lies in [0, 100] (allow tiny floating-point slack).
        const eps = 1e-9;
        expect(value).toBeGreaterThanOrEqual(0 - eps);
        expect(value).toBeLessThanOrEqual(100 + eps);
      }),
      { numRuns: 100 },
    );
  });

  it("returns NO_DATA when the summed denominator is zero", () => {
    fc.assert(
      fc.property(
        // Any number of all-zero (or empty-field) sessions sums to a zero denominator.
        fc.array(
          fc.constantFrom<RawSessionFields>(
            {},
            { bufferingMs: 0 },
            { playTimeMs: 0 },
            { bufferingMs: 0, playTimeMs: 0 },
          ),
          { maxLength: 50 },
        ),
        (sessions) => {
          expect(rebufferRatio(sessions)).toBe(NO_DATA);
        },
      ),
      { numRuns: 100 },
    );
  });
});
