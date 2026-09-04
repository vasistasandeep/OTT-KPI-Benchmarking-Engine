/**
 * Property-based coverage for unique-count dedupe and the non-combination guard
 * (Req 23.1, 23.3, 23.4).
 *
 * Two independent guarantees are exercised here:
 *
 * - Raw-mode distinct counts (`distinctCount`) are a count of *distinct* user
 *   identities computed directly from a slice's sessions. Duplicating any
 *   session row for a user already present must not change the count, and the
 *   count can never exceed the number of distinct users in the input.
 *
 * - Pre-aggregated unique counts spanning more than one time bucket or more than
 *   one dimension segment can never be validly recombined. `resolveAggregability`
 *   must resolve any such slice to exactly `NOT_AGGREGABLE`, and the guarded
 *   value (via `applyAggregability`) must never equal the sum or the mean of the
 *   underlying per-segment counts.
 *
 * Local arbitraries only — the shared `src/test/arbitraries.ts` is left untouched,
 * matching the convention established by the sibling property tests.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NO_DATA, NOT_AGGREGABLE } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";
import {
  distinctCount,
  resolveAggregability,
  applyAggregability,
  type SliceExtent,
} from "./aggregability";

// --- Raw-mode arbitraries ---------------------------------------------------

/**
 * A small pool of user identifiers so generated session arrays repeatedly reuse
 * the same users — this is what makes dedupe meaningful (many rows, few users).
 */
const arbUserId = fc.constantFrom("u1", "u2", "u3", "u4", "u5");

/** A raw session carrying a mapped user identifier plus some incidental fields. */
const arbSession: fc.Arbitrary<RawSessionFields> = fc.record({
  userId: arbUserId,
  playTimeMs: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
});

// --- Pre-aggregated arbitraries ---------------------------------------------

/**
 * A pre-aggregated unique-count record: a finite non-negative count attached to
 * one (bucket, segment) cell. The bucket / segment coordinates let the extent of
 * a candidate slice be derived from the set of records it covers.
 */
interface PreAggUniqueCount {
  bucket: string;
  segment: string;
  count: number;
}

const arbPreAggUniqueCount: fc.Arbitrary<PreAggUniqueCount> = fc.record({
  bucket: fc.constantFrom("2025-03-14", "2025-03-15", "2025-03-16"),
  segment: fc.constantFrom("ios", "android", "web"),
  count: fc.integer({ min: 0, max: 100_000 }),
});

/** Distinct-value extent of a set of pre-aggregated cells. */
function extentOf(records: readonly PreAggUniqueCount[]): SliceExtent {
  return {
    bucketCount: new Set(records.map((r) => r.bucket)).size,
    segmentCount: new Set(records.map((r) => r.segment)).size,
  };
}

// Feature: ott-kpi-benchmarking-engine, Property 19: For any group of raw sessions with mapped user identifiers, the distinct-count KPI equals the number of distinct user identifiers in the group, is unchanged by duplicating any session row for a user already present, and never exceeds the number of distinct users in the input; and for any set of pre-aggregated unique-count records spanning more than one bucket or dimension segment, the aggregate for a slice requiring their combination is exactly NOT_AGGREGABLE and never equals their sum or their mean.
describe("Property 19: unique-count dedupe and non-combination", () => {
  it("raw distinct count equals the number of distinct users, is duplicate-invariant, and never exceeds it", () => {
    fc.assert(
      fc.property(
        fc.array(arbSession, { maxLength: 60 }),
        // How many extra duplicate rows to inject, and where to source them.
        fc.array(fc.nat({ max: 5 }), { maxLength: 20 }),
        (sessions, dupPicks) => {
          const distinctUsers = new Set(sessions.map((s) => s.userId)).size;

          const base = distinctCount(sessions);

          if (sessions.length === 0) {
            // An empty slice is NO_DATA (widen the slice), not a count of 0 —
            // there are no contributing records to count (Req 23.1).
            expect(base).toEqual({ value: NO_DATA, reason: null });
          } else {
            // Base count equals the number of distinct user identifiers (Req 23.1).
            expect(base).toEqual({ value: distinctUsers, reason: null });
          }

          // Duplicating rows for users already present must not change the count
          // (Req 23.3): a user active on many rows is still one unit.
          const duplicated = [...sessions];
          for (const pick of dupPicks) {
            if (sessions.length === 0) break;
            const src = sessions[pick % sessions.length];
            duplicated.push({ ...src });
          }
          const afterDup = distinctCount(duplicated);
          expect(afterDup).toEqual(base);

          // The count never exceeds the number of distinct users in the input.
          if (typeof base.value === "number") {
            expect(base.value).toBeLessThanOrEqual(distinctUsers);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("pre-aggregated unique counts spanning >1 bucket or segment are exactly NOT_AGGREGABLE, never their sum or mean", () => {
    fc.assert(
      fc.property(
        // At least two cells so a combining slice can span >1 bucket/segment.
        fc.array(arbPreAggUniqueCount, { minLength: 2, maxLength: 12 }),
        (records) => {
          const extent = extentOf(records);
          const spansMultiple = extent.bucketCount > 1 || extent.segmentCount > 1;

          // The property targets slices that genuinely require combination.
          fc.pre(spansMultiple);

          const verdict = resolveAggregability("distinct_count", false, extent);
          expect(verdict).toBe("not_aggregable");

          // The engine produces exactly the NOT_AGGREGABLE sentinel for the slice,
          // regardless of what value would have been computed (Req 23.4).
          const sum = records.reduce((acc, r) => acc + r.count, 0);
          const mean = sum / records.length;
          const guarded = applyAggregability(sum, verdict);

          expect(guarded).toBe(NOT_AGGREGABLE);
          // And that sentinel is never the sum or the mean of the counts.
          expect(guarded).not.toBe(sum);
          expect(guarded).not.toBe(mean);
        },
      ),
      { numRuns: 100 },
    );
  });
});
