/**
 * Property-based coverage for the zero-divisor sentinel invariant.
 *
 * Every aggregation path in the engine that can encounter a zero divisor must
 * collapse to exactly the same `NO_DATA` sentinel rather than leaking `NaN`,
 * `Infinity`, or throwing. This test forces the divisor to zero for each
 * affected KPI (rebufferRatio, vsfRate, percentile, weightedAverage) and
 * asserts the outcome is that single shared sentinel.
 *
 * Validates: Requirements 5.5, 16.1
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NO_DATA } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";
import { rebufferRatio, vsfRate } from "./rates";
import { percentile } from "./percentile";
import { weightedAverage } from "./weighted-average";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/**
 * A raw session whose buffering + play-time divisor is zero: both fields are
 * either 0 or absent (undefined -> treated as 0). Other fields may carry
 * arbitrary values to prove they do not resurrect the divisor.
 */
const arbZeroPlaybackTimeSession: fc.Arbitrary<RawSessionFields> = fc.record(
  {
    bufferingMs: fc.constantFrom(0, undefined),
    playTimeMs: fc.constantFrom(0, undefined),
    startFailure: fc.constantFrom<0 | 1 | undefined>(0, 1, undefined),
    playbackAttempt: fc.constantFrom<0 | 1 | undefined>(0, 1, undefined),
  },
  { requiredKeys: [] },
);

/**
 * A raw session whose playback-attempt divisor is zero: `playbackAttempt` is 0
 * or absent. `startFailure` may still be present to prove the numerator alone
 * cannot produce a finite rate.
 */
const arbZeroPlaybackAttemptSession: fc.Arbitrary<RawSessionFields> = fc.record(
  {
    playbackAttempt: fc.constantFrom<0 | 1 | undefined>(0, undefined),
    startFailure: fc.constantFrom<0 | 1 | undefined>(0, undefined),
  },
  { requiredKeys: [] },
);

/** A row whose weight is exactly zero, forcing the weight-total divisor to 0. */
const arbZeroWeightRow = fc.record({
  value: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  weight: fc.constant(0),
});

/** A finite percentile rank in [0, 100]. */
const arbPercentileRank = fc.constantFrom(0, 25, 50, 90, 95, 99, 100);

/** Assert a value is exactly the NO_DATA sentinel and never a bad number. */
function expectNoData(value: unknown): void {
  expect(value).toBe(NO_DATA);
  expect(Number.isNaN(value as number)).toBe(false);
  expect(value).not.toBe(Infinity);
  expect(value).not.toBe(-Infinity);
}

describe("zero-divisor sentinel consistency (Property 5)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 5: For any aggregation input whose divisor evaluates to zero, the affected KPI value is exactly the defined NO_DATA sentinel and is never NaN, Infinity, or a thrown error, and the same sentinel is used consistently across all affected KPIs.
  it("collapses every zero-divisor KPI to exactly NO_DATA, consistently", () => {
    fc.assert(
      fc.property(
        fc.array(arbZeroPlaybackTimeSession, { minLength: 0, maxLength: 50 }),
        fc.array(arbZeroPlaybackAttemptSession, { minLength: 0, maxLength: 50 }),
        fc.array(arbZeroWeightRow, { minLength: 1, maxLength: 50 }),
        arbPercentileRank,
        (
          rebufferSessions,
          vsfSessions,
          zeroWeightRows,
          rank,
        ) => {
          // rebufferRatio: sum(playTimeMs) + sum(bufferingMs) === 0 -> NO_DATA.
          const rebuffer = rebufferRatio(rebufferSessions);

          // vsfRate: sum(playbackAttempt) === 0 -> NO_DATA.
          const vsf = vsfRate(vsfSessions);

          // percentile of an empty distribution: n === 0 -> NO_DATA.
          const pct = percentile([], rank);

          // weightedAverage: weights all present but sum to 0, values sum to 0
          // as well would still divide by n; the *weighted* divisor is 0 so the
          // engine must not divide by it. Empty rows would divide by n === 0,
          // so we also exercise the truly-empty case for the shared sentinel.
          const emptyWeighted = weightedAverage([]);

          // All affected KPIs must be exactly NO_DATA and never NaN/Infinity.
          expectNoData(rebuffer);
          expectNoData(vsf);
          expectNoData(pct);
          expectNoData(emptyWeighted.value);

          // The same sentinel is used consistently across all affected KPIs.
          const sentinels = [rebuffer, vsf, pct, emptyWeighted.value];
          for (const s of sentinels) {
            expect(s).toBe(sentinels[0]);
            expect(s).toBe(NO_DATA);
          }

          // Sanity: zeroWeightRows is a non-empty set of zero-weighted rows.
          // A zero weight-total must never yield a weighted (true) mean that
          // divides by zero; the fallback path divides by n (> 0) instead, so
          // it must stay finite rather than NaN/Infinity.
          const weighted = weightedAverage(zeroWeightRows);
          expect(typeof weighted.value).toBe("number");
          expect(Number.isFinite(weighted.value as number)).toBe(true);
          expect(weighted.weighted).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
