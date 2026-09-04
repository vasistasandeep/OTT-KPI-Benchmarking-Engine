/**
 * Property-based coverage for the derived-ratio (ratio-of-aggregates) invariant.
 *
 * Confirms `resolveDerived` computes a derived ratio KPI as the ratio of its
 * operands' *aggregates* over the slice — not the arithmetic mean of the
 * per-group ratios. Operand groups are generated with deliberately unequal
 * weights so that, whenever the per-group ratios differ, the ratio-of-aggregates
 * and mean-of-ratios paths diverge; the test then asserts the engine returns the
 * former and never the latter. Sentinel inheritance (NO_DATA / NOT_AGGREGABLE)
 * is also exercised.
 *
 * Validates: Requirements 24.2, 24.3, 24.4
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NO_DATA, NOT_AGGREGABLE } from "../models/sentinels";
import type { Numeric } from "../models/sentinels";
import type { CanonicalKPIId } from "../models/ids";
import type { KPIDerivation } from "../registry/kpi-types";
import { resolveDerived } from "./derived";

/** The Stickiness derivation as seeded in the KPI registry (Req 24.1). */
const stickiness: KPIDerivation = {
  operands: ["dau", "mau"],
  operation: "divide",
  scale: 100,
};

/** Round a finite number to 2 decimals, matching `resolveDerived`. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * One operand group: a numerator (DAU) and a strictly-positive denominator
 * (MAU) that acts as the group's weight. Denominators are strictly positive so
 * per-group ratios are always defined and the aggregate denominator is > 0.
 */
const arbGroup = fc.record({
  numerator: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
  // Denominator (MAU) doubles as the group weight — kept >= 1 to stay positive
  // and to make groups deliberately unequally weighted across the list.
  denominator: fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
});

/** Build an operand-aggregate lookup Map for the slice. */
function aggregates(dau: Numeric, mau: Numeric): Map<CanonicalKPIId, Numeric> {
  return new Map<CanonicalKPIId, Numeric>([
    ["dau", dau],
    ["mau", mau],
  ]);
}

describe("resolveDerived — ratio-of-aggregates, not mean-of-ratios (Property 22)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 22: For any set of operand groups, a derived ratio KPI for a slice equals the ratio of its operands' aggregates over that slice; whenever those groups are unequally weighted and their per-group ratios differ, the computed value differs from the arithmetic mean of the per-group ratios, confirming the engine takes the ratio-of-aggregates path and not the mean-of-ratios path; and if either operand aggregate is NO_DATA or NOT_AGGREGABLE, the derived value is exactly that same sentinel.
  it("equals the ratio of the summed operand aggregates over the slice", () => {
    fc.assert(
      fc.property(fc.array(arbGroup, { minLength: 1, maxLength: 200 }), (groups) => {
        // Aggregate each operand over the slice first (Req 24.2), then derive.
        const dauAgg = groups.reduce((acc, g) => acc + g.numerator, 0);
        const mauAgg = groups.reduce((acc, g) => acc + g.denominator, 0);

        const result = resolveDerived(stickiness, aggregates(dauAgg, mauAgg));

        // Denominators are >= 1 each, so the aggregate denominator is > 0.
        const expected = round2((100 * dauAgg) / mauAgg);
        expect(result.value).toBe(expected);
        expect(result.responsibleOperand).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it("differs from the arithmetic mean of the per-group ratios when groups are unequally weighted and their ratios differ", () => {
    fc.assert(
      fc.property(fc.array(arbGroup, { minLength: 2, maxLength: 200 }), (groups) => {
        const perGroupRatios = groups.map((g) => (100 * g.numerator) / g.denominator);
        const weights = groups.map((g) => g.denominator);

        // Only meaningful when the groups actually carry unequal weight AND
        // their per-group ratios differ — otherwise the two paths coincide.
        const distinctRatios = new Set(perGroupRatios.map((r) => r.toFixed(9)));
        const distinctWeights = new Set(weights.map((w) => w.toFixed(9)));
        fc.pre(distinctRatios.size > 1);
        fc.pre(distinctWeights.size > 1);

        const dauAgg = groups.reduce((acc, g) => acc + g.numerator, 0);
        const mauAgg = groups.reduce((acc, g) => acc + g.denominator, 0);
        const ratioOfAggregates = (100 * dauAgg) / mauAgg;

        const meanOfRatios =
          perGroupRatios.reduce((acc, r) => acc + r, 0) / perGroupRatios.length;

        // The two paths must be distinguishable *after rounding* for the
        // "not the mean" assertion to prove anything; skip cases where they
        // collapse to the same reported 2-decimal value.
        fc.pre(round2(ratioOfAggregates) !== round2(meanOfRatios));

        const result = resolveDerived(stickiness, aggregates(dauAgg, mauAgg));

        // The engine returns the ratio-of-aggregates value...
        expect(result.value).toBe(round2(ratioOfAggregates));
        // ...and specifically NOT the mean-of-ratios value.
        expect(result.value).not.toBe(round2(meanOfRatios));
      }),
      { numRuns: 100 },
    );
  });
});

describe("resolveDerived — operand sentinel inheritance (Property 22, Req 24.4)", () => {
  const sentinel = fc.constantFrom<Numeric>(NO_DATA, NOT_AGGREGABLE);
  const finite = fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true });

  it("inherits the numerator's sentinel exactly and names it", () => {
    fc.assert(
      fc.property(sentinel, finite, (dau, mau) => {
        const result = resolveDerived(stickiness, aggregates(dau, mau));
        expect(result.value).toBe(dau);
        expect(result.responsibleOperand).toBe("dau");
      }),
      { numRuns: 100 },
    );
  });

  it("inherits the denominator's sentinel exactly and names it when the numerator is finite", () => {
    fc.assert(
      fc.property(finite, sentinel, (dau, mau) => {
        const result = resolveDerived(stickiness, aggregates(dau, mau));
        expect(result.value).toBe(mau);
        expect(result.responsibleOperand).toBe("mau");
      }),
      { numRuns: 100 },
    );
  });

  it("inherits a sentinel whenever either operand aggregate is a sentinel", () => {
    fc.assert(
      fc.property(
        fc.oneof(sentinel, finite),
        fc.oneof(sentinel, finite),
        (dau, mau) => {
          const dauIsSentinel = dau === NO_DATA || dau === NOT_AGGREGABLE;
          const mauIsSentinel = mau === NO_DATA || mau === NOT_AGGREGABLE;
          fc.pre(dauIsSentinel || mauIsSentinel);

          const result = resolveDerived(stickiness, aggregates(dau, mau));

          // The numerator is checked first in declaration order, so it wins a tie.
          if (dauIsSentinel) {
            expect(result.value).toBe(dau);
            expect(result.responsibleOperand).toBe("dau");
          } else {
            expect(result.value).toBe(mau);
            expect(result.responsibleOperand).toBe("mau");
          }
          // The result is exactly one of the two sentinels, never a number.
          expect(result.value === NO_DATA || result.value === NOT_AGGREGABLE).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
