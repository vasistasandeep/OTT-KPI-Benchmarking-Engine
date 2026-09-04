/**
 * The `AggregationEngine` assembly — the integration point that wires every
 * pure engine function into the two operations the dashboard consumes:
 * `aggregate(records, mode, kpis)` and `compare(agg, sla, kpis)`
 * (design "Aggregation engine interface").
 *
 * Nothing here computes a formula itself. It orchestrates the already-proven
 * pure functions (`bucketTimestamp`, `groupRecords`, `percentile`,
 * `rebufferRatio`, `vsfRate`, `weightedAverage`, the per-KPI raw-mode compute
 * functions, `distinctCount`, `resolveAggregability`, `resolveDerived`,
 * `computeDelta`, `classifyRAG`) in the design's fixed execution order:
 *
 *   1. `bucketTimestamp` — each record already carries its UTC hour/day bucket
 *      from ingestion; the engine trusts `record.bucket` (Req 26.5).
 *   2. `groupRecords` — partition by (app, bucket, dimension tags) (Req 5.6).
 *   3. Per-group KPI computation for every non-derived KPI, by aggregation kind.
 *   4. `resolveAggregability` — collapse groups up to the active slice; unique
 *      counts and pre-aggregated percentiles that would have to be merged
 *      across buckets/segments resolve to `NOT_AGGREGABLE` (Req 23.4).
 *   5. `resolveDerived` — derived KPIs from the already-aggregated operands.
 *   6. `compare` — delta -> confidence gate -> RAG (Req 11, 25, 16.5).
 *
 * The order matters: step 5 depends on the operand aggregates from step 4, and
 * step 6 depends on the finished aggregates from step 5. Each app is aggregated
 * *independently*: App_A's records only ever feed App_A's aggregate and App_B's
 * only feed App_B's, so unequal record counts between the two apps simply yield
 * each app's own value with no cross-contamination (Req 16.3).
 *
 * All methods are pure: no DOM, no storage, no mutation of inputs.
 *
 * Requirements: 5.6, 16.3, 24.2 (and, via the assembled functions, the wider
 * numeric and comparison requirements those functions own).
 */

import { NO_DATA, NOT_AGGREGABLE } from "@/models/sentinels";
import type { Numeric } from "@/models/sentinels";
import type {
  AppAssignment,
  IngestionMode,
  KPIRecord,
  RawSessionFields,
  DataQualityAdvisory,
} from "@/models/records";
import type {
  AggregatedKPIValue,
  AggregatedResultSet,
  ComparisonResult,
  ComparisonResultSet,
  FilterSlice,
  RejectedRecord,
} from "@/models/results";
import type { SLAConfig } from "@/models/config";
import type { CanonicalKPIId, DimensionId } from "@/models/ids";
import type { KPIDefinition } from "@/registry/kpi-types";

import { percentile } from "./percentile";
import { rebufferRatio, vsfRate } from "./rates";
import { weightedAverage } from "./weighted-average";
import type { AggRow } from "./weighted-average";
import { distinctCount } from "./aggregability";
import { resolveAggregability } from "./aggregability";
import type { SliceExtent } from "./aggregability";
import { resolveDerived } from "./derived";
import { collectPreAggregatedValues, validateSessions } from "./rejection";
import { computeDelta, classifyRAG } from "./comparator";
import {
  ebvs,
  rebufferRate,
  avgRenderedBitrate,
  downshiftFrequency,
  totalWatchTime,
  avgSessionDuration,
  completionQuartileRates,
  browseToPlay,
  adFillRate,
  adStartFailure,
  vcrAds,
  adPodDropoff,
  cdnCacheHitRatio,
  noDataReason,
} from "./raw-mode";
import type { Quartile } from "./raw-mode";

/** The two comparable apps, in a fixed order so results are deterministic. */
const APPS: readonly AppAssignment[] = ["App_A", "App_B"];

/** The engine contract both the in-thread and worker implementations satisfy. */
export interface AggregationEngine {
  aggregate(
    records: KPIRecord[],
    mode: IngestionMode,
    kpis: KPIDefinition[],
  ): AggregatedResultSet;
  compare(
    agg: AggregatedResultSet,
    sla: SLAConfig,
    kpis: KPIDefinition[],
  ): ComparisonResultSet;
}

