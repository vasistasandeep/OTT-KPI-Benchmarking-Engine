/**
 * Table-driven example tests for the SLA-config validation logic (task 18.2).
 *
 * These exercise the pure, DOM-free rules in `sla-config.ts` — the same
 * derivation the `SLAConfigPanel` renders — so the whole SLA-entry decision
 * path is covered without mounting a component. Each acceptance criterion is
 * walked from a data table so a new scenario is added by appending a row:
 *
 *   - Threshold range validation (Req 14.4): a non-numeric or out-of-range
 *     threshold is rejected, and the rejection message names that KPI's valid
 *     range so the user can correct it. A per-field failure flags only that
 *     KPI's field and leaves the rest of the draft submittable.
 *   - Min-sample-size validation (Req 25.10): only a non-negative integer is
 *     accepted; anything else (non-numeric, negative, or fractional) is
 *     rejected with the "non-negative integer" message.
 *   - Disable-at-0 (Req 25.11): 0 is a valid min sample size (it disables the
 *     confidence gate) and must not be rejected.
 *
 * Requirements: 14.4, 25.10, 25.11.
 */

import { describe, it, expect } from "vitest";
import type { CanonicalKPIId } from "@/models/ids";
import {
  classifyThreshold,
  classifyMinSampleSize,
  validateSLAConfig,
  buildSLAConfig,
  formatValidRange,
  type SLAConfigDraft,
} from "./sla-config";

// VST P50 is bounded [0, 60] s in the registry; Rebuffer Ratio is [0, 100] %.
const VST = "vst_p50" as CanonicalKPIId;
const REBUFFER = "rebuffer_ratio" as CanonicalKPIId;

/** A draft with valid variance band / min sample size and the given thresholds. */
function draft(thresholds: Partial<Record<CanonicalKPIId, string>>): SLAConfigDraft {
  return { thresholds, varianceBand: "5", minSampleSize: "100" };
}

// ===========================================================================
// Req 14.4 — threshold range validation. A non-numeric or out-of-range entry
// is rejected, and the message names the KPI's valid range.
// ===========================================================================

interface ThresholdCase {
  readonly name: string;
  readonly kpiId: CanonicalKPIId;
  readonly text: string;
  readonly kind: "blank" | "invalid" | "value";
  /** For value cases, the parsed number. */
  readonly value?: number;
}

const THRESHOLD_CASES: readonly ThresholdCase[] = [
  // --- accepted: in-range and boundary values ---------------------------
  { name: "an in-range value", kpiId: VST, text: "1.5", kind: "value", value: 1.5 },
  { name: "the lower boundary (0)", kpiId: VST, text: "0", kind: "value", value: 0 },
  { name: "the upper boundary (60)", kpiId: VST, text: "60", kind: "value", value: 60 },
  { name: "an in-range percent", kpiId: REBUFFER, text: "0.4", kind: "value", value: 0.4 },
  // --- blank: no override, not an error ---------------------------------
  { name: "an empty field", kpiId: VST, text: "", kind: "blank" },
  { name: "a whitespace-only field", kpiId: VST, text: "   ", kind: "blank" },
  // --- rejected: non-numeric --------------------------------------------
  { name: "a non-numeric entry", kpiId: VST, text: "fast", kind: "invalid" },
  { name: "a stray-unit entry", kpiId: VST, text: "1.5s", kind: "invalid" },
  // --- rejected: out of range -------------------------------------------
  { name: "a below-range value", kpiId: VST, text: "-1", kind: "invalid" },
  { name: "an above-range value", kpiId: VST, text: "61", kind: "invalid" },
  { name: "an above-range percent", kpiId: REBUFFER, text: "150", kind: "invalid" },
];

describe("classifyThreshold examples — threshold range validation (Req 14.4)", () => {
  it.each(THRESHOLD_CASES)(
    "classifies $name for $kpiId",
    ({ kpiId, text, kind, value }) => {
      const result = classifyThreshold(kpiId, text);
      expect(result.kind).toBe(kind);

      if (result.kind === "value") {
        expect(result.value).toBe(value);
      }

      if (result.kind === "invalid") {
        // The rejection names the KPI's valid range so the user can correct it.
        expect(result.reason).toContain(formatValidRange(kpiId));
      }
    },
  );
});

