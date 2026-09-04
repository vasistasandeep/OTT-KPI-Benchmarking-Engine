/**
 * Sanity unit tests for the comparator (`computeDelta`, `classifyRAG`).
 *
 * The exhaustive delta-identity, variance-band/directionality, no-data-
 * propagation, and confidence-gate coverage lives in the dedicated property
 * tests (tasks 8.2-8.5). These examples pin the concrete behaviours called out
 * in Req 11.3-11.6, 16.5, and 25.
 */

import { describe, it, expect } from "vitest";
import { NO_DATA, NOT_AGGREGABLE } from "../models/sentinels";
import type { SLAConfig } from "../models/config";
import { computeDelta, classifyRAG } from "./comparator";

/** A baseline SLA config with the gate active (band 1.5%, floor 100). */
const sla: SLAConfig = {
  varianceBand: 1.5,
  thresholds: {},
  minSampleSize: 100,
};

/** SLA config with the confidence gate disabled (minSampleSize == 0). */
const slaNoGate: SLAConfig = { ...sla, minSampleSize: 0 };

describe("computeDelta — delta identities (Req 11.3, 11.4)", () => {
  it("absoluteDelta is appB - appA", () => {
    expect(computeDelta(100, 120).absoluteDelta).toBe(20);
    expect(computeDelta(120, 100).absoluteDelta).toBe(-20);
  });

  it("percentDelta is 100*(appB-appA)/appA rounded to 2 decimals", () => {
    // 100 * (110 - 100) / 100 = 10
    expect(computeDelta(100, 110).percentDelta).toBe(10);
    // 100 * (2 - 3) / 3 = -33.333... -> -33.33
    expect(computeDelta(3, 2).percentDelta).toBe(-33.33);
  });

  it("percentDelta sign matches absoluteDelta sign", () => {
    const up = computeDelta(50, 75);
    expect(Math.sign(up.absoluteDelta as number)).toBe(Math.sign(up.percentDelta as number));
    const down = computeDelta(75, 50);
    expect(Math.sign(down.absoluteDelta as number)).toBe(Math.sign(down.percentDelta as number));
  });

  it("percentDelta is 'N/A' when appA == 0 but absoluteDelta is still computed", () => {
    const result = computeDelta(0, 42);
    expect(result.percentDelta).toBe("N/A");
    expect(result.absoluteDelta).toBe(42);
  });

  it("both deltas are NO_DATA when either value is a sentinel", () => {
    expect(computeDelta(NO_DATA, 42)).toEqual({ absoluteDelta: NO_DATA, percentDelta: NO_DATA });
    expect(computeDelta(42, NOT_AGGREGABLE)).toEqual({
      absoluteDelta: NO_DATA,
      percentDelta: NO_DATA,
    });
  });
});

describe("classifyRAG — sentinel gate (Req 16.5)", () => {
  it("either NO_DATA -> NoData with reason no_data", () => {
    expect(classifyRAG(NO_DATA, 100, "higher_is_better", slaNoGate, 999, 999)).toEqual({
      rag: "NoData",
      suppressionReason: "no_data",
    });
  });

  it("either NOT_AGGREGABLE -> NoData with reason not_aggregable", () => {
    expect(classifyRAG(100, NOT_AGGREGABLE, "higher_is_better", slaNoGate, 999, 999)).toEqual({
      rag: "NoData",
      suppressionReason: "not_aggregable",
    });
  });

  it("NOT_AGGREGABLE takes precedence when both sentinels present", () => {
    expect(classifyRAG(NOT_AGGREGABLE, NO_DATA, "higher_is_better", slaNoGate, 999, 999)).toEqual({
      rag: "NoData",
      suppressionReason: "not_aggregable",
    });
  });
});

describe("classifyRAG — confidence gate (Req 25.4, 25.6, 25.11)", () => {
  it("either app below minSampleSize -> LowConfidence", () => {
    expect(classifyRAG(100, 150, "higher_is_better", sla, 50, 999)).toEqual({
      rag: "LowConfidence",
      suppressionReason: "below_min_sample",
    });
    expect(classifyRAG(100, 150, "higher_is_better", sla, 999, 50)).toEqual({
      rag: "LowConfidence",
      suppressionReason: "below_min_sample",
    });
  });

  it("both apps at or above the floor -> classified normally", () => {
    expect(classifyRAG(100, 150, "higher_is_better", sla, 100, 100).rag).toBe("Green");
  });

  it("minSampleSize == 0 disables the gate", () => {
    expect(classifyRAG(100, 150, "higher_is_better", slaNoGate, 1, 1).rag).toBe("Green");
  });
});

describe("classifyRAG — variance band and directionality (Req 11.5, 11.6)", () => {
  it("within the band on either side -> Amber", () => {
    // 100 * (101 - 100) / 100 = 1% <= 1.5%
    expect(classifyRAG(100, 101, "higher_is_better", slaNoGate, 1, 1).rag).toBe("Amber");
    expect(classifyRAG(100, 99, "lower_is_better", slaNoGate, 1, 1).rag).toBe("Amber");
  });

  it("higher_is_better: improvement above band -> Green, degradation -> Red", () => {
    expect(classifyRAG(100, 110, "higher_is_better", slaNoGate, 1, 1).rag).toBe("Green");
    expect(classifyRAG(100, 90, "higher_is_better", slaNoGate, 1, 1).rag).toBe("Red");
  });

  it("lower_is_better: improvement above band -> Green, degradation -> Red", () => {
    expect(classifyRAG(100, 90, "lower_is_better", slaNoGate, 1, 1).rag).toBe("Green");
    expect(classifyRAG(100, 110, "lower_is_better", slaNoGate, 1, 1).rag).toBe("Red");
  });

  it("flipping directionality swaps Green <-> Red, leaves Amber unchanged", () => {
    const green = classifyRAG(100, 130, "higher_is_better", slaNoGate, 1, 1).rag;
    const flipped = classifyRAG(100, 130, "lower_is_better", slaNoGate, 1, 1).rag;
    expect(green).toBe("Green");
    expect(flipped).toBe("Red");
    const amberHigh = classifyRAG(100, 101, "higher_is_better", slaNoGate, 1, 1).rag;
    const amberLow = classifyRAG(100, 101, "lower_is_better", slaNoGate, 1, 1).rag;
    expect(amberHigh).toBe("Amber");
    expect(amberLow).toBe("Amber");
  });
});

describe("classifyRAG — appA == 0 absolute-sign path (Req 11.4)", () => {
  it("higher_is_better: appB > 0 -> Green", () => {
    expect(classifyRAG(0, 5, "higher_is_better", slaNoGate, 1, 1).rag).toBe("Green");
  });

  it("higher_is_better: appB < 0 -> Red", () => {
    expect(classifyRAG(0, -5, "higher_is_better", slaNoGate, 1, 1).rag).toBe("Red");
  });

  it("lower_is_better: appB > 0 -> Red", () => {
    expect(classifyRAG(0, 5, "lower_is_better", slaNoGate, 1, 1).rag).toBe("Red");
  });

  it("appB == appA == 0 -> Amber regardless of directionality", () => {
    expect(classifyRAG(0, 0, "higher_is_better", slaNoGate, 1, 1).rag).toBe("Amber");
    expect(classifyRAG(0, 0, "lower_is_better", slaNoGate, 1, 1).rag).toBe("Amber");
  });
});