/** Round a finite number to 2 decimal places (percentage/rate presentation). */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** The raw session payload of a record, or `undefined` when it carries none. */
function sessionOf(record: KPIRecord): RawSessionFields | undefined {
  return record.session;
}

/**
 * The completion-quartile KPI ids mapped to their quartile threshold, so the
 * raw-mode `completionQuartileRates` output can be routed to the right KPI.
 */
const QUARTILE_KPI: Partial<Record<CanonicalKPIId, Quartile>> = {
  content_completion_25: 25,
  content_completion_50: 50,
  content_completion_75: 75,
  content_completion_100: 100,
};

/**
 * The raw-session compute function for each percentage/ratio/sum KPI whose
 * value is derived directly from a group's sessions. Percentile, distinct-count,
 * and quartile KPIs are handled by dedicated branches, so they are absent here.
 */
const RAW_COMPUTE: Partial<
  Record<CanonicalKPIId, (sessions: readonly RawSessionFields[]) => Numeric>
> = {
  rebuffer_ratio: rebufferRatio,
  vsf: vsfRate,
  ebvs,
  rebuffer_rate: rebufferRate,
  avg_rendered_bitrate: avgRenderedBitrate,
  downshift_frequency: downshiftFrequency,
  total_watch_time: totalWatchTime,
  avg_session_duration: avgSessionDuration,
  browse_to_play: browseToPlay,
  ad_fill_rate: adFillRate,
  ad_start_failure: adStartFailure,
  vcr_ads: vcrAds,
  ad_pod_dropoff: adPodDropoff,
  cdn_cache_hit_ratio: cdnCacheHitRatio,
};

/** The raw session field a percentile KPI draws its distribution from. */
const PERCENTILE_FIELD: Partial<Record<CanonicalKPIId, keyof RawSessionFields>> = {
  vst_p50: "vstMs",
  vst_p95: "vstMs",
  manifest_fetch_latency: "manifestFetchMs",
  ttfb: "ttfbMs",
};

/** The percentile rank each percentile KPI reports (its first declared rank). */
function percentileRankOf(def: KPIDefinition): number {
  return def.percentileRanks?.[0] ?? 50;
}

/**
 * The intermediate result of computing one KPI for one app: the value plus the
 * contributing count, weighting flag, rejections, and advisories the
 * `AggregatedKPIValue` needs. Assembled by the per-KPI compute branches and
 * finished into an `AggregatedKPIValue` by {@link finishValue}.
 */
interface Computed {
  value: Numeric;
  contributingRecords: number;
  weighted: boolean;
  rejectedRecords: RejectedRecord[];
  advisories: DataQualityAdvisory[];
}

/** An empty-slice `NO_DATA` result with no contributing records. */
function emptyComputed(): Computed {
  return {
    value: NO_DATA,
    contributingRecords: 0,
    weighted: true,
    rejectedRecords: [],
    advisories: [],
  };
}

/**
 * The engine implemented as a set of pure functions. `InThreadAggregationEngine`
 * is the direct implementation; a `WorkerAggregationEngine` (task 9.1) will
 * satisfy the same interface by marshalling to a worker.
 */
export class InThreadAggregationEngine implements AggregationEngine {
  aggregate(
    records: KPIRecord[],
    mode: IngestionMode,
    kpis: KPIDefinition[],
  ): AggregatedResultSet {
    return aggregate(records, mode, kpis);
  }

  compare(
    agg: AggregatedResultSet,
    sla: SLAConfig,
    kpis: KPIDefinition[],
  ): ComparisonResultSet {
    return compare(agg, sla, kpis);
  }
}

