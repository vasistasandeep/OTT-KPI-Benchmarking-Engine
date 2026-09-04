/**
 * KPI taxonomy registry (Req 1, 22.1, 22.2, 24.1).
 *
 * A single static array seeding every KPI across the four pillars, with its
 * name, pillar, directionality, canonical unit and accepted source units
 * (with conversion factors), default SLA, valid range, aggregation kind,
 * derivation (Stickiness), fuzzy aliases, percentile ranks, and its
 * raw-mode-computable flag driven by the design's raw-mode coverage matrix.
 *
 * Every value in `defaultSLA`, `validRange`, and all stored metrics is expressed
 * in the KPI's `canonicalUnit` so threshold comparisons and deltas are always
 * like-for-like (Req 22.2).
 */

import type { CanonicalKPIId } from "@/models/ids";
import type { KPIDefinition, UnitSpec } from "./kpi-types";

// ---------------------------------------------------------------------------
// Units table (design "Units and canonical representation", Req 22.1)
//
// Each group lists the source units recognized at ingestion and the factor
// that converts a value in that unit to the group's canonical unit. The
// canonical unit always appears at factor 1.
// ---------------------------------------------------------------------------

/** Video Start Time (P50/P95): canonical `s`. */
const UNITS_SECONDS: UnitSpec[] = [
  { token: "ms", factor: 0.001 },
  { token: "s", factor: 1 },
];

/** Manifest Fetch Latency, TTFB: canonical `ms`. */
const UNITS_MILLIS: UnitSpec[] = [
  { token: "s", factor: 1000 },
  { token: "ms", factor: 1 },
];

/** Average Rendered Bitrate: canonical `Mbps`. */
const UNITS_BITRATE: UnitSpec[] = [
  { token: "bps", factor: 1e-9 },
  { token: "kbps", factor: 0.001 },
  { token: "Mbps", factor: 1 },
];

/** Total Watch Time: canonical `hours`. */
const UNITS_WATCH_HOURS: UnitSpec[] = [
  { token: "s", factor: 1 / 3600 },
  { token: "ms", factor: 1 / 3600000 },
  { token: "min", factor: 1 / 60 },
  { token: "hours", factor: 1 },
];

/** Average Session Duration: canonical `min`. */
const UNITS_SESSION_MIN: UnitSpec[] = [
  { token: "s", factor: 1 / 60 },
  { token: "ms", factor: 1 / 60000 },
  { token: "min", factor: 1 },
];

/** All percentage / rate KPIs: canonical `%`. */
const UNITS_PERCENT: UnitSpec[] = [
  { token: "%", factor: 1 },
  { token: "ratio", factor: 100 },
];

/** Rebuffer Rate: canonical `events/hour`. */
const UNITS_EVENTS_PER_HOUR: UnitSpec[] = [
  { token: "events/hour", factor: 1 },
  { token: "events/min", factor: 60 },
];

/** ARPU: canonical `USD` (currency conversion is out of scope). */
const UNITS_USD: UnitSpec[] = [{ token: "USD", factor: 1 }];

/** DAU / WAU / MAU distinct counts: identity only. */
const UNITS_COUNT: UnitSpec[] = [{ token: "count", factor: 1 }];

