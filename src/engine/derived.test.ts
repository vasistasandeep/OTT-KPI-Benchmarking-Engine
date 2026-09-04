/**
 * Sanity unit tests for `resolveDerived` (ratio-of-aggregates).
 *
 * The exhaustive ratio-of-aggregates-vs-mean-of-ratios coverage lives in the
 * dedicated property test (task 7.5). These examples pin the concrete
 * behaviours called out in Req 24: the Stickiness formula, sentinel
 * inheritance with the responsible operand named, and the zero-denominator
 * rule.
 */

import { describe, it, expect } from "vitest";
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

/** Build an operand-aggregate lookup Map. */
function aggregates(entries: Partial<Record<CanonicalKPIId, Numeric>>): Map<CanonicalKPIId, Numeric> {
  return new Map(Object.entries(entries) as [CanonicalKPIId, Numeric][]);
}

describe("resolveDerived — Stickiness (ratio-of-aggregates)", () => {
  it("computes 100 * aggregate(DAU) / aggregate(MAU)", () => {
    // 100 * 500 / 2000 = 25
    const result = resolveDerived(stickiness, aggregates({ dau: 500, mau: 2000 }));
    expect(result.value).toBe(25);
    expect(result.responsibleOperand).toBeUndefined();
  });

  it("rounds the ratio to 2 decimals", () => {
    // 100 * 1 / 3 = 33.333... -> 33.33
    const result = resolveDerived(stickiness, aggregates({ dau: 1, mau: 3 }));
    expect(result.value).toBe(33.33);
  });

  it("takes the ratio of aggregates, not the mean of per-group ratios", () => {
    // Two groups with unequal weight:
    //   group A: DAU 100, MAU 1000 -> ratio 10%
    //   group B: DAU 900, MAU 1000 -> ratio 90%
    // Ratio of aggregates: 100 * 1000 / 2000 = 50
    // Mean of per-group ratios: (10 + 90) / 2 = 50 here — so use unequal
    // weights to force a difference instead:
    //   group A: DAU 100, MAU 100   -> ratio 100%
    //   group B: DAU 100, MAU 900   -> ratio ~11.11%
    // Ratio of aggregates: 100 * 200 / 1000 = 20
    // Mean of per-group ratios: (100 + 11.11) / 2 = 55.56
    const result = resolveDerived(stickiness, aggregates({ dau: 200, mau: 1000 }));
    expect(result.value).toBe(20);
  });
});

describe("resolveDerived — sentinel inheritance (Req 24.4)", () => {
  it("inherits NO_DATA and names the responsible numerator operand", () => {
    const result = resolveDerived(stickiness, aggregates({ dau: NO_DATA, mau: 2000 }));
    expect(result.value).toBe(NO_DATA);
    expect(result.responsibleOperand).toBe("dau");
  });

  it("inherits NOT_AGGREGABLE and names the responsible denominator operand", () => {
    const result = resolveDerived(stickiness, aggregates({ dau: 500, mau: NOT_AGGREGABLE }));
    expect(result.value).toBe(NOT_AGGREGABLE);
    expect(result.responsibleOperand).toBe("mau");
  });

  it("names the first operand in declaration order when both are sentinels", () => {
    const result = resolveDerived(
      stickiness,
      aggregates({ dau: NOT_AGGREGABLE, mau: NO_DATA }),
    );
    expect(result.value).toBe(NOT_AGGREGABLE);
    expect(result.responsibleOperand).toBe("dau");
  });

  it("treats a missing operand aggregate as NO_DATA and names it", () => {
    const result = resolveDerived(stickiness, aggregates({ mau: 2000 }));
    expect(result.value).toBe(NO_DATA);
    expect(result.responsibleOperand).toBe("dau");
  });
});

describe("resolveDerived — zero-denominator rule (Req 24.5, 16.1)", () => {
  it("returns NO_DATA naming the denominator when MAU aggregates to 0", () => {
    const result = resolveDerived(stickiness, aggregates({ dau: 500, mau: 0 }));
    expect(result.value).toBe(NO_DATA);
    expect(result.responsibleOperand).toBe("mau");
  });

  it("computes normally when the numerator is 0 but the denominator is not", () => {
    // 100 * 0 / 2000 = 0
    const result = resolveDerived(stickiness, aggregates({ dau: 0, mau: 2000 }));
    expect(result.value).toBe(0);
    expect(result.responsibleOperand).toBeUndefined();
  });
});

describe("resolveDerived — operand source flexibility", () => {
  it("accepts a lookup function as well as a Map", () => {
    const values: Record<string, Numeric> = { dau: 400, mau: 1600 };
    const result = resolveDerived(stickiness, (operand) => values[operand]);
    // 100 * 400 / 1600 = 25
    expect(result.value).toBe(25);
  });
});
