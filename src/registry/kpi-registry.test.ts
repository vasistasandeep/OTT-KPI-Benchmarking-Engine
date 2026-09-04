/**
 * KPI registry shape snapshot test (Task 3.2).
 *
 * These assertions lock the structural contract every KPI in the taxonomy must
 * satisfy so that downstream unit normalization, aggregation, and raw-mode
 * coverage logic can rely on it:
 *
 *   - every KPI declares a non-empty `canonicalUnit`;
 *   - `acceptedUnits` is non-empty and contains an entry whose `token` equals
 *     `canonicalUnit` at `factor` 1 (the canonical unit is always accepted at
 *     identity) — Req 22.1;
 *   - `aggregation` is present and one of the known aggregation kinds;
 *   - `rawModeComputable` is a boolean — Req 1.2;
 *   - KPIs that are not raw-mode-computable (the "conditional" KPIs that require
 *     session fields absent from a playback log) are explicitly flagged.
 *
 * Validates: Requirements 1.1, 1.2, 22.1
 */

import { describe, expect, it } from "vitest";

import {
  ALL_KPI_IDS,
  KPI_BY_ID,
  KPI_REGISTRY,
} from "./kpi-registry";
import type { AggregationKind, KPIDefinition } from "./kpi-types";

const VALID_AGGREGATION_KINDS: readonly AggregationKind[] = [
  "weighted_avg",
  "percentile",
  "sum",
  "ratio",
  "arithmetic_avg",
  "distinct_count",
  "non_aggregable",
];

describe("KPI registry shape", () => {
  it("seeds a non-empty registry with unique ids covering all four pillars (Req 1.1)", () => {
    expect(KPI_REGISTRY.length).toBeGreaterThan(0);

    const ids = KPI_REGISTRY.map((kpi) => kpi.id);
    expect(new Set(ids).size).toBe(ids.length);
    // KPI_BY_ID and ALL_KPI_IDS stay in sync with the source array.
    expect(ALL_KPI_IDS).toEqual(ids);
    expect(Object.keys(KPI_BY_ID).sort()).toEqual([...ids].sort());

    const pillars = new Set(KPI_REGISTRY.map((kpi) => kpi.pillar));
    expect(pillars).toEqual(
      new Set([
        "Playback Quality & QoE",
        "User Engagement & Audience Retention",
        "Monetization & AdTech",
        "Infrastructure & Delivery",
      ]),
    );
  });

  describe.each(KPI_REGISTRY.map((kpi) => [kpi.id, kpi] as const))(
    "%s",
    (_id, kpi: KPIDefinition) => {
      it("declares a non-empty canonicalUnit (Req 22.1)", () => {
        expect(typeof kpi.canonicalUnit).toBe("string");
        expect(kpi.canonicalUnit.trim().length).toBeGreaterThan(0);
        // The display unit mirrors the canonical unit.
        expect(kpi.unit).toBe(kpi.canonicalUnit);
      });

      it("has a non-empty acceptedUnits list (Req 22.1)", () => {
        expect(Array.isArray(kpi.acceptedUnits)).toBe(true);
        expect(kpi.acceptedUnits.length).toBeGreaterThan(0);
        for (const spec of kpi.acceptedUnits) {
          expect(typeof spec.token).toBe("string");
          expect(spec.token.length).toBeGreaterThan(0);
          expect(typeof spec.factor).toBe("number");
          expect(Number.isFinite(spec.factor)).toBe(true);
        }
      });

      it("accepts its canonical unit at factor 1 (Req 22.1)", () => {
        const canonicalEntry = kpi.acceptedUnits.find(
          (spec) => spec.token === kpi.canonicalUnit,
        );
        expect(canonicalEntry).toBeDefined();
        expect(canonicalEntry?.factor).toBe(1);
      });

      it("declares a valid aggregation kind", () => {
        expect(kpi.aggregation).toBeDefined();
        expect(VALID_AGGREGATION_KINDS).toContain(kpi.aggregation);
      });

      it("declares rawModeComputable as a boolean (Req 1.2)", () => {
        expect(typeof kpi.rawModeComputable).toBe("boolean");
      });
    },
  );

  it("flags at least one conditional (non-raw-mode-computable) KPI (Req 1.2)", () => {
    // KPIs that need lifecycle/billing data absent from a playback session log
    // are explicitly marked so raw-mode aggregation can exclude them.
    const conditional = KPI_REGISTRY.filter((kpi) => !kpi.rawModeComputable);
    expect(conditional.length).toBeGreaterThan(0);
    for (const kpi of conditional) {
      expect(kpi.rawModeComputable).toBe(false);
    }
  });
});
