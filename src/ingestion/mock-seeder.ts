/**
 * MockDataSeeder — generates a realistic 30-day comparative demo dataset for
 * one-click exploration (Req 9), emitting values already in each KPI's
 * canonical unit and every timestamp normalized to UTC (design "MockDataSeeder").
 *
 * The dataset compares two applications — App_A ("Current") and App_B
 * ("Experimental / Competitor") — across the Mobile, Connected TV, and Desktop
 * Web platforms and across live streaming and VOD stream types, and it carries a
 * value for every defined KPI (Req 9.2, 9.3). Because the seeder produces the
 * canonical `KPIRecord` shape directly it deliberately does not re-run the file
 * ingestion path: values are emitted in canonical units and timestamps are
 * already UTC, so unit and timestamp normalization would be no-ops.
 *
 * ## Scale profiles (design "Scale Profiles", Req 15.3, 17.4)
 *
 * - `standard` — a compact **pre-aggregated** dataset for normal demo use. One
 *   record per (day × platform × stream type × app) carrying a `metrics` map for
 *   every KPI. That is 30 days × 3 platforms × 2 stream types × 2 apps = 360
 *   records at day granularity plus a handful of MAU rows, landing around ~500
 *   records — enough to populate every module without stressing the main thread.
 * - `stress` — a large **raw-session** dataset that deterministically crosses
 *   the 25,000-record worker-offload threshold (Req 17.4) and the table
 *   virtualization threshold (Req 19.1). Records are emitted at hourly / session
 *   granularity so that `records.length > 25000`, exercising the Web Worker path
 *   in Task 9.1 and the virtualized tables in Task 19.1.
 *
 * ## Determinism
 *
 * Generation is fully deterministic: a seeded PRNG (`mulberry32`) drives every
 * random draw, and the base date is fixed. The same `MockSeedOptions` always
 * produce byte-for-byte identical records, so tests and snapshots are stable.
 * Record ids are derived from their coordinates, never from `Math.random` or the
 * wall clock.
 *
 * Pure with respect to global state: no DOM, no storage, no `Date.now`. The
 * caller persists the returned {@link Dataset} through the repository.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 15.3, 17.4.
 */

import { bucketTimestamp } from "@/engine/bucket";
import type {
  AppAssignment,
  CanonicalKPIId,
  Dataset,
  DimensionId,
  IngestionMode,
  KPIRecord,
  RawSessionFields,
} from "@/models";
import { ALL_KPI_IDS, KPI_BY_ID } from "@/registry/kpi-registry";

// ---------------------------------------------------------------------------
// Public options and constants
// ---------------------------------------------------------------------------

/** Volume profile for the generated dataset (design "Scale Profiles"). */
export type ScaleProfile = "standard" | "stress";

/** Options controlling mock generation. All optional; defaults give the demo dataset. */
export interface MockSeedOptions {
  /**
   * Volume profile. `standard` (default) emits a compact pre-aggregated demo
   * dataset; `stress` emits 25,000+ raw-session records to exercise worker
   * offloading and table virtualization (Req 15.3, 17.4).
   */
  scale?: ScaleProfile;
  /** Dataset id assigned to the dataset and stamped on every record. */
  datasetId?: string;
  /** Deterministic PRNG seed. The same seed always yields identical records. */
  seed?: number;
  /** Number of days in the comparative window. Defaults to 30 (Req 9.2). */
  days?: number;
  /**
   * Inclusive UTC end day of the window (the most recent day), `YYYY-MM-DD`.
   * The window spans `[endDay - (days - 1), endDay]`. Fixed so generation is
   * independent of the wall clock.
   */
  endDay?: string;
}

/** Default number of days in the comparative window (Req 9.2). */
export const DEMO_DAYS = 30;

/** Fixed default seed so the demo dataset is reproducible. */
export const DEFAULT_MOCK_SEED = 0x0757_ab13;

/**
 * Fixed default end day for the demo window. Choosing a constant (rather than
 * "today") keeps generation deterministic and snapshot-stable.
 */
