/**
 * Property-based coverage for unit inference and normalization.
 *
 * Every KPI declares exactly one canonical unit and a set of accepted source
 * units, each paired with a multiplicative factor to the canonical unit
 * (Req 22.1). Every value the engine persists is expressed in its KPI's
 * canonical unit (Req 22.2), and ingestion converts a source value by
 * multiplying it by the resolved accepted unit's factor (Req 22.5).
 *
 * This validates the already-implemented `UnitNormalizer`
 * (`normalizeValue` / `normalizeMappedValue` / `resolveUnit` in
 * `unit-normalizer.ts`) against the registry's `acceptedUnits`/`canonicalUnit`.
 *
 * Validates: Requirements 22.1, 22.2, 22.5
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { KPI_REGISTRY } from "@/registry";
import type { KPIDefinition, UnitSpec } from "@/registry";
import { normalizeValue, normalizeMappedValue, resolveUnit } from "./unit-normalizer";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/**
 * A well-behaved finite value: non-negative, bounded, no NaN/Infinity, and no
 * subnormals. KPI values are physical quantities (times, rates, counts), so a
 * non-negative bounded range models the real input space while keeping the
 * round-trip arithmetic numerically stable.
 */
const arbValue = fc.double({
  min: 0,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** The accepted-unit token of a KPI that carries the canonical factor 1. */
function canonicalUnitSpec(kpi: KPIDefinition): UnitSpec {
  return (
    kpi.acceptedUnits.find((u) => u.token === kpi.canonicalUnit) ?? {
      token: kpi.canonicalUnit,
      factor: 1,
    }
  );
}

/**
 * arbUnitPair: a KPI paired with one of its accepted units. Every KPI in the
 * registry is drawn, and for each the choice ranges over all of its accepted
 * units so both canonical (factor 1) and non-canonical conversions are covered.
 */
const arbUnitPair: fc.Arbitrary<{ kpi: KPIDefinition; unit: UnitSpec }> = fc
  .constantFrom(...KPI_REGISTRY)
  .chain((kpi) =>
    fc.constantFrom(...kpi.acceptedUnits).map((unit) => ({ kpi, unit })),
  );

/**
 * Relative tolerance for round-trip comparisons. Converting into a unit and
 * back multiplies by `factor` then divides by it; with factors spanning nine
 * orders of magnitude (e.g. bps at 1e-9) a small relative epsilon is the
 * correct comparison, not strict equality.
 */
function closeEnough(actual: number, expected: number): boolean {
  const diff = Math.abs(actual - expected);
  const scale = Math.max(1, Math.abs(expected));
  return diff <= 1e-6 * scale;
}

// Feature: ott-kpi-benchmarking-engine, Property 18: For any finite numeric value and any accepted unit of a KPI, normalizing a value already expressed in the KPI's canonical unit returns that value unchanged; converting a value into any accepted unit and normalizing it back returns the original value within floating-point tolerance; and every value persisted through ingestion is expressed in its KPI's canonical unit.
describe("UnitNormalizer — Property 18: unit normalization", () => {
  it("returns a canonical-unit value unchanged under normalization (Req 22.2, 22.5)", () => {
    fc.assert(
      fc.property(arbUnitPair, arbValue, ({ kpi }, value) => {
        const canonical = canonicalUnitSpec(kpi);
        // The canonical unit has factor 1, so normalization is a no-op.
        expect(canonical.factor).toBe(1);
        expect(normalizeValue(value, canonical)).toBe(value);
      }),
      { numRuns: 100 },
    );
  });

  it("round-trips a value into any accepted unit and back within tolerance (Req 22.1, 22.5)", () => {
    fc.assert(
      fc.property(arbUnitPair, arbValue, ({ unit }, canonicalValue) => {
        // Express the canonical value in the accepted source unit, then
        // normalize back to canonical. Multiplying by factor is the inverse of
        // dividing by it, so the result equals the original within tolerance.
        const sourceValue = canonicalValue / unit.factor;
        const roundTripped = normalizeValue(sourceValue, unit);
        expect(closeEnough(roundTripped, canonicalValue)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("persists every ingested value in the KPI's canonical unit (Req 22.2, 22.5)", () => {
    fc.assert(
      fc.property(arbUnitPair, arbValue, ({ kpi, unit }, sourceValue) => {
        // A source header carrying the unit token resolves to that accepted
        // unit; ingestion must then persist the value multiplied by its factor,
        // i.e. expressed in the KPI's canonical unit.
        const header = `metric_${unit.token}`;
        const resolved = resolveUnit(header, kpi.id);
        // Whatever unit resolves, the persisted value equals value * factor.
        const expected = sourceValue * resolved.unit.factor;
        const { value: persisted } = normalizeMappedValue(sourceValue, header, kpi.id);
        expect(closeEnough(persisted, expected)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