describe("validateSLAConfig examples — per-field threshold rejection (Req 14.4)", () => {
  it("rejects each invalid threshold naming its KPI's valid range", () => {
    const result = validateSLAConfig(draft({ [VST]: "999", [REBUFFER]: "abc" }));

    expect(result.valid).toBe(false);
    expect(result.thresholdErrors).toHaveLength(2);

    const vstError = result.thresholdErrors.find((e) => e.kpiId === VST)!;
    expect(vstError.reason).toContain(formatValidRange(VST)); // "0–60 s"

    const rebufferError = result.thresholdErrors.find((e) => e.kpiId === REBUFFER)!;
    expect(rebufferError.reason).toContain(formatValidRange(REBUFFER)); // "0–100 %"
  });

  it("flags only the invalid field, leaving valid siblings submittable", () => {
    const result = validateSLAConfig(draft({ [VST]: "1.5", [REBUFFER]: "999" }));

    expect(result.valid).toBe(false);
    // Only rebuffer_ratio is flagged; the valid VST field carries no error.
    expect(result.thresholdErrors.map((e) => e.kpiId)).toEqual([REBUFFER]);

    // The clean field still lands in the built config.
    const config = buildSLAConfig(draft({ [VST]: "1.5", [REBUFFER]: "999" }));
    expect(config.thresholds[VST]).toBe(1.5);
    expect(config.thresholds[REBUFFER]).toBeUndefined(); // invalid entry not saved
  });

  it("is valid when every threshold parses in range (blanks allowed)", () => {
    const result = validateSLAConfig(draft({ [VST]: "1.5", [REBUFFER]: "" }));
    expect(result.valid).toBe(true);
    expect(result.thresholdErrors).toHaveLength(0);
  });
});

// ===========================================================================
// Req 25.10 / 25.11 — min-sample-size validation and disable-at-0.
// ===========================================================================

interface MinSampleCase {
  readonly name: string;
  readonly text: string;
  readonly kind: "value" | "invalid";
  readonly value?: number;
}

const MIN_SAMPLE_CASES: readonly MinSampleCase[] = [
  // --- accepted: non-negative integers ----------------------------------
  { name: "the default (100)", text: "100", kind: "value", value: 100 },
  { name: "a large integer", text: "5000", kind: "value", value: 5000 },
  // Req 25.11 — 0 is valid and disables the confidence gate.
  { name: "zero (disables the gate)", text: "0", kind: "value", value: 0 },
  // --- rejected: not a non-negative integer -----------------------------
  { name: "a negative integer", text: "-1", kind: "invalid" },
  { name: "a fractional value", text: "1.5", kind: "invalid" },
  { name: "a non-numeric entry", text: "many", kind: "invalid" },
  { name: "an empty field", text: "", kind: "invalid" },
];

describe("classifyMinSampleSize examples — non-negative integer rule (Req 25.10, 25.11)", () => {
  it.each(MIN_SAMPLE_CASES)("classifies $name", ({ text, kind, value }) => {
    const result = classifyMinSampleSize(text);
    expect(result.kind).toBe(kind);

    if (result.kind === "value") {
      expect(result.value).toBe(value);
    }

    if (result.kind === "invalid") {
      // Req 25.10 — the rejection states the non-negative-integer requirement.
      expect(result.reason).toBe("Min sample size must be a non-negative integer");
    }
  });
});

describe("validateSLAConfig examples — min-sample-size field (Req 25.10, 25.11)", () => {
  it("rejects a non-integer min sample size with the required message", () => {
    const result = validateSLAConfig({
      thresholds: {},
      varianceBand: "5",
      minSampleSize: "1.5",
    });
    expect(result.valid).toBe(false);
    expect(result.minSampleSizeError).toBe(
      "Min sample size must be a non-negative integer",
    );
  });

  it("accepts 0 as a valid min sample size that disables the gate (Req 25.11)", () => {
    const result = validateSLAConfig({
      thresholds: {},
      varianceBand: "5",
      minSampleSize: "0",
    });
    expect(result.valid).toBe(true);
    expect(result.minSampleSizeError).toBeUndefined();

    // 0 is carried through to the built config, where it disables the gate.
    const config = buildSLAConfig({
      thresholds: {},
      varianceBand: "5",
      minSampleSize: "0",
    });
    expect(config.minSampleSize).toBe(0);
  });
});