export const DEFAULT_END_DAY = "2025-03-31";

/** App_A demo label (Req 9.2). */
export const DEMO_APP_A_LABEL = "Current";
/** App_B demo label (Req 9.2). */
export const DEMO_APP_B_LABEL = "Experimental";

/** The two compared apps, in order. */
const APPS: readonly AppAssignment[] = ["App_A", "App_B"];

/**
 * The three demo platforms, one representative member per form factor family so
 * the seeded dataset spans Mobile, Connected TV, and Desktop Web (Req 9.3).
 */
const DEMO_PLATFORMS: readonly string[] = ["Android", "Android TV", "Desktop Web"];

/**
 * The two demo stream types: one live and one VOD, so the dataset spans live
 * streaming and VOD (Req 9.3).
 */
const DEMO_STREAM_TYPES: readonly string[] = ["Live Sports/Events", "VOD Movies"];

/** Representative demo members for the remaining dimensions. */
const DEMO_NETWORKS: readonly string[] = ["Wi-Fi", "Cellular 5G", "Broadband"];
const DEMO_CDNS: readonly string[] = ["Akamai", "Cloudflare", "Fastly"];
const DEMO_GEOS: readonly string[] = ["Country", "Region", "Metro"];

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32 — a tiny, fast, deterministic PRNG. Given the same 32-bit seed it
 * produces the same sequence of floats in [0, 1). Used for every random draw so
 * the generated dataset is reproducible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random draw in `[min, max)`. */
function between(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Round to 2 decimals, matching the engine's percentage/rate presentation. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Clamp a value into `[lo, hi]`. */
function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

// ---------------------------------------------------------------------------
// Per-KPI canonical-unit baselines
// ---------------------------------------------------------------------------

/**
 * Plausible baseline values per KPI, expressed in each KPI's canonical unit.
 * The seeder jitters these per record and applies a small App_B offset so the
 * two apps differ realistically. Values are chosen to sit inside each KPI's
 * `validRange`. Derived KPIs (Stickiness) and count KPIs (DAU/WAU/MAU) are
 * handled separately, not via this table.
 */
const KPI_BASELINE: Partial<Record<CanonicalKPIId, number>> = {
  // Playback Quality & QoE (canonical: s, %, events/hour, Mbps, drops/session)
  vst_p50: 0.9, // s
  vst_p95: 2.4, // s
  rebuffer_ratio: 0.35, // %
  rebuffer_rate: 0.18, // events/hour
  vsf: 0.45, // %
  ebvs: 1.6, // %
  avg_rendered_bitrate: 6.5, // Mbps
  downshift_frequency: 1.2, // drops/session
  // User Engagement & Audience Retention
  total_watch_time: 4200, // hours (per day/platform/streamType slice)
  avg_session_duration: 34, // min
  content_completion_25: 88, // %
  content_completion_50: 71, // %
  content_completion_75: 55, // %
  content_completion_100: 42, // %
  browse_to_play: 63, // %
  // Monetization & AdTech
  ad_fill_rate: 92, // %
  ad_start_failure: 0.7, // %
  vcr_ads: 78, // %
  ad_pod_dropoff: 6.5, // %
  churn_rate: 3.8, // %
  arpu: 4.25, // USD
  // Infrastructure & Delivery
  cdn_cache_hit_ratio: 96, // %
  manifest_fetch_latency: 120, // ms
  ttfb: 85, // ms
};

/** Baseline daily distinct-user counts per (platform × streamType) slice. */
const DAU_BASELINE = 5200;

/**
 * App_B multiplicative offset per KPI so the experimental variant differs from
 * the current app. Directionality-agnostic here (the comparator interprets the
 * direction); a value slightly above/below 1 keeps deltas realistic.
 */
function appBFactor(rng: () => number): number {
  // Roughly ±8% variation around parity.
  return between(rng, 0.92, 1.08);
}

// ---------------------------------------------------------------------------
// Day-window helpers
// ---------------------------------------------------------------------------

/** Build the inclusive list of UTC `YYYY-MM-DD` days ending at `endDay`. */
function buildDays(endDay: string, days: number): string[] {
  const endMs = Date.parse(`${endDay}T00:00:00Z`);
  if (Number.isNaN(endMs)) {
    throw new RangeError(`seedMockDataset: invalid endDay "${endDay}"`);
  }
  const MS_PER_DAY = 86_400_000;
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayMs = endMs - i * MS_PER_DAY;
    out.push(new Date(dayMs).toISOString().slice(0, 10));
  }
  return out;
}