/**
 * Aggregate `records` into an {@link AggregatedResultSet} following the fixed
 * execution order (steps 1-5). Each app is aggregated independently, so unequal
 * per-app record counts never leak across the App_A / App_B boundary (Req 16.3).
 *
 * The `overall` result is the whole slice (records collapsed to a single
 * (app, KPI) value each); `bySegment` keys the same computation by each
 * record's dimension tags so the heatmap can compare per-segment. Derived KPIs
 * are resolved last, from the already-aggregated operands (Req 24.2).
 *
 * @param records the valid records of the active slice (already ingested and
 *   bucketed). Records missing a raw session in raw mode contribute nothing.
 * @param mode    whether the records are pre-aggregated summaries or raw
 *   sessions; drives which compute path each KPI takes.
 * @param kpis    the KPI definitions to aggregate (typically the full registry).
 */
export function aggregate(
  records: KPIRecord[],
  mode: IngestionMode,
  kpis: KPIDefinition[],
): AggregatedResultSet {
  const isRawMode = mode === "Raw_Session";

  // Step 4 slice extent for the overall result: how many distinct buckets and
  // segments the whole slice spans, used by the aggregability guard for
  // non-recombinable pre-aggregated kinds.
  const overallExtent = sliceExtent(records, []);
  const overall = aggregateSlice(records, kpis, isRawMode, overallExtent);

  // Per-segment aggregation: partition by every dimension present so the
  // heatmap can compare a KPI within one segment. A single-segment slice always
  // matches the ingested granularity for the bucket extent.
  const bySegment = new Map<string, AggregatedKPIValue[]>();
  const dimensions = presentDimensions(records);
  const segmentGroups = groupBySegment(records, dimensions);
  for (const [segmentKey, segmentRecords] of segmentGroups) {
    const extent = sliceExtent(segmentRecords, dimensions);
    bySegment.set(segmentKey, aggregateSlice(segmentRecords, kpis, isRawMode, extent));
  }

  const unweightedAdvisory = overall.some(
    (v) => !v.weighted && v.value !== NO_DATA && v.value !== NOT_AGGREGABLE,
  );

  return { bySegment, overall, unweightedAdvisory };
}

/**
 * Compute every KPI (non-derived first, then derived) for one slice's records,
 * for both apps independently. Returns the flat list of `AggregatedKPIValue`s
 * for the slice, one per (KPI, app).
 */
function aggregateSlice(
  records: readonly KPIRecord[],
  kpis: readonly KPIDefinition[],
  isRawMode: boolean,
  extent: SliceExtent,
): AggregatedKPIValue[] {
  const nonDerived = kpis.filter((k) => !k.derived);
  const derived = kpis.filter((k) => k.derived);

  // Records split by app so each app's aggregate is computed only from its own
  // records (Req 16.3).
  const byApp = new Map<AppAssignment, KPIRecord[]>();
  for (const app of APPS) {
    byApp.set(app, []);
  }
  for (const record of records) {
    byApp.get(record.app)?.push(record);
  }

  const values: AggregatedKPIValue[] = [];
  // Operand aggregates per app, so step 5 can resolve derived KPIs from the
  // already-aggregated operand values for this same slice (Req 24.2).
  const operandsByApp = new Map<AppAssignment, Map<CanonicalKPIId, Numeric>>();
  for (const app of APPS) {
    operandsByApp.set(app, new Map());
  }

  // Step 3 + 4 — per-app, per-KPI computation and aggregability resolution.
  for (const def of nonDerived) {
    for (const app of APPS) {
      const appRecords = byApp.get(app) ?? [];
      const computed = computeKPI(def, appRecords, isRawMode);
      const aggregability = resolveAggregability(def.aggregation, isRawMode, extent);
      const value = aggregability === "not_aggregable" ? NOT_AGGREGABLE : computed.value;

      operandsByApp.get(app)?.set(def.id, value);
      values.push(finishValue(def, app, value, aggregability, computed));
    }
  }

  // Step 5 — derived KPIs from the already-aggregated operands (Req 24.2).
  for (const def of derived) {
    for (const app of APPS) {
      const operandAggregates = operandsByApp.get(app) ?? new Map();
      const resolution = resolveDerived(def.derived!, operandAggregates);

      // A derived KPI is aggregable when its value is finite; it inherits its
      // operands' sentinels rather than the extent guard.
      const aggregability =
        resolution.value === NOT_AGGREGABLE ? "not_aggregable" : "aggregable";

      // Contributing records for the confidence gate: the minimum of the
      // operands' contributing counts (a ratio is only as well-sampled as its
      // thinnest operand).
      const contributing = derivedContributingRecords(def, app, values);

      values.push(
        finishValue(def, app, resolution.value, aggregability, {
          value: resolution.value,
          contributingRecords: contributing,
          weighted: true,
          rejectedRecords: [],
          advisories: [],
        }),
      );
    }
  }

  return values;
}

