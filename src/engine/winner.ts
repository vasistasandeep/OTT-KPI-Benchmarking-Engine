/**
 * Heatmap winner determination (Req 12.2, 12.5, 23.4, 25.8, 25.9).
 *
 * Each cell of the Winner Heatmap compares App_A against App_B for one KPI over
 * one dimension segment and declares which app "wins" that cell. The verdict is
 * directionality-aware: for a `higher_is_better` KPI the larger value wins, for
 * a `lower_is_better` KPI the smaller value wins (design "Winner determination
 * for heatmap"). Four non-winner outcomes take precedence over any comparison so
 * the cell is never painted with a misleading verdict, and each carries its own
 * outcome tag so the UI can give it a distinct glyph and text label rather than
 * relying on fill color alone (Req 28.2):
 *
 * - `no_data` — either value is the `NO_DATA` sentinel; the cell has nothing to
 *   compare (Req 12.5).
 * - `not_aggregable` — either value is the `NOT_AGGREGABLE` sentinel; combining
 *   the underlying data for this segment would be statistically invalid
 *   (pre-aggregated unique counts or percentiles across segments, Req 23.4).
 * - `low_confidence` — either app's contributing volume is below
 *   `minSampleSize`; the sample is too thin to declare a winner, so the winner
 *   determination is skipped entirely for the cell (Req 25.8, 25.9). This gate
 *   mirrors the scorecard confidence gate; a `minSampleSize` of 0 disables it
 *   (Req 25.11).
 * - `neutral` — both values are finite, above the sample floor, and exactly
 *   equal; there is no winner (a tie, Req 12.2).
 *
 * The precedence is: sentinels first (no_data, then not_aggregable), then the
 * confidence gate, then the equal / winner comparison. Sentinels rank ahead of
 * the confidence gate because a sentinel means there is no value to gate at all.
 *
 * This module is pure: no DOM, no storage, no mutation of inputs. It mirrors the
 * comparator's gate ordering (design "Delta and RAG classification") but returns
 * a per-cell winner rather than a RAG status.
 *
 * Requirements: 12.2, 12.5, 23.4, 25.8, 25.9.
 */

import { NO_DATA, NOT_AGGREGABLE } from "../models/sentinels";
import type { Numeric } from "../models/sentinels";
import type { AppAssignment } from "../models/records";
import type { Directionality } from "../registry/kpi-types";

/**
 * Which app won a heatmap cell, or why no winner was determined.
 *
 * - `"App_A"` / `"App_B"` — that app has the better value per directionality.
 * - `"neutral"` — the two values are finite and exactly equal (a tie).
 * - `"no_data"` — one or both values are the `NO_DATA` sentinel (Req 12.5).
 * - `"not_aggregable"` — one or both values are the `NOT_AGGREGABLE` sentinel
 *   (Req 23.4).
 * - `"low_confidence"` — one or both apps are below `minSampleSize` (Req 25.9).
 */
export type WinnerOutcome =
  | AppAssignment
  | "neutral"
  | "no_data"
  | "not_aggregable"
  | "low_confidence";

/** The winner-determination result for a single heatmap cell. */
export interface HeatmapWinner {
  /**
   * The winning app, or the reason no winner was declared. See
   * {@link WinnerOutcome}.
   */
  outcome: WinnerOutcome;
  /**
   * The winning app when `outcome` is `"App_A"` or `"App_B"`, otherwise `null`.
   * A convenience so callers do not have to re-narrow the union to know whether
   * a real winner exists.
   */
  winner: AppAssignment | null;
}

/** Inputs for one heatmap cell's winner determination. */
export interface WinnerInput {
  /** App_A's aggregated value for the cell (may be a sentinel). */
  appAValue: Numeric;
  /** App_B's aggregated value for the cell (may be a sentinel). */
  appBValue: Numeric;
  /** Whether a larger value is better for this KPI (from the registry). */
  directionality: Directionality;
  /** App_A's contributing record / weight count for the cell. (Req 25.2, 25.3) */
  appAContributingRecords: number;
  /** App_B's contributing record / weight count for the cell. (Req 25.2, 25.3) */
  appBContributingRecords: number;
  /**
   * The confidence-gate floor. Either app below it yields `low_confidence`; a
   * value of 0 disables the gate (Req 25.11).
   */
  minSampleSize: number;
}

/** True when a `Numeric` is the `NOT_AGGREGABLE` sentinel. */
function isNotAggregable(value: Numeric): boolean {
  return value === NOT_AGGREGABLE;
}

/** True when a `Numeric` is the `NO_DATA` sentinel. */
function isNoData(value: Numeric): boolean {
  return value === NO_DATA;
}

/**
 * Determine the winner of a single heatmap cell (Req 12.2).
 *
 * Gate order, matching the design's precedence:
 * 1. `NO_DATA` on either side → `no_data` (Req 12.5).
 * 2. `NOT_AGGREGABLE` on either side → `not_aggregable` (Req 23.4).
 * 3. Either app's contributing volume below `minSampleSize` (and the gate is
 *    enabled, i.e. `minSampleSize > 0`) → `low_confidence`; no winner is
 *    determined (Req 25.8, 25.9).
 * 4. Finite, gated-in, equal values → `neutral` (a tie).
 * 5. Otherwise the better value per `directionality` wins: the larger for
 *    `higher_is_better`, the smaller for `lower_is_better`.
 *
 * Both values reaching step 4/5 are guaranteed finite numbers by the earlier
 * sentinel gate, so the comparison is a plain numeric `<`/`>`.
 */
export function determineWinner(input: WinnerInput): HeatmapWinner {
  const {
    appAValue,
    appBValue,
    directionality,
    appAContributingRecords,
    appBContributingRecords,
    minSampleSize,
  } = input;

  // Gate 1a — NO_DATA sentinel (Req 12.5).
  if (isNoData(appAValue) || isNoData(appBValue)) {
    return { outcome: "no_data", winner: null };
  }

  // Gate 1b — NOT_AGGREGABLE sentinel (Req 23.4).
  if (isNotAggregable(appAValue) || isNotAggregable(appBValue)) {
    return { outcome: "not_aggregable", winner: null };
  }

  // Gate 2 — minimum-sample-size confidence gate (Req 25.8, 25.9). A
  // minSampleSize of 0 disables the gate (Req 25.11).
  if (
    minSampleSize > 0 &&
    (appAContributingRecords < minSampleSize ||
      appBContributingRecords < minSampleSize)
  ) {
    return { outcome: "low_confidence", winner: null };
  }

  // Past the sentinel gate both values are finite numbers.
  const a = appAValue as number;
  const b = appBValue as number;

  // A tie has no winner (Req 12.2).
  if (a === b) {
    return { outcome: "neutral", winner: null };
  }

  // Directionality-aware comparison (Req 12.2): the better value wins.
  const appAWins =
    directionality === "higher_is_better" ? a > b : a < b;
  const winner: AppAssignment = appAWins ? "App_A" : "App_B";
  return { outcome: winner, winner };
}
