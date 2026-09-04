/**
 * Property-based coverage for the percentile monotonicity and bounds invariant.
 *
 * Validates the numeric core used to compute Video Start Time P50/P95, Manifest
 * Fetch Latency, and TTFB percentiles over a group's raw latency distribution.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NO_DATA } from "../models/sentinels";
import { percentile } from "./percentile";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** A single non-negative, finite latency sample (ms). */
const arbLatency = fc.double({
  min: 0,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A non-empty list of non-negative latency values. */
const arbNonEmptyLatencies = fc.array(arbLatency, {
  minLength: 1,
  maxLength: 200,
});

describe("percentile — monotonicity and bounds (Property 1)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 1: For any non-empty list of non-negative latency values, the computed percentiles satisfy min(values) <= P50 <= P90 <= P95 <= max(values), and for an empty list every percentile is the NO_DATA sentinel.
  it("keeps P50 <= P90 <= P95 within [min, max] for non-empty inputs", () => {
    fc.assert(
      fc.property(arbNonEmptyLatencies, (values) => {
        const min = Math.min(...values);
        const max = Math.max(...values);

        const p50 = percentile(values, 50);
        const p90 = percentile(values, 90);
        const p95 = percentile(values, 95);

        // Non-empty non-negative input never produces a sentinel.
        expect(typeof p50).toBe("number");
        expect(typeof p90).toBe("number");
        expect(typeof p95).toBe("number");

        const v50 = p50 as number;
        const v90 = p90 as number;
        const v95 = p95 as number;

        // min <= P50 <= P90 <= P95 <= max (allowing floating-point slack).
        const eps = 1e-9;
        expect(min - eps).toBeLessThanOrEqual(v50);
        expect(v50).toBeLessThanOrEqual(v90 + eps);
        expect(v90).toBeLessThanOrEqual(v95 + eps);
        expect(v95).toBeLessThanOrEqual(max + eps);
      }),
      { numRuns: 100 },
    );
  });

  it("returns NO_DATA for every percentile of an empty list", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 25, 50, 90, 95, 99, 100),
        (p) => {
          expect(percentile([], p)).toBe(NO_DATA);
        },
      ),
      { numRuns: 100 },
    );
  });
});
