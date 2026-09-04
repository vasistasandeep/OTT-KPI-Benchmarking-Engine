/**
 * Pure model for the {@link WinnerHeatmap} (Req 12; design "Winner Heatmap").
 *
 * The heatmap is a KPI × dimension-segment matrix. The analyst picks *one*
 * dimension (the segment-dimension selector, Req 12.4); the rows are the core
 * KPIs and the columns are that dimension's segment members. Each cell compares
 * App_A against App_B for its (KPI, segment) and declares a winner through the
 * shared, directionality-aware {@link determineWinner} gate (Req 12.2, 12.5,
 * 23.4, 25.8, 25.9).
 *
 * ## Where the numbers come from
 *
 * The aggregation engine already computes per-segment values into
 * `AggregatedResultSet.bySegment`, keyed by *every* dimension present in the
 * slice combined (`platform=iOS|network=Wi-Fi`). This module never re-derives or
 * merges those aggregates — averaging pre-computed aggregates across segments is
 * exactly the statistically-invalid merge the engine guards against (Req 23.4).
 * Instead it:
 *
 * 1. Parses each segment key back into its `dimension → member` pairs.
 * 2. Projects onto the selected dimension: a segment contributes to the column
 *    for its selected-dimension member.
 * 3. Builds a cell only when a single engine segment maps cleanly to a
 *    (KPI, member) pair. When two or more composite segments collapse onto the
 *    same selected-dimension member (because the slice also carries other
 *    dimensions), combining them would be an invalid merge, so the cell is
 *    reported `not_aggregable` rather than silently averaged.
 *
 * This keeps the module pure (no DOM, no store) and independently testable,
 * mirroring the engine's own separation of math from presentation.
 */

import type { AggregatedKPIValue, AggregatedResultSet } from "@/models/results";
import type { AppAssignment, DimensionId } from "@/models";
import { NO_DATA, NOT_AGGREGABLE, type Numeric } from "@/models/sentinels";
import type { KPIDefinition } from "@/registry/kpi-types";
import {
  determineWinner,
  type HeatmapWinner,
} from "@/engine/winner";

/** The overall-slice segment key the engine emits when no dimension is present. */
const OVERALL_SEGMENT_KEY = "__overall__";

/** One `dimension → member` assignment parsed out of a composite segment key. */
export type SegmentAssignment = Partial<Record<DimensionId, string>>;

/**
 * Parse an engine segment key (`platform=iOS|network=Wi-Fi`) into its
 * dimension → member assignments. The `__overall__` key (a single-segment slice
 * with no dimensions) parses to an empty assignment.
 */
export function parseSegmentKey(key: string): SegmentAssignment {
  if (key === OVERALL_SEGMENT_KEY || key.length === 0) {
    return {};
  }
  const assignment: SegmentAssignment = {};
  for (const pair of key.split("|")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const dimension = pair.slice(0, eq) as DimensionId;
    assignment[dimension] = pair.slice(eq + 1);
  }
  return assignment;
}

/** One cell of the matrix: the winner verdict plus the raw values behind it. */
export interface HeatmapCell {
  kpiId: KPIDefinition["id"];
  /** The selected dimension member this cell belongs to (the column). */
  segmentMember: string;
  /** App_A's aggregated value for this (KPI, segment), or a sentinel. */
  appAValue: Numeric;
  /** App_B's aggregated value for this (KPI, segment), or a sentinel. */
  appBValue: Numeric;
  appAContributingRecords: number;
  appBContributingRecords: number;
  /** The directionality-aware winner verdict for this cell (Req 12.2). */
  winner: HeatmapWinner;
}

/** One row of the matrix: a KPI and its cell per selected-dimension member. */
export interface HeatmapRow {
  kpi: KPIDefinition;
  cells: HeatmapCell[];
}

/** The full matrix for one selected dimension. */
export interface HeatmapMatrix {
  /** The dimension the segment axis is built from (Req 12.4). */
  dimension: DimensionId;
  /** The selected dimension's members that actually appear in the slice. */
  segmentMembers: string[];
  rows: HeatmapRow[];
}

/** Index of `(kpiId, app)` → aggregated value within a single segment. */
type AppKPIIndex = Map<string, AggregatedKPIValue>;

function appKpiKey(kpiId: string, app: AppAssignment): string {
  return `${kpiId}::${app}`;
}

/** Build a `(kpiId, app)` lookup for one segment's aggregated values. */
function indexSegment(values: readonly AggregatedKPIValue[]): AppKPIIndex {
  const index: AppKPIIndex = new Map();
  for (const v of values) {
    index.set(appKpiKey(v.kpiId, v.app), v);
  }
  return index;
}