/** ISO UTC timestamp at a given hour of a `YYYY-MM-DD` day. */
function timestampAt(day: string, hour: number): string {
  const hh = hour < 10 ? `0${hour}` : `${hour}`;
  return `${day}T${hh}:00:00Z`;
}

/** Build the full dimension map for a record from its slice coordinates. */
function dimensionsFor(
  platform: string,
  streamType: string,
  network: string,
  cdn: string,
  geo: string,
): Record<DimensionId, string> {
  return {
    platform,
    streamType,
    network,
    cdn,
    geography: geo,
  };
}

// ---------------------------------------------------------------------------
// Standard (pre-aggregated) profile
// ---------------------------------------------------------------------------

/**
 * Compute the pre-aggregated `metrics` map for one (day × platform × streamType
 * × app) slice. Every KPI gets a value in its canonical unit; derived Stickiness
 * is computed from the slice's DAU/MAU so it is internally consistent.
 */
function buildMetricsForSlice(
  rng: () => number,
  app: AppAssignment,
  dayIndex: number,
): { metrics: Partial<Record<CanonicalKPIId, number>>; volumeWeight: number } {
  const metrics: Partial<Record<CanonicalKPIId, number>> = {};
  const bFactor = app === "App_B" ? appBFactor(rng) : 1;

  for (const kpiId of ALL_KPI_IDS) {
    const def = KPI_BY_ID[kpiId];
    if (kpiId === "stickiness") {
      continue; // derived below from DAU/MAU
    }
    if (kpiId === "dau" || kpiId === "wau" || kpiId === "mau") {
      continue; // count KPIs handled below
    }
    const base = KPI_BASELINE[kpiId];
    if (base === undefined) {
      continue;
    }
    // Small day-over-day drift plus per-record jitter, then the App_B offset.
    const drift = 1 + Math.sin(dayIndex / 5) * 0.04;
    const jitter = between(rng, 0.95, 1.05);
    let value = base * drift * jitter * bFactor;

    const [lo, hi] = def.validRange ?? [0, Number.MAX_SAFE_INTEGER];
    value = clamp(value, lo, hi);
    // Percentages and most rates read best at 2 decimals; bitrate/latency too.
    metrics[kpiId] = round2(value);
  }

  // Distinct-count KPIs: emitted as pre-aggregated counts at this slice's
  // ingested granularity. DAU per day; WAU/MAU are larger rolling counts.
  const dau = Math.round(DAU_BASELINE * between(rng, 0.9, 1.1) * bFactor);
  const wau = Math.round(dau * between(rng, 3.5, 4.5));
  const mau = Math.round(dau * between(rng, 9, 12));
  metrics.dau = dau;
  metrics.wau = wau;
  metrics.mau = mau;

  // Derived Stickiness = DAU / MAU * 100 (Req 24.1), consistent with the slice.
  metrics.stickiness = round2((100 * dau) / mau);

  // Volume weight approximates the sessions behind the slice.
  const volumeWeight = Math.round(dau * between(rng, 1.2, 1.8));

  return { metrics, volumeWeight };
}

/**
 * Generate the `standard` pre-aggregated demo records: one record per
 * (day × platform × streamType × app), each carrying a full `metrics` map.
 */