/** Downshift Frequency: identity only. */
const UNITS_DROPS_PER_SESSION: UnitSpec[] = [{ token: "drops/session", factor: 1 }];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The complete KPI taxonomy, one entry per canonical KPI id (Req 1). */
export const KPI_REGISTRY: readonly KPIDefinition[] = [
  // -----------------------------------------------------------------------
  // Playback Quality & QoE (Req 1.3)
  // -----------------------------------------------------------------------
  {
    id: "vst_p50",
    name: "Video Start Time (P50)",
    pillar: "Playback Quality & QoE",
    directionality: "lower_is_better",
    unit: "s",
    canonicalUnit: "s",
    acceptedUnits: UNITS_SECONDS,
    defaultSLA: 1.5,
    validRange: [0, 60],
    aggregation: "percentile",
    aliases: ["vst", "vst_p50", "video_start_time", "ttff", "startup_time", "vst_ms", "time_to_first_frame"],
    percentileRanks: [50],
    rawModeComputable: true,
  },
  {
    id: "vst_p95",
    name: "Video Start Time (P95)",
    pillar: "Playback Quality & QoE",
    directionality: "lower_is_better",
    unit: "s",
    canonicalUnit: "s",
    acceptedUnits: UNITS_SECONDS,
    defaultSLA: 1.5,
    validRange: [0, 60],
    aggregation: "percentile",
    aliases: ["vst_p95", "video_start_time_p95", "startup_time_p95", "vst_ms_p95"],
    percentileRanks: [95],
    rawModeComputable: true,
  },
  {
    id: "rebuffer_ratio",
    name: "Rebuffer Ratio",
    pillar: "Playback Quality & QoE",
    directionality: "lower_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    defaultSLA: 0.4,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["rebuffer_ratio", "rebuffering_ratio", "buffer_ratio", "rebuffer_pct"],
    rawModeComputable: true,
  },
  {
    id: "rebuffer_rate",
    name: "Rebuffer Rate",
    pillar: "Playback Quality & QoE",
    directionality: "lower_is_better",
    unit: "events/hour",
    canonicalUnit: "events/hour",
    acceptedUnits: UNITS_EVENTS_PER_HOUR,
    defaultSLA: 0.2,
    validRange: [0, 1000],
    aggregation: "ratio",
    aliases: ["rebuffer_rate", "rebuffering_rate", "rebuffers_per_hour", "buffer_events_per_hour"],
    rawModeComputable: true,
  },
  {
    id: "vsf",
    name: "Video Start Failures",
    pillar: "Playback Quality & QoE",
    directionality: "lower_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    defaultSLA: 0.5,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["vsf", "video_start_failure", "video_start_failures", "start_failure_rate", "vpf"],
    rawModeComputable: true,
  },
  {
    id: "ebvs",
    name: "Exit Before Video Start",
    pillar: "Playback Quality & QoE",
    directionality: "lower_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    defaultSLA: 1.8,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["ebvs", "exit_before_video_start", "exit_before_start", "abandonment_before_start"],
    rawModeComputable: true,
  },
  {
    id: "avg_rendered_bitrate",
    name: "Average Rendered Bitrate",
    pillar: "Playback Quality & QoE",
    directionality: "higher_is_better",
    unit: "Mbps",
    canonicalUnit: "Mbps",
    acceptedUnits: UNITS_BITRATE,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["avg_rendered_bitrate", "average_rendered_bitrate", "rendered_bitrate", "avg_bitrate", "bitrate"],
    rawModeComputable: true,
  },
  {
    id: "downshift_frequency",
    name: "Downshift Frequency",
    pillar: "Playback Quality & QoE",
    directionality: "lower_is_better",
    unit: "drops/session",
    canonicalUnit: "drops/session",
    acceptedUnits: UNITS_DROPS_PER_SESSION,
    validRange: [0, 1000],
    aggregation: "ratio",
    aliases: ["downshift_frequency", "downshifts_per_session", "bitrate_downshifts", "quality_drops"],
    rawModeComputable: true,
  },

  // -----------------------------------------------------------------------
  // User Engagement & Audience Retention (Req 1.4)
  // -----------------------------------------------------------------------
  {
    id: "total_watch_time",
    name: "Total Watch Time",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "hours",
    canonicalUnit: "hours",
    acceptedUnits: UNITS_WATCH_HOURS,
    validRange: [0, Number.MAX_SAFE_INTEGER],
    aggregation: "sum",
    aliases: ["total_watch_time", "watch_time", "viewing_hours", "total_viewing_time", "watch_time_hours"],
    rawModeComputable: true,
  },
  {
    id: "avg_session_duration",
    name: "Average Session Duration",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "min",
    canonicalUnit: "min",
    acceptedUnits: UNITS_SESSION_MIN,
    validRange: [0, 100000],
    aggregation: "weighted_avg",
    aliases: ["avg_session_duration", "average_session_duration", "session_duration", "avg_session_length"],
    rawModeComputable: true,
  },
  {
    id: "dau",
    name: "Daily Active Users",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "count",
    canonicalUnit: "count",
    acceptedUnits: UNITS_COUNT,
    validRange: [0, Number.MAX_SAFE_INTEGER],
    aggregation: "distinct_count",
    aliases: ["dau", "daily_active_users", "daily_actives"],
    rawModeComputable: true,
  },
  {
    id: "wau",
    name: "Weekly Active Users",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "count",
    canonicalUnit: "count",
    acceptedUnits: UNITS_COUNT,
    validRange: [0, Number.MAX_SAFE_INTEGER],
    aggregation: "distinct_count",
    aliases: ["wau", "weekly_active_users", "weekly_actives"],
    rawModeComputable: true,
  },
  {
    id: "mau",
    name: "Monthly Active Users",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "count",
    canonicalUnit: "count",
    acceptedUnits: UNITS_COUNT,
    validRange: [0, Number.MAX_SAFE_INTEGER],
    aggregation: "distinct_count",
    aliases: ["mau", "monthly_active_users", "monthly_actives"],
    rawModeComputable: true,
  },
  {
    id: "stickiness",
    name: "Stickiness",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "non_aggregable",
    // Stickiness = DAU / MAU * 100 (Req 24.1)
    derived: { operands: ["dau", "mau"], operation: "divide", scale: 100 },
    aliases: ["stickiness", "dau_mau_ratio", "dau_over_mau", "stickiness_ratio"],
    rawModeComputable: true,
  },
  {
    id: "content_completion_25",
    name: "Content Completion Rate (25%)",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["content_completion_25", "completion_rate_25", "completion_25", "quartile_25"],
    rawModeComputable: true,
  },
  {
    id: "content_completion_50",
    name: "Content Completion Rate (50%)",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["content_completion_50", "completion_rate_50", "completion_50", "quartile_50"],
    rawModeComputable: true,
  },
  {
    id: "content_completion_75",
    name: "Content Completion Rate (75%)",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["content_completion_75", "completion_rate_75", "completion_75", "quartile_75"],
    rawModeComputable: true,
  },
  {
    id: "content_completion_100",
    name: "Content Completion Rate (100%)",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["content_completion_100", "completion_rate_100", "completion_100", "quartile_100", "full_completion_rate"],
    rawModeComputable: true,
  },
  {
    id: "browse_to_play",
    name: "Browse-to-Play Conversion",
    pillar: "User Engagement & Audience Retention",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["browse_to_play", "browse_to_play_conversion", "b2p", "browse_play_rate"],
    rawModeComputable: true,
  },

  // -----------------------------------------------------------------------
  // Monetization & AdTech (Req 1.5)
  // -----------------------------------------------------------------------
  {
    id: "ad_fill_rate",
    name: "Ad Fill Rate",
    pillar: "Monetization & AdTech",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["ad_fill_rate", "fill_rate", "ad_fill", "ad_fill_pct"],
    rawModeComputable: true,
  },
  {
    id: "ad_start_failure",
    name: "Ad Start Failure",
    pillar: "Monetization & AdTech",
    directionality: "lower_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    defaultSLA: 0.8,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["ad_start_failure", "ad_start_failure_rate", "asf", "ad_failure_rate"],
    rawModeComputable: true,
  },
  {
    id: "vcr_ads",
    name: "Video Completion Rate for Ads",
    pillar: "Monetization & AdTech",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["vcr_ads", "vcr", "video_completion_rate_ads", "ad_completion_rate", "ad_vcr"],
    rawModeComputable: true,
  },
  {
    id: "ad_pod_dropoff",
    name: "Ad Pod Drop-off Rate",
    pillar: "Monetization & AdTech",
    directionality: "lower_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["ad_pod_dropoff", "ad_pod_drop_off", "ad_pod_dropoff_rate", "pod_abandonment_rate"],
    rawModeComputable: true,
  },
  {
    id: "churn_rate",
    name: "Churn Rate",
    pillar: "Monetization & AdTech",
    directionality: "lower_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["churn_rate", "monthly_churn", "churn", "subscriber_churn_rate"],
    // Requires subscription lifecycle state, absent from a playback session log.
    rawModeComputable: false,
  },
  {
    id: "arpu",
    name: "Average Revenue Per User",
    pillar: "Monetization & AdTech",
    directionality: "higher_is_better",
    unit: "USD",
    canonicalUnit: "USD",
    acceptedUnits: UNITS_USD,
    validRange: [0, Number.MAX_SAFE_INTEGER],
    aggregation: "weighted_avg",
    aliases: ["arpu", "average_revenue_per_user", "revenue_per_user"],
    // Requires billing/revenue data, absent from a playback session log.
    rawModeComputable: false,
  },

  // -----------------------------------------------------------------------
  // Infrastructure & Delivery (Req 1.6)
  // -----------------------------------------------------------------------
  {
    id: "cdn_cache_hit_ratio",
    name: "CDN Cache Hit Ratio",
    pillar: "Infrastructure & Delivery",
    directionality: "higher_is_better",
    unit: "%",
    canonicalUnit: "%",
    acceptedUnits: UNITS_PERCENT,
    defaultSLA: 95,
    validRange: [0, 100],
    aggregation: "weighted_avg",
    aliases: ["cdn_cache_hit_ratio", "cache_hit_ratio", "cache_hit_rate", "cdn_hit_ratio"],
    rawModeComputable: true,
  },
  {
    id: "manifest_fetch_latency",
    name: "Manifest Fetch Latency",
    pillar: "Infrastructure & Delivery",
    directionality: "lower_is_better",
    unit: "ms",
    canonicalUnit: "ms",
    acceptedUnits: UNITS_MILLIS,
    validRange: [0, 600000],
    aggregation: "percentile",
    aliases: ["manifest_fetch_latency", "manifest_latency", "manifest_fetch_ms", "manifest_fetch_time"],
    percentileRanks: [50, 90, 95],
    rawModeComputable: true,
  },
  {
    id: "ttfb",
    name: "Time To First Byte",
    pillar: "Infrastructure & Delivery",
    directionality: "lower_is_better",
    unit: "ms",
    canonicalUnit: "ms",
    acceptedUnits: UNITS_MILLIS,
    validRange: [0, 600000],
    aggregation: "percentile",
    aliases: ["ttfb", "time_to_first_byte", "ttfb_ms", "first_byte_time"],
    percentileRanks: [50, 90, 95],
    rawModeComputable: true,
  },
];

/** The registry keyed by id for O(1) lookup. */
export const KPI_BY_ID: Readonly<Record<CanonicalKPIId, KPIDefinition>> = Object.freeze(
  KPI_REGISTRY.reduce(
    (acc, kpi) => {
      acc[kpi.id] = kpi;
      return acc;
    },
    {} as Record<CanonicalKPIId, KPIDefinition>,
  ),
);

/** All canonical KPI ids, in registry order. */
export const ALL_KPI_IDS: readonly CanonicalKPIId[] = KPI_REGISTRY.map((k) => k.id);

/** Look up a KPI definition by id, or `undefined` if unknown. */
export function getKPI(id: CanonicalKPIId): KPIDefinition | undefined {
  return KPI_BY_ID[id];
}

/** All KPIs belonging to a given pillar, in registry order. */
export function getKPIsByPillar(pillar: KPIDefinition["pillar"]): KPIDefinition[] {
  return KPI_REGISTRY.filter((k) => k.pillar === pillar);
}
