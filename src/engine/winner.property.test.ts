/**
 * Property-based coverage for heatmap winner determination (Req 12.2, 12.5).
 *
 * Records the universal guarantee `determineWinner` must uphold across all
 * finite App_A / App_B pairs and both directionalities: the winner is always
 * the app with the better value for that directionality, equal values yield a
 * neutral (no-winner) tie, flipping the directionality on distinct values flips
 * the winner, and a `NO_DATA` sentinel on either side collapses the cell to
 * `no_data`. The exhaustive concrete cases (sentinels, confidence gate) live in
 * the sibling unit test `winner.test.ts`.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NO_DATA } from "../models/sentinels";
import type { Directionality } from "../registry/kpi-types";
import { determineWinner } from "./winner";
import type { WinnerInput } from "./winner";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** A finite, comparison-eligible KPI value. */
const arbFiniteValue = fc.double({
  min: -1_000_000,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Either directionality from the registry. */
const arbDirectionality = fc.constantFrom<Directionality>(
  "higher_is_better",
  "lower_is_better",
);

/** The opposite directionality — used to assert winner flips. */
function flip(directionality: Directionality): Directionality {
  return directionality === "higher_is_better"
    ? "lower_is_better"
    : "higher_is_better";
}

/**
 * A cell whose sample counts clear the confidence gate, so the outcome is
 * driven purely by the values and directionality under test.
 */
function cell(
  appAValue: WinnerInput["appAValue"],
  appBValue: WinnerInput["appBValue"],
  directionality: Directionality,
): WinnerInput {
  return {
    appAValue,
    appBValue,
    directionality,
    appAContributingRecords: 1000,
    appBContributingRecords: 1000,
    minSampleSize: 0,
  };
}

// Feature: ott-kpi-benchmarking-engine, Property 12: For any pair of finite App_A / App_B values and a directionality, the heatmap winner is the app with the better value per that directionality; equal values yield a neutral (no-winner) result; flipping the directionality on distinct values flips the winner; and if either value is NO_DATA the cell is no-data.
describe("determineWinner — Property 12: directionality-aware winner", () => {
  it("the winner is the app with the better value for the directionality", () => {
    fc.assert(
      fc.property(arbFiniteValue, arbFiniteValue, arbDirectionality, (a, b, dir) => {
        const result = determineWinner(cell(a, b, dir));

        if (a === b) {
          // Equal finite values are a tie (Req 12.2).
          expect(result.outcome).toBe("neutral");
          expect(result.winner).toBeNull();
          return;
        }

        // Distinct finite values: the better value per directionality wins.
        const expected =
          dir === "higher_is_better"
            ? a > b
              ? "App_A"
              : "App_B"
            : a < b
              ? "App_A"
              : "App_B";
        expect(result.outcome).toBe(expected);
        expect(result.winner).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("flipping directionality flips the winner for distinct values", () => {
    fc.assert(
      fc.property(arbFiniteValue, arbFiniteValue, arbDirectionality, (a, b, dir) => {
        fc.pre(a !== b);
        const original = determineWinner(cell(a, b, dir));
        const flipped = determineWinner(cell(a, b, flip(dir)));

        // Both are real winners, and they are opposite apps.
        expect(original.winner).not.toBeNull();
        expect(flipped.winner).not.toBeNull();
        expect(flipped.winner).not.toBe(original.winner);
      }),
      { numRuns: 100 },
    );
  });

  it("equal finite values yield a neutral, no-winner tie", () => {
    fc.assert(
      fc.property(arbFiniteValue, arbDirectionality, (v, dir) => {
        const result = determineWinner(cell(v, v, dir));
        expect(result.outcome).toBe("neutral");
        expect(result.winner).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("either value NO_DATA collapses the cell to no-data", () => {
    fc.assert(
      fc.property(
        arbFiniteValue,
        arbDirectionality,
        fc.constantFrom<"A" | "B" | "both">("A", "B", "both"),
        (v, dir, which) => {
          const a = which === "B" ? v : NO_DATA;
          const b = which === "A" ? v : NO_DATA;
          const result = determineWinner(cell(a, b, dir));
          expect(result.outcome).toBe("no_data");
          expect(result.winner).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