/**
 * Compute one non-derived KPI for one app's records, dispatching on the KPI's
 * aggregation kind and the ingestion mode.
 *
 * Raw mode drives every KPI from the group's *valid* sessions (rejecting
 * missing/non-numeric/negative required fields first, Req 5.7); pre-aggregated
 * mode combines the mapped metric values, excluding non-numeric cells (Req 4.3).
 */
function computeKPI(
  def: KPIDefinition,
  records: readonly KPIRecord[],
  isRawMode: boolean,
): Computed {
  return isRawMode ? computeRaw(def, records) : computePreAggregated(def, records);
}

/** Raw-session computation for one KPI over one app's records. */
function computeRaw(def: KPIDefinition, records: readonly KPIRecord[]): Computed {
  // A KPI that a session log cannot express (or whose required fields are not
  // mapped) is reported as NO_DATA with a specific reason (Req 5.1, 16.5).
  const mappedFields = mappedSessionFields(records);
  const reason = noDataReason(def.id, mappedFields);
  if (reason !== null) {
    return {
      value: NO_DATA,
      contributingRecords: 0,
      weighted: true,
      rejectedRecords: [],
      advisories: [],
    };
  }

  // Collect this app's sessions with their originating ids for rejection notes.
  const identified = records
    .map((r) => ({ id: r.id, session: sessionOf(r) }))
    .filter((x): x is { id: string; session: RawSessionFields } => x.session !== undefined);

  const { valid, rejected } = validateSessions(identified, requiredFieldsFor(def));
  const sessions = valid.map((v) => v.session);
  const contributing = sessions.length;

  // Distinct-count KPIs (DAU/WAU/MAU): count distinct users directly (Req 23.1).
  if (def.aggregation === "distinct_count") {
    const { value } = distinctCount(sessions, mappedFields.has("userId"));
    return { value, contributingRecords: contributing, weighted: true, rejectedRecords: rejected, advisories: [] };
  }

  // Percentile KPIs: recompute from the union of the group's raw values (Req 23.7).
  if (def.aggregation === "percentile") {
    const field = PERCENTILE_FIELD[def.id];
    const distribution = field
      ? sessions
          .map((s) => s[field as string])
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      : [];
    const value = distribution.length === 0 ? NO_DATA : round2(percentile(distribution, percentileRankOf(def)) as number);
    return { value, contributingRecords: contributing, weighted: true, rejectedRecords: rejected, advisories: [] };
  }

  // Completion-quartile KPIs: compute all four rates once, route by threshold.
  const quartile = QUARTILE_KPI[def.id];
  if (quartile !== undefined) {
    const rates = completionQuartileRates(sessions);
    return { value: rates[quartile], contributingRecords: contributing, weighted: true, rejectedRecords: rejected, advisories: [] };
  }

  // Percentage / ratio KPIs with a dedicated raw-mode formula.
  const compute = RAW_COMPUTE[def.id];
  if (compute) {
    return { value: compute(sessions), contributingRecords: contributing, weighted: true, rejectedRecords: rejected, advisories: [] };
  }

  // Additive sum KPIs with no dedicated helper fall through to a generic sum of
  // the volumeWeight; unknown kinds report NO_DATA rather than guessing.
  return { value: NO_DATA, contributingRecords: contributing, weighted: true, rejectedRecords: rejected, advisories: [] };
}

