/**
 * Property-based coverage for the raw-mode Content Completion Rates.
 *
 * Validates the funnel invariant that the four quartile rates are monotonic
 * non-increasing and each lies in [0, 100], and that an empty session set
 * yields NO_DATA for every quartile rather than a violating numeric result.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NO_DATA } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";
import { QUARTILES, completionQuartileRates } from "./quartiles";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/**
 * A raw session whose `quartileReached` is drawn from the valid quartile
 * distribution {0, 25, 50, 75, 100}, and is occasionally missing entirely so
 * that partially-mapped sessions (treated as reaching none) are exercised.
 */
const arbSession: fc.Arbitrary<RawSessionFields> = fc.record(
  {
    quartileReached: fc.constantFrom(0, 25, 50, 75, 100),
  },
  // Occasionally omit the field so a "started but reached nothing" row appears.
  { requiredKeys: [] },
) as fc.Arbitrary<RawSessionFields>;

describe("completionQuartileRates — funnel monotonicity, bounds, NO_DATA (Property 24)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 24: For any set of valid raw sessions, the computed Content Completion Rates satisfy rate(25%) >= rate(50%) >= rate(75%) >= rate(100%), and each rate lies in [0, 100]; an empty set of sessions yields NO_DATA for all four quartiles rather than a violating result.
  it("is monotonic non-increasing with every rate in [0, 100] for non-empty session sets", () => {
    fc.assert(
      fc.property(
        fc.array(arbSession, { minLength: 1, maxLength: 200 }),
        (sessions) => {
          const rates = completionQuartileRates(sessions);

          // A non-empty set produces a numeric rate for every quartile.
          for (const q of QUARTILES) {
            expect(typeof rates[q]).toBe("number");
          }

          const r25 = rates[25] as number;
          const r50 = rates[50] as number;
          const r75 = rates[75] as number;
          const r100 = rates[100] as number;

          // Funnel ordering: rate(25) >= rate(50) >= rate(75) >= rate(100).
          const eps = 1e-9;
          expect(r25).toBeGreaterThanOrEqual(r50 - eps);
          expect(r50).toBeGreaterThanOrEqual(r75 - eps);
          expect(r75).toBeGreaterThanOrEqual(r100 - eps);

          // Each rate lies in [0, 100].
          for (const value of [r25, r50, r75, r100]) {
            expect(value).toBeGreaterThanOrEqual(0 - eps);
            expect(value).toBeLessThanOrEqual(100 + eps);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("yields NO_DATA for all four quartiles on an empty session set", () => {
    const rates = completionQuartileRates([]);
    for (const q of QUARTILES) {
      expect(rates[q]).toBe(NO_DATA);
    }
  });
});