/**
 * The set of segments (engine keys) that project onto a given selected-dimension
 * member, along with each segment's per-(KPI, app) index. When more than one
 * segment collapses onto the same member, cells for that member are
 * `not_aggregable`.
 */
interface MemberSegments {
  member: string;
  segments: AppKPIIndex[];
}

/**
 * Group the engine's `bySegment` entries by the member of `dimension`, keeping
 * only segments that actually carry that dimension. Preserves first-seen order
 * so the column axis is stable across recomputes.
 */
function groupBySelectedDimension(
  bySegment: AggregatedResultSet["bySegment"],
  dimension: DimensionId,
): MemberSegments[] {
  const order: string[] = [];
  const byMember = new Map<string, AppKPIIndex[]>();

  for (const [key, values] of bySegment) {
    const assignment = parseSegmentKey(key);
    const member = assignment[dimension];
    if (member === undefined) continue; // segment does not carry this dimension
    const existing = byMember.get(member);
    if (existing) {
      existing.push(indexSegment(values));
    } else {
      byMember.set(member, [indexSegment(values)]);
      order.push(member);
    }
  }

  return order.map((member) => ({
    member,
    segments: byMember.get(member) ?? [],
  }));
}

/** Options controlling cell winner determination (the confidence gate). */
export interface BuildHeatmapOptions {
  /** The confidence-gate floor; 0 disables it (Req 25.8, 25.9, 25.11). */
  minSampleSize: number;
}

/**
 * Resolve a single cell's App_A / App_B inputs for one member's segments.
 *
 * - A member backed by exactly one engine segment reads that segment's values
 *   directly; a KPI absent for an app there is `NO_DATA` for that app (Req 12.5,
 *   mirroring the comparator's independent-app handling).
 * - A member backed by two or more engine segments (the slice carries other
 *   dimensions too) cannot be combined without an invalid merge, so both apps
 *   are reported `NOT_AGGREGABLE`, which the winner gate turns into a
 *   `not_aggregable` verdict (Req 23.4).
 */
function resolveCellValues(
  segments: readonly AppKPIIndex[],
  kpiId: string,
): {
  appAValue: Numeric;
  appBValue: Numeric;
  appAContributingRecords: number;
  appBContributingRecords: number;
} {
  if (segments.length > 1) {
    return {
      appAValue: NOT_AGGREGABLE,
      appBValue: NOT_AGGREGABLE,
      appAContributingRecords: 0,
      appBContributingRecords: 0,
    };
  }

  const segment = segments[0];
  const a = segment?.get(appKpiKey(kpiId, "App_A"));
  const b = segment?.get(appKpiKey(kpiId, "App_B"));

  return {
    appAValue: a ? a.value : NO_DATA,
    appBValue: b ? b.value : NO_DATA,
    appAContributingRecords: a ? a.contributingRecords : 0,
    appBContributingRecords: b ? b.contributingRecords : 0,
  };
}

/**
 * Build the KPI × selected-dimension winner matrix from an aggregated result
 * set (design "Winner Heatmap"). One row per KPI in `kpis` (in registry order),
 * one column per member of `dimension` present in the slice.
 *
 * Every cell's verdict comes from the shared {@link determineWinner} gate, so
 * the heatmap and the scorecards apply identical directionality, sentinel, and
 * confidence rules (Req 12.2, 12.5, 23.4, 25.8, 25.9).
 */
export function buildHeatmapMatrix(
  aggregated: AggregatedResultSet,
  dimension: DimensionId,
  kpis: readonly KPIDefinition[],
  options: BuildHeatmapOptions,
): HeatmapMatrix {
  const grouped = groupBySelectedDimension(aggregated.bySegment, dimension);
  const segmentMembers = grouped.map((g) => g.member);

  const rows: HeatmapRow[] = kpis.map((kpi) => {
    const cells: HeatmapCell[] = grouped.map(({ member, segments }) => {
      const {
        appAValue,
        appBValue,
        appAContributingRecords,
        appBContributingRecords,
      } = resolveCellValues(segments, kpi.id);

      const winner = determineWinner({
        appAValue,
        appBValue,
        directionality: kpi.directionality,
        appAContributingRecords,
        appBContributingRecords,
        minSampleSize: options.minSampleSize,
      });

      return {
        kpiId: kpi.id,
        segmentMember: member,
        appAValue,
        appBValue,
        appAContributingRecords,
        appBContributingRecords,
        winner,
      };
    });

    return { kpi, cells };
  });

  return { dimension, segmentMembers, rows };
}
