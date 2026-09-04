/**
 * Property-based coverage for NO_DATA propagation through the comparator.
 *
 * Validates that whenever either App_A or App_B is the NO_DATA sentinel, the
 * comparator suppresses the verdict to `NoData` and reports no finite delta —
 * regardless of directionality, SLA config, or contributing counts. This
 * exercises the already-implemented `classifyRAG` (sentinel gate) and
 * `computeDelta` in src/engine/comparator.ts.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NO_DATA } from "../models/sentinels";
import type { Numeric } from "../models/sentinels";
import type { SLAConfig } from "../models/config";
import type { Directionality } from "../registry/kpi-types";
import { computeDelta, classifyRAG } from "./comparator";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** A finite numeric value (never a sentinel). */
const arbFinite: fc.Arbitrary<number> = fc.double({
  min: -1_000_000,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Either a finite value or the NO_DATA sentinel. */
const arbNumericOrNoData: fc.Arbitrary<Numeric> = fc.oneof(
  arbFinite,
  fc.constant(NO_DATA),
);

/** Either directionality. */
const arbDirectionality: fc.Arbitrary<Directionality> = fc.constantFrom(
  "higher_is_better",
  "lower_is_better",
);

/** An SLA config with an arbitrary (possibly gate-disabling) minimum sample size. */
const arbSLA: fc.Arbitrary<SLAConfig> = fc.record({
  varianceBand: fc.double({
    min: 0,
    max: 100,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  thresholds: fc.constant({}),
  minSampleSize: fc.nat({ max: 1000 }),
});

/** A non-negative contributing record count. */
const arbCount: fc.Arbitrary<number> = fc.nat({ max: 100_000 });

describe("comparator — NO_DATA propagation (Property 11)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 11: For any comparison in which either App_A or App_B value is NO_DATA, the resulting RAG status is NoData and no finite delta is reported for that comparison.
  it("either value NO_DATA -> NoData status and no finite delta", () => {
    fc.assert(
      fc.property(
        arbNumericOrNoData,
        arbNumericOrNoData,
        arbDirectionality,
        arbSLA,
        arbCount,
        arbCount,
        (appA, appB, directionality, sla, countA, countB) => {
          // Constrain to the property's premise: at least one side is NO_DATA.
          fc.pre(appA === NO_DATA || appB === NO_DATA);

          const rag = classifyRAG(
            appA,
            appB,
            directionality,
            sla,
            countA,
            countB,
          );
          // The RAG status is NoData with the no_data suppression reason.
          expect(rag.rag).toBe("NoData");
          expect(rag.suppressionReason).toBe("no_data");

          // No finite delta is reported: both deltas are the NO_DATA sentinel,
          // never a finite number.
          const delta = computeDelta(appA, appB);
          expect(delta.absoluteDelta).toBe(NO_DATA);
          expect(delta.percentDelta).toBe(NO_DATA);
          expect(typeof delta.absoluteDelta).not.toBe("number");
          expect(typeof delta.percentDelta).not.toBe("number");
        },
      ),
      { numRuns: 100 },
    );
  });
});