function seedStandard(
  rng: () => number,
  datasetId: string,
  days: string[],
): KPIRecord[] {
  const records: KPIRecord[] = [];
  days.forEach((day, dayIndex) => {
    for (const platform of DEMO_PLATFORMS) {
      for (const streamType of DEMO_STREAM_TYPES) {
        // Rotate the remaining dimensions deterministically so the demo has
        // some spread without exploding the record count.
        const network = DEMO_NETWORKS[dayIndex % DEMO_NETWORKS.length];
        const cdn = DEMO_CDNS[dayIndex % DEMO_CDNS.length];
        const geo = DEMO_GEOS[dayIndex % DEMO_GEOS.length];
        for (const app of APPS) {
          const { metrics, volumeWeight } = buildMetricsForSlice(rng, app, dayIndex);
          const timestampUtc = timestampAt(day, 0);
          records.push({
            id: `${datasetId}:std:${day}:${platform}:${streamType}:${app}`,
            datasetId,
            app,
            timestampUtc,
            sourceUtcOffsetMinutes: 0,
            bucket: bucketTimestamp(timestampUtc),
            origin: "mock",
            dimensions: dimensionsFor(platform, streamType, network, cdn, geo),
            metrics,
            volumeWeight,
            ingestedGranularity: "day",
          });
        }
      }
    }
  });
  return records;
}

// ---------------------------------------------------------------------------
// Stress (raw-session) profile
// ---------------------------------------------------------------------------

/**
 * Build one raw session's fields, in canonical raw units (ms, counts, 0/1
 * flags) consistent with {@link RawSessionFields}. Values are drawn so that the
 * raw-mode compute functions produce plausible KPI values.
 */
function buildSession(rng: () => number, app: AppAssignment, userId: string): RawSessionFields {
  const bFactor = app === "App_B" ? between(rng, 0.92, 1.08) : 1;

  const playTimeMs = Math.round(between(rng, 5 * 60_000, 90 * 60_000));
  const bufferingMs = Math.round(playTimeMs * between(rng, 0, 0.01) * bFactor);
  const viewingTimeMs = playTimeMs + bufferingMs;
  const sessionDurationMs = viewingTimeMs + Math.round(between(rng, 0, 120_000));

  const playbackAttempt: 0 | 1 = 1;
  const startFailure: 0 | 1 = rng() < 0.005 * bFactor ? 1 : 0;
  const exitBeforeStart: 0 | 1 = rng() < 0.016 ? 1 : 0;

  // Furthest completion quartile reached, weighted toward higher completion.
  const q = rng();
  const quartileReached: 0 | 25 | 50 | 75 | 100 =
    q < 0.12 ? 0 : q < 0.29 ? 25 : q < 0.45 ? 50 : q < 0.58 ? 75 : 100;

  const browseEvent: 0 | 1 = 1;
  const playEvent: 0 | 1 = rng() < 0.63 ? 1 : 0;

  const adRequestCount = Math.round(between(rng, 1, 6));
  const adFilledCount = Math.round(adRequestCount * between(rng, 0.85, 1));
  const adStartFailureCount = rng() < 0.02 ? 1 : 0;
  const adCompleteCount = Math.round(adFilledCount * between(rng, 0.7, 0.95));
  const adPodStartCount = adFilledCount > 0 ? 1 : 0;
  const adPodAbandonCount = adPodStartCount === 1 && rng() < 0.08 ? 1 : 0;

  return {
    bufferingMs,
    playTimeMs,
    viewingTimeMs,
    rebufferEventCount: Math.round(between(rng, 0, 3)),
    startFailure,
    playbackAttempt,
    exitBeforeStart,
    vstMs: Math.round(between(rng, 300, 4000) * bFactor),
    ttfbMs: Math.round(between(rng, 40, 220) * bFactor),
    manifestFetchMs: Math.round(between(rng, 60, 320) * bFactor),
    renderedBitrateKbps: Math.round(between(rng, 2500, 9000)),
    downshiftCount: Math.round(between(rng, 0, 4)),
    userId,
    sessionDurationMs,
    quartileReached,
    browseEvent,
    playEvent,
    adRequestCount,
    adFilledCount,
    adStartFailureCount,
    adCompleteCount,
    adPodStartCount,
    adPodAbandonCount,
    cacheHit: rng() < 0.96 ? 1 : 0,
  };
}