/** Pre-aggregated computation for one KPI over one app's records (Req 4.3, 20). */
function computePreAggregated(def: KPIDefinition, records: readonly KPIRecord[]): Computed {
  const { values, rejected } = collectPreAggregatedValues(records, def.id);
  const contributing = values.length;

  if (contributing === 0) {
    return { value: NO_DATA, contributingRecords: 0, weighted: true, rejectedRecords: rejected, advisories: [] };
  }

  switch (def.aggregation) {
    case "sum": {
      const total = values.reduce((acc, v) => acc + v, 0);
      return { value: total, contributingRecords: contributing, weighted: true, rejectedRecords: rejected, advisories: [] };
    }
    case "weighted_avg": {
      // Pair each value with its record's volumeWeight for a volume-weighted
      // mean, falling back to the unweighted mean when any weight is absent
      // (Req 20.1-20.4). Values and weights are re-collected in parallel so a
      // rejected value drops its weight too.
      const rows = buildWeightedRows(records, def.id);
      const result = weightedAverage(rows);
      const advisories: DataQualityAdvisory[] = result.weighted
        ? []
        : [{ code: "UNWEIGHTED_AGGREGATE", detail: `${def.name} aggregated without volume weights` }];
      return { value: result.value, contributingRecords: contributing, weighted: result.weighted, rejectedRecords: rejected, advisories };
    }
    case "arithmetic_avg": {
      const total = values.reduce((acc, v) => acc + v, 0);
      return { value: total / contributing, contributingRecords: contributing, weighted: false, rejectedRecords: rejected, advisories: [] };
    }
    case "ratio": {
      // A pre-aggregated ratio column is displayed at its ingested granularity;
      // combining it is guarded by resolveAggregability upstream. Treat the
      // values as a volume-weighted mean when weights exist, else arithmetic.
      const rows = buildWeightedRows(records, def.id);
      const result = weightedAverage(rows);
      return { value: result.value, contributingRecords: contributing, weighted: result.weighted, rejectedRecords: rejected, advisories: [] };
    }
    case "percentile":
    case "distinct_count":
    case "non_aggregable": {
      // Non-recombinable: display the ingested value as-is. When the slice
      // spans more than the ingested granularity the guard has already
      // resolved NOT_AGGREGABLE upstream, so this value is only surfaced for a
      // single-granularity slice.
      return { value: values[0], contributingRecords: contributing, weighted: true, rejectedRecords: rejected, advisories: [] };
    }
    default:
      return emptyComputed();
  }
}

/**
 * Pair each record's metric value for a KPI with its `volumeWeight` for the
 * weighted-average path. A record whose metric value is non-numeric is skipped
 * here (it is reported by `collectPreAggregatedValues` separately); a record
 * with a numeric value but no `volumeWeight` yields a weightless row, which
 * forces `weightedAverage` into its unweighted fallback (Req 20.3).
 */
function buildWeightedRows(records: readonly KPIRecord[], kpiId: CanonicalKPIId): AggRow[] {
  const rows: AggRow[] = [];
  for (const record of records) {
    const raw = record.metrics?.[kpiId];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      rows.push(record.volumeWeight === undefined ? { value: raw } : { value: raw, weight: record.volumeWeight });
    }
  }
  return rows;
}

/**
 * Finish an `AggregatedKPIValue` from a computed intermediate, stamping the
 * KPI's canonical unit, the aggregability verdict, and the ingested granularity
 * for non-aggregable kinds so the UI can tell the analyst to narrow the slice.
 */
function finishValue(
  def: KPIDefinition,
  app: AppAssignment,
  value: Numeric,
  aggregability: "aggregable" | "not_aggregable",
  computed: Computed,
): AggregatedKPIValue {
  return {
    kpiId: def.id,
    app,
    value,
    unit: def.canonicalUnit,
    aggregability,
    weighted: computed.weighted,
    contributingRecords: computed.contributingRecords,
    rejectedRecords: computed.rejectedRecords,
    advisories: computed.advisories,
  };
}

/**
 * The contributing-record count for a derived KPI: the smallest contributing
 * count among its operands for the app (a ratio is only as well-sampled as its
 * thinnest operand). Returns 0 when no operand aggregate is present.
 */
