/**
 * Property-based coverage for fuzzy header matching (Req 7.2, 7.3, 7.4).
 *
 * Pins the invariants of the similarity score and the auto-mapping decision:
 * the Sørensen–Dice score is a bounded, symmetric [0,1] measure; an exact alias
 * always resolves to a perfect 1.00 score and a proposed target; and a target
 * is proposed only when the best candidate clears AUTO_MAP_THRESHOLD (0.80),
 * otherwise the column is left unmapped.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { KPI_REGISTRY } from "../registry/kpi-registry";
import {
  diceSimilarity,
  matchHeader,
  normalizeHeader,
  AUTO_MAP_THRESHOLD,
} from "./fuzzy-matcher";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** Every exact alias declared across the registry — each must score 1.00. */
const ALL_ALIASES: readonly string[] = KPI_REGISTRY.flatMap((kpi) => kpi.aliases);

/**
 * Bounded "junk" header strings over an alphanumeric + underscore + space
 * alphabet. Constraining the character set and length keeps the Dice scan cheap
 * and avoids the pathological / subnormal-input generation that can stall
 * fast-check on unbounded `fc.string`.
 */
const arbJunkHeader: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_ ".split("")),
  { maxLength: 40 },
);

/**
 * `arbHeader`: source header strings biased toward the interesting cases —
 * exact registry aliases (which must resolve perfectly) mixed with bounded
 * random headers (which exercise the score bounds and the unmapped path).
 */
const arbHeader: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...ALL_ALIASES),
  arbJunkHeader,
);

// Feature: ott-kpi-benchmarking-engine, Property 14: For any pair of header strings, the similarity score lies in [0.00, 1.00] and is symmetric; an exact alias match scores 1.00 and is always proposed; and an auto-mapping is proposed only when the best candidate score is >= 0.80, otherwise the column is left unmapped.
describe("FuzzyMatcher — Property 14: bounded symmetric similarity and threshold-gated auto-mapping", () => {
  it("similarity is bounded to [0,1] and symmetric for any pair of headers", () => {
    fc.assert(
      fc.property(arbHeader, arbHeader, (a, b) => {
        const na = normalizeHeader(a);
        const nb = normalizeHeader(b);

        const sab = diceSimilarity(na, nb);
        const sba = diceSimilarity(nb, na);

        // Bounded in [0.00, 1.00].
        expect(sab).toBeGreaterThanOrEqual(0);
        expect(sab).toBeLessThanOrEqual(1);

        // Symmetric.
        expect(sab).toBe(sba);
      }),
      { numRuns: 100 },
    );
  });

  it("an exact alias always scores 1.00 and is always proposed", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_ALIASES), (alias) => {
        const result = matchHeader(alias);
        expect(result.score).toBe(1);
        expect(result.target).not.toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("a target is proposed iff the best score clears the auto-map threshold", () => {
    fc.assert(
      fc.property(arbHeader, (header) => {
        const result = matchHeader(header);

        // Reported score is always within bounds.
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);

        if (result.score >= AUTO_MAP_THRESHOLD) {
          // At or above threshold: a target must be proposed.
          expect(result.target).not.toBeNull();
        } else {
          // Below threshold: the column is left unmapped.
          expect(result.target).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });
});
