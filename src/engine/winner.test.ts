/**
 * Sanity unit tests for `determineWinner` (heatmap winner determination).
 *
 * The exhaustive directionality / flip / no-data coverage lives in the
 * dedicated property test (task 8.7). These examples pin the concrete
 * behaviours called out in Req 12.2, 12.5, 23.4, 25.8, 25.9: the
 * directionality-aware winner, the neutral tie, the two sentinel cells, and the
 * low-confidence gate (including its disabling at minSampleSize 0).
 */

import { describe, it, expect } from "vitest";
import { NO_DATA, NOT_AGGREGABLE } from "../models/sentinels";
import type { Directionality } from "../registry/kpi-types";
import { determineWinner } from "./winner";
import type { WinnerInput } from "./winner";

/** Build a WinnerInput with sensible, gate-passing defaults. */
function cell(overrides: Partial<WinnerInput> = {}): WinnerInput {
  return {
    appAValue: 10,
    appBValue: 20,
    directionality: "higher_is_better",
    appAContributingRecords: 1000,
    appBContributingRecords: 1000,
    minSampleSize: 100,
    ...overrides,
  };
}

describe("determineWinner — directionality-aware winner (Req 12.2)", () => {
  it("higher_is_better: the larger value wins", () => {
    const higherWinsB = determineWinner(
      cell({ appAValue: 10, appBValue: 20, directionality: "higher_is_better" }),
    );
    expect(higherWinsB.outcome).toBe("App_B");
    expect(higherWinsB.winner).toBe("App_B");

    const higherWinsA = determineWinner(
      cell({ appAValue: 30, appBValue: 20, directionality: "higher_is_better" }),
    );
    expect(higherWinsA.outcome).toBe("App_A");
    expect(higherWinsA.winner).toBe("App_A");
  });

  it("lower_is_better: the smaller value wins", () => {
    const lowerWinsA = determineWinner(
      cell({ appAValue: 10, appBValue: 20, directionality: "lower_is_better" }),
    );
    expect(lowerWinsA.outcome).toBe("App_A");
    expect(lowerWinsA.winner).toBe("App_A");
  });

  it("flipping directionality flips the winner for distinct values", () => {
    const higher = determineWinner(
      cell({ appAValue: 10, appBValue: 20, directionality: "higher_is_better" }),
    );
    const lower = determineWinner(
      cell({ appAValue: 10, appBValue: 20, directionality: "lower_is_better" }),
    );
    expect(higher.winner).toBe("App_B");
    expect(lower.winner).toBe("App_A");
  });
});

describe("determineWinner — tie (Req 12.2)", () => {
  it("equal finite values yield a neutral, no-winner result", () => {
    for (const directionality of ["higher_is_better", "lower_is_better"] as Directionality[]) {
      const result = determineWinner(cell({ appAValue: 42, appBValue: 42, directionality }));
      expect(result.outcome).toBe("neutral");
      expect(result.winner).toBeNull();
    }
  });
});

describe("determineWinner — sentinel cells (Req 12.5, 23.4)", () => {
  it("either value NO_DATA → no-data cell", () => {
    const a = determineWinner(cell({ appAValue: NO_DATA }));
    const b = determineWinner(cell({ appBValue: NO_DATA }));
    expect(a.outcome).toBe("no_data");
    expect(a.winner).toBeNull();
    expect(b.outcome).toBe("no_data");
  });

  it("either value NOT_AGGREGABLE → not-aggregable cell", () => {
    const a = determineWinner(cell({ appAValue: NOT_AGGREGABLE }));
    const b = determineWinner(cell({ appBValue: NOT_AGGREGABLE }));
    expect(a.outcome).toBe("not_aggregable");
    expect(a.winner).toBeNull();
    expect(b.outcome).toBe("not_aggregable");
  });

  it("NO_DATA takes precedence over the confidence gate", () => {
    const result = determineWinner(
      cell({ appAValue: NO_DATA, appAContributingRecords: 1 }),
    );
    expect(result.outcome).toBe("no_data");
  });

  it("NOT_AGGREGABLE takes precedence over the confidence gate", () => {
    const result = determineWinner(
      cell({ appBValue: NOT_AGGREGABLE, appBContributingRecords: 1 }),
    );
    expect(result.outcome).toBe("not_aggregable");
  });
});

describe("determineWinner — confidence gate (Req 25.8, 25.9)", () => {
  it("either app below minSampleSize → low-confidence, no winner", () => {
    const aThin = determineWinner(cell({ appAContributingRecords: 50, minSampleSize: 100 }));
    const bThin = determineWinner(cell({ appBContributingRecords: 50, minSampleSize: 100 }));
    expect(aThin.outcome).toBe("low_confidence");
    expect(aThin.winner).toBeNull();
    expect(bThin.outcome).toBe("low_confidence");
  });

  it("both apps at or above the floor are gated in and compared normally", () => {
    const result = determineWinner(
      cell({ appAContributingRecords: 100, appBContributingRecords: 100 }),
    );
    expect(result.outcome).toBe("App_B");
  });

  it("minSampleSize of 0 disables the gate (Req 25.11)", () => {
    const result = determineWinner(
      cell({ appAContributingRecords: 0, appBContributingRecords: 0, minSampleSize: 0 }),
    );
    expect(result.outcome).toBe("App_B");
  });
});