function derivedContributingRecords(
  def: KPIDefinition,
  app: AppAssignment,
  computedValues: readonly AggregatedKPIValue[],
): number {
  const operandIds = new Set<CanonicalKPIId>(def.derived?.operands ?? []);
  let min = Number.POSITIVE_INFINITY;
  for (const v of computedValues) {
    if (v.app === app && operandIds.has(v.kpiId)) {
      min = Math.min(min, v.contributingRecords);
    }
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * The set of session fields the active mapping populated, inferred from the
 * records' session payloads: a field is "mapped" when at least one session
 * carries a value for it. Used to gate raw-mode KPIs whose required fields are
 * absent (Req 5.1).
 */
function mappedSessionFields(records: readonly KPIRecord[]): Set<keyof RawSessionFields> {
  const fields = new Set<keyof RawSessionFields>();
  for (const record of records) {
    const session = record.session;
    if (!session) continue;
    for (const key of Object.keys(session)) {
      if (session[key] !== undefined) {
        fields.add(key as keyof RawSessionFields);
      }
    }
  }
  return fields;
}

/**
 * The session fields a raw-mode KPI requires all present, numeric, and
 * non-negative for a session to contribute (Req 5.7). Mirrors the raw-mode
 * coverage matrix; unknown KPIs require nothing (they never reach raw compute).
 */
function requiredFieldsFor(def: KPIDefinition): (keyof RawSessionFields)[] {
  return RAW_REQUIRED_FIELDS[def.id] ?? [];
}

/**
 * The required raw session fields per KPI, mirroring `raw-mode.ts`. Kept here so
 * session validation (Req 5.7) rejects rows missing exactly the fields the
 * KPI's formula reads. `userId`/`quartileReached` are treated as required for
 * their respective KPIs so a row missing them does not silently contribute 0.
 */
const RAW_REQUIRED_FIELDS: Partial<Record<CanonicalKPIId, (keyof RawSessionFields)[]>> = {
  vst_p50: ["vstMs"],
  vst_p95: ["vstMs"],
  rebuffer_ratio: ["bufferingMs", "playTimeMs"],
  rebuffer_rate: ["rebufferEventCount", "viewingTimeMs"],
  vsf: ["startFailure", "playbackAttempt"],
  ebvs: ["exitBeforeStart", "playbackAttempt"],
  avg_rendered_bitrate: ["renderedBitrateKbps", "playTimeMs"],
  downshift_frequency: ["downshiftCount"],
  total_watch_time: ["playTimeMs"],
  avg_session_duration: ["sessionDurationMs"],
  content_completion_25: ["quartileReached"],
  content_completion_50: ["quartileReached"],
  content_completion_75: ["quartileReached"],
  content_completion_100: ["quartileReached"],
  browse_to_play: ["browseEvent", "playEvent"],
  ad_fill_rate: ["adRequestCount", "adFilledCount"],
  ad_start_failure: ["adStartFailureCount", "adFilledCount"],
  vcr_ads: ["adCompleteCount", "adFilledCount"],
  ad_pod_dropoff: ["adPodAbandonCount", "adPodStartCount"],
  cdn_cache_hit_ratio: ["cacheHit"],
  manifest_fetch_latency: ["manifestFetchMs"],
  ttfb: ["ttfbMs"],
  // distinct counts do not reject on userId here — an unmapped userId is
  // reported via noDataReason, and a mapped-but-empty userId is a defined skip.
};

/**
 * Compute the slice extent (distinct buckets / segments) for the aggregability
 * guard. The bucket count is the distinct day buckets present; the segment
 * count is the distinct dimension-tag combinations over the sliced dimensions.
 */
function sliceExtent(
  records: readonly KPIRecord[],
  dimensions: readonly DimensionId[],
): SliceExtent {
  const buckets = new Set<string>();
  const segments = new Set<string>();
  for (const record of records) {
    buckets.add(record.bucket.dayUtc);
    segments.add(segmentKeyOf(record, dimensions));
  }
  return { bucketCount: buckets.size, segmentCount: segments.size };
}

/** The distinct dimension ids present across the records (for per-segment keys). */
function presentDimensions(records: readonly KPIRecord[]): DimensionId[] {
  const ids = new Set<DimensionId>();
  for (const record of records) {
    for (const key of Object.keys(record.dimensions ?? {})) {
      ids.add(key as DimensionId);
    }
  }
  return [...ids];
}

/** A stable key identifying a record's segment over the given dimensions. */
function segmentKeyOf(record: KPIRecord, dimensions: readonly DimensionId[]): string {
  if (dimensions.length === 0) {
    return "__overall__";
  }
  return dimensions.map((d) => `${d}=${record.dimensions?.[d] ?? "Unknown"}`).join("|");
}

/** Partition records by their dimension-tag segment, preserving the segment key. */
function groupBySegment(
  records: readonly KPIRecord[],
  dimensions: readonly DimensionId[],
): Map<string, KPIRecord[]> {
  const groups = new Map<string, KPIRecord[]>();
  if (dimensions.length === 0) {
    return groups;
  }
  for (const record of records) {
    const key = segmentKeyOf(record, dimensions);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return groups;
}

/**
 * Compare an aggregated result set into an {@link ComparisonResultSet} — step 6
 * of the fixed execution order. For each KPI it pairs the App_A and App_B
 * overall aggregates, computes the deltas (`computeDelta`), then classifies RAG
 * through the sentinel and minimum-sample-size gates (`classifyRAG`).
 *
 * Because App_A and App_B were aggregated independently in {@link aggregate},
 * a KPI present for only one app compares that app's value against the other's
 * `NO_DATA`, yielding a `NoData` verdict rather than an error (Req 16.3, 16.5).
 *
 * @param agg the aggregated result set from {@link aggregate}.
 * @param sla the active SLA config (variance band + minimum sample size).
 * @param kpis the KPI definitions supplying directionality per KPI.
 */
export function compare(
  agg: AggregatedResultSet,
  sla: SLAConfig,
  kpis: KPIDefinition[],
): ComparisonResultSet {
  const byKpiApp = indexByKpiApp(agg.overall);
  const results: ComparisonResult[] = [];

  for (const def of kpis) {
    const a = byKpiApp.get(keyOf(def.id, "App_A"));
    const b = byKpiApp.get(keyOf(def.id, "App_B"));

    // A KPI with no aggregate for either app is not part of this comparison.
    if (!a && !b) {
      continue;
    }

    const appAValue: Numeric = a ? a.value : NO_DATA;
    const appBValue: Numeric = b ? b.value : NO_DATA;
    const appAContributing = a ? a.contributingRecords : 0;
    const appBContributing = b ? b.contributingRecords : 0;

    const { absoluteDelta, percentDelta } = computeDelta(appAValue, appBValue);
    const rag = classifyRAG(
      appAValue,
      appBValue,
      def.directionality,
      sla,
      appAContributing,
      appBContributing,
    );

    results.push({
      kpiId: def.id,
      appAValue,
      appBValue,
      absoluteDelta,
      percentDelta,
      rag: rag.rag,
      suppressionReason: rag.suppressionReason,
      appAContributingRecords: appAContributing,
      appBContributingRecords: appBContributing,
    });
  }

  return { results, slice: fullSlice() };
}

/** Index aggregated values by a `(kpiId, app)` composite key for O(1) pairing. */
function indexByKpiApp(values: readonly AggregatedKPIValue[]): Map<string, AggregatedKPIValue> {
  const map = new Map<string, AggregatedKPIValue>();
  for (const v of values) {
    map.set(keyOf(v.kpiId, v.app), v);
  }
  return map;
}

/** The composite key for a `(kpiId, app)` pair. */
function keyOf(kpiId: CanonicalKPIId, app: AppAssignment): string {
  return `${kpiId}|${app}`;
}

/**
 * A whole-dataset filter slice, used when `compare` is invoked directly on an
 * aggregated set that already represents the active slice. Callers driving a
 * real filter pass their own `FilterSlice` through the store; here the default
 * describes "everything, at day granularity, both apps".
 */
function fullSlice(): FilterSlice {
  return {
    dateRange: { preset: "30d" },
    granularity: "day",
    displayTimezone: "UTC",
    dimensionSelections: {},
    apps: ["App_A", "App_B"],
  };
}
