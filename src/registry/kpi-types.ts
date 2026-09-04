/**
 * KPI taxonomy type definitions (Req 1, 22.1, 22.2, 24.1).
 *
 * These types describe the shape of a single KPI in the taxonomy registry.
 * The seeded registry array lives in `kpi-registry.ts`; keeping the types
 * separate lets tests and consumers import the shapes without pulling in the
 * whole seed data.
 */

import type { CanonicalKPIId } from "@/models/ids";

/** The four KPI pillars (Req 1.1). */
export type Pillar =
  | "Playback Quality & QoE"
  | "User Engagement & Audience Retention"
  | "Monetization & AdTech"
  | "Infrastructure & Delivery";

/**
 * Whether a larger value is better or worse for the KPI (Req 1.2). Drives
 * directionality-aware delta, RAG, and winner logic.
 */
export type Directionality = "higher_is_better" | "lower_is_better";

/** How a KPI's values are validly combined across records/segments. */
export type AggregationKind =
  | "weighted_avg" // rates and percentages, weighted by volumeWeight (Req 20)
  | "percentile" // valid only over an underlying distribution
  | "sum" // additive totals (watch time, event counts)
  | "ratio" // numerator/denominator recomputed from summed components
  | "arithmetic_avg" // unweighted mean, used only where no weight is meaningful
  | "distinct_count" // DAU / WAU / MAU: countable from raw sessions, never summable
  | "non_aggregable"; // cannot be validly combined across segments at all

/**
 * A source unit recognized at ingestion, with the multiplicative factor that
 * converts a value expressed in this unit to the KPI's `canonicalUnit` (Req 22.1).
 */
export interface UnitSpec {
  /** Unit token as it appears in headers, e.g. "ms", "s", "kbps". */
  token: string;
  /** Multiply a value in this unit by `factor` to get the canonical unit. */
  factor: number;
}

/** Definition of a derived KPI computed from other KPIs' aggregates (Req 24). */
export interface KPIDerivation {
  /** Operands, each aggregated first before the derivation is applied (Req 24.2). */
  operands: CanonicalKPIId[];
  operation: "divide" | "multiply" | "subtract";
  /** Optional scale, e.g. 100 to express a ratio as a percentage. */
  scale?: number;
}

/** A single KPI in the taxonomy (Req 1.2). */
export interface KPIDefinition {
  id: CanonicalKPIId;
  name: string;
  pillar: Pillar;
  directionality: Directionality;
  /** Display unit; equals `canonicalUnit`. */
  unit: string;
  /** The single unit all stored values are expressed in (Req 22.1, 22.2). */
  canonicalUnit: string;
  /** Source units recognized at ingestion, with conversion factors (Req 22.1). */
  acceptedUnits: UnitSpec[];
  /** Default SLA threshold, expressed in `canonicalUnit` (Req 1.2, 22.2). */
  defaultSLA?: number;
  /** Valid range for SLA panel validation, in `canonicalUnit` (Req 14.4, 22.2). */
  validRange?: [number, number];
  aggregation: AggregationKind;
  /** Present only for derived KPIs, e.g. Stickiness (Req 24.1). */
  derived?: KPIDerivation;
  /** Fuzzy-match aliases, e.g. ["ttff","startup_time","vst_ms"] (Req 7.4). */
  aliases: string[];
  /** Percentile ranks reported, e.g. [50, 90, 95] for latency KPIs. */
  percentileRanks?: number[];
  /** false -> pre-aggregated only (see the raw-mode coverage matrix). */
  rawModeComputable: boolean;
}