/**
 * Number of raw sessions generated per (hour × platform × streamType × app)
 * cell in the stress profile. Sized so the total clears 25,000 records:
 * 30 days × 24 hours × 3 platforms × 2 stream types × 2 apps = 8,640 cells;
 * one session per cell already exceeds 25,000. We emit a small handful per cell
 * for a more realistic distribution while keeping generation fast.
 */
const STRESS_SESSIONS_PER_CELL = 4;

/**
 * Generate the `stress` raw-session demo records at hourly granularity so the
 * dataset deterministically exceeds 25,000 records (Req 17.4). Each record is a
 * single raw session carrying a `session` payload and a mapped `userId`.
 */
function seedStress(
  rng: () => number,
  datasetId: string,
  days: string[],
): KPIRecord[] {
  const records: KPIRecord[] = [];
  let userCounter = 0;
  days.forEach((day) => {
    for (let hour = 0; hour < 24; hour += 1) {
      const timestampUtc = timestampAt(day, hour);
      const bucket = bucketTimestamp(timestampUtc);
      for (let p = 0; p < DEMO_PLATFORMS.length; p += 1) {
        const platform = DEMO_PLATFORMS[p];
        for (let s = 0; s < DEMO_STREAM_TYPES.length; s += 1) {
          const streamType = DEMO_STREAM_TYPES[s];
          const network = DEMO_NETWORKS[(hour + p) % DEMO_NETWORKS.length];
          const cdn = DEMO_CDNS[(hour + s) % DEMO_CDNS.length];
          const geo = DEMO_GEOS[(p + s) % DEMO_GEOS.length];
          for (const app of APPS) {
            for (let n = 0; n < STRESS_SESSIONS_PER_CELL; n += 1) {
              // Reuse user ids across the window so distinct-count KPIs dedupe.
              const userId = `u${(userCounter % 4000) + 1}`;
              userCounter += 1;
              const session = buildSession(rng, app, userId);
              records.push({
                id: `${datasetId}:raw:${day}:${hour}:${platform}:${streamType}:${app}:${n}`,
                datasetId,
                app,
                timestampUtc,
                sourceUtcOffsetMinutes: 0,
                bucket,
                origin: "mock",
                dimensions: dimensionsFor(platform, streamType, network, cdn, geo),
                session,
                volumeWeight: 1,
                ingestedGranularity: "hour",
              });
            }
          }
        }
      }
    }
  });
  return records;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic 30-day comparative demo {@link Dataset} (Req 9).
 *
 * @param options See {@link MockSeedOptions}. Defaults produce the `standard`
 *   pre-aggregated demo dataset with the fixed demo seed and window.
 * @returns A dataset with `sourceType: "Mock"`, App_A/App_B demo labels, and
 *   records in canonical units and UTC. The `standard` profile is pre-aggregated
 *   (~500 records); the `stress` profile is raw-session with 25,000+ records.
 */
export function seedMockDataset(options: MockSeedOptions = {}): Dataset {
  const scale: ScaleProfile = options.scale ?? "standard";
  const datasetId = options.datasetId ?? `mock-${scale}`;
  const seed = options.seed ?? DEFAULT_MOCK_SEED;
  const days = options.days ?? DEMO_DAYS;
  const endDay = options.endDay ?? DEFAULT_END_DAY;

  const rng = mulberry32(seed);
  const dayList = buildDays(endDay, days);

  const records =
    scale === "stress"
      ? seedStress(rng, datasetId, dayList)
      : seedStandard(rng, datasetId, dayList);

  const ingestionMode: IngestionMode =
    scale === "stress" ? "Raw_Session" : "Pre_Aggregated";

  return {
    id: datasetId,
    name: scale === "stress" ? "OTT Demo (Stress)" : "OTT Demo Dataset",
    createdAt: `${endDay}T00:00:00Z`,
    appALabel: DEMO_APP_A_LABEL,
    appBLabel: DEMO_APP_B_LABEL,
    recordCount: records.length,
    sourceType: "Mock",
    ingestionMode,
    records,
  };
}
