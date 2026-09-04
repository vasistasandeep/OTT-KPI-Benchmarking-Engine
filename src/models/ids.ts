/**
 * Registry-owned identifier types.
 *
 * `CanonicalKPIId` is the literal union of every KPI id seeded by the KPI
 * taxonomy registry (task 3.1). It is narrowed from the earlier `string`
 * placeholder to the exact set of registered ids. The union is a subtype of
 * `string`, so every existing consumer that only relied on it being assignable
 * to `string` keeps compiling unchanged (design note, KPI taxonomy registry).
 *
 * `DimensionId` is owned by the dimension registry (task 3.3); it is stable per
 * the design's dimension model and fixed here.
 */

/**
 * Canonical identifier for a KPI (e.g. "vst_p95", "rebuffer_ratio").
 *
 * This union is the single source of truth for KPI ids. The registry array in
 * `src/registry` is typed against it so the two can never drift: adding a KPI
 * to the registry without adding its id here (or vice versa) is a compile
 * error.
 */
export type CanonicalKPIId =
  // Playback Quality & QoE (Req 1.3)
  | "vst_p50"
  | "vst_p95"
  | "rebuffer_ratio"
  | "rebuffer_rate"
  | "vsf"
  | "ebvs"
  | "avg_rendered_bitrate"
  | "downshift_frequency"
  // User Engagement & Audience Retention (Req 1.4)
  | "total_watch_time"
  | "avg_session_duration"
  | "dau"
  | "wau"
  | "mau"
  | "stickiness"
  | "content_completion_25"
  | "content_completion_50"
  | "content_completion_75"
  | "content_completion_100"
  | "browse_to_play"
  // Monetization & AdTech (Req 1.5)
  | "ad_fill_rate"
  | "ad_start_failure"
  | "vcr_ads"
  | "ad_pod_dropoff"
  | "churn_rate"
  | "arpu"
  // Infrastructure & Delivery (Req 1.6)
  | "cdn_cache_hit_ratio"
  | "manifest_fetch_latency"
  | "ttfb";

/**
 * Identifier for one of the five slicing dimensions (Req 2). This union is
 * stable per the design's dimension model and is safe to fix now.
 */
export type DimensionId = "platform" | "network" | "cdn" | "geography" | "streamType";
