import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { vsfRate } from "./rates";
import { NO_DATA } from "@/models";
import type { RawSessionFields } from "@/models";

/**
 * Local RawSessionFields arbitrary — intentionally NOT importing the shared
 * arbitraries module. Only the two fields VSF rate reads are modeled:
 * `startFailure` and `playbackAttempt`. Both are drawn from {0, 1} with the
 * constraint `startFailure <= playbackAttempt` (a start can only fail if an
 * attempt was made), matching the domain invariant on `RawSessionFields`.
 */
const arbSession: fc.Arbitrary<RawSessionFields> = fc
  .constantFrom<Array<{ startFailure: 0 | 1; playbackAttempt: 0 | 1 }>>(
    { startFailure: 0, playbackAttempt: 0 },
    { startFailure: 0, playbackAttempt: 1 },
    { startFailure: 1, playbackAttempt: 1 },
  )
  .map(({ startFailure, playbackAttempt }) => ({ startFailure, playbackAttempt }));

// Feature: ott-kpi-benchmarking-engine, Property 4: For any group of raw sessions where each startFailure <= playbackAttempt and both are non-negative, the VSF rate equals 100 * sum(startFailure) / sum(playbackAttempt) rounded to 2 decimals and lies in [0, 100]; when sum(playbackAttempt) == 0 the result is exactly NO_DATA.
describe("vsfRate — Property 4: VSF rate", () => {
  it("equals rounded 100 * sum(startFailure) / sum(playbackAttempt) in [0,100], or NO_DATA when the denominator is 0", () => {
    fc.assert(
      fc.property(
        fc.array(arbSession, { maxLength: 50 }),
        (sessions) => {
          const sumStartFailure = sessions.reduce(
            (acc, s) => acc + (s.startFailure ?? 0),
            0,
          );
          const sumPlaybackAttempt = sessions.reduce(
            (acc, s) => acc + (s.playbackAttempt ?? 0),
            0,
          );

          const result = vsfRate(sessions);

          if (sumPlaybackAttempt === 0) {
            // No attempts -> undefined rate -> NO_DATA (Req 5.5).
            expect(result).toBe(NO_DATA);
            return;
          }

          const expected =
            Math.round(
              ((100 * sumStartFailure) / sumPlaybackAttempt + Number.EPSILON) *
                100,
            ) / 100;

          expect(result).toBe(expected);
          // Bounded in [0, 100] given startFailure <= playbackAttempt (Req 5.3).
          expect(typeof result).toBe("number");
          expect(result as number).toBeGreaterThanOrEqual(0);
          expect(result as number).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 100 },
    );
  });
});
