/**
 * SLAConfig — the pure, DOM-free logic behind the SLAConfigPanel
 * (design "SLAConfigPanel (Req 14)"; Req 14.1, 14.2, 14.3, 14.4, 22.7, 25.1,
 * 25.10, 25.11).
 *
 * The React component (`SLAConfigPanel`) owns no validation logic of its own:
 * it renders the state this module derives and calls back into it. Keeping the
 * derivation here (pure, storage-free) makes the whole SLA-entry decision path
 * unit-testable without mounting a component (task 18.2).
 *
 * The panel edits three things (Req 14.1, 25.1):
 *   - a per-KPI SLA threshold, entered in that KPI's canonical unit and bounded
 *     by the KPI's `validRange` (Req 14.4, 22.2, 22.7);
 *   - the variance band (%) that drives the Amber RAG band (Req 11.6, 14.1);
 *   - the minimum contributing sample size that gates thin-sample verdicts,
 *     validated as a non-negative integer, defaulting to 100, where 0 disables
 *     the gate (Req 25.1, 25.10, 25.11).
 *
 * Validation is per-field: an invalid threshold flags only that KPI's field and
 * leaves the rest of the draft submittable, exactly like the manual-entry table
 * (Req 14.4). A draft is `valid` only when every field parses within its bounds,
 * so the panel's Save can build a clean `SLAConfig`.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 22.7, 25.1, 25.10, 25.11.
 */

import type { SLAConfig } from "@/models/config";
import type { CanonicalKPIId } from "@/models/ids";
import { KPI_REGISTRY, getKPI } from "@/registry";
import { DEFAULT_SLA_CONFIG } from "@/repository";

/**
 * The editable form state the panel collects before saving. Every field is raw
 * text so a partially typed or invalid value is preserved for the user to fix
 * rather than being coerced away.
 */
export interface SLAConfigDraft {
  /** Raw text per KPI threshold, keyed by KPI id, in that KPI's canonical unit. */
  thresholds: Partial<Record<CanonicalKPIId, string>>;
  /** Raw text for the variance band (%). */
  varianceBand: string;
  /** Raw text for the minimum contributing sample size. */
  minSampleSize: string;
}

/** A single threshold field problem: which KPI and a human-readable reason. */
export interface ThresholdFieldError {
  kpiId: CanonicalKPIId;
  /** Message naming the KPI's valid range (Req 14.4). */
  reason: string;
}

/** The outcome of validating an SLA-config draft against its per-field rules. */
export interface SLAConfigValidation {
  /** True when every field parses within its bounds. */
  valid: boolean;
  /** Per-KPI threshold problems, one per invalid/out-of-range entry (Req 14.4). */
  thresholdErrors: ThresholdFieldError[];
  /** Set when the variance band is non-numeric or negative. */
  varianceBandError?: string;
  /** Set when the min sample size is not a non-negative integer (Req 25.10). */
  minSampleSizeError?: string;
}

/**
 * Format a KPI's valid range for display, in its canonical unit (Req 14.4, 22.7).
 * Returns e.g. "0–60 s". When no range is declared, only the unit is named.
 */
export function formatValidRange(kpiId: CanonicalKPIId): string {
  const kpi = getKPI(kpiId);
  const unit = kpi?.canonicalUnit ?? "";
  if (!kpi?.validRange) return unit;
  const [min, max] = kpi.validRange;
  return `${min}\u2013${max}${unit ? ` ${unit}` : ""}`;
}

/**
 * Classify one raw threshold string for a KPI. Returns:
 *   - `{ kind: "blank" }` when empty/whitespace (fall back to the KPI default);
 *   - `{ kind: "invalid", reason }` when non-numeric or outside `validRange`
 *     (flagged, not saved — Req 14.4);
 *   - `{ kind: "value", value }` with the parsed number otherwise.
 */
export function classifyThreshold(
  kpiId: CanonicalKPIId,
  text: string,
):
  | { kind: "blank" }
  | { kind: "invalid"; reason: string }
  | { kind: "value"; value: number } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "blank" };

  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return {
      kind: "invalid",
      reason: `Enter a number within ${formatValidRange(kpiId)}`,
    };
  }

  const kpi = getKPI(kpiId);
  if (kpi?.validRange) {
    const [min, max] = kpi.validRange;
    if (n < min || n > max) {
      return {
        kind: "invalid",
        reason: `Value must be within ${formatValidRange(kpiId)}`,
      };
    }
  }

  return { kind: "value", value: n };
}

/**
 * Classify the raw variance-band string. It is a non-negative percentage; a
 * non-numeric or negative entry is rejected (Req 14.1).
 */
export function classifyVarianceBand(
  text: string,
): { kind: "value"; value: number } | { kind: "invalid"; reason: string } {
  const trimmed = text.trim();
  const n = Number(trimmed);
  if (trimmed.length === 0 || !Number.isFinite(n) || n < 0) {
    return { kind: "invalid", reason: "Variance band must be a non-negative number" };
  }
  return { kind: "value", value: n };
}

/**
 * Classify the raw min-sample-size string. It must be a non-negative integer;
 * 0 disables the confidence gate (Req 25.10, 25.11).
 */
export function classifyMinSampleSize(
  text: string,
): { kind: "value"; value: number } | { kind: "invalid"; reason: string } {
  const trimmed = text.trim();
  const n = Number(trimmed);
  if (
    trimmed.length === 0 ||
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < 0
  ) {
    return {
      kind: "invalid",
      reason: "Min sample size must be a non-negative integer",
    };
  }
  return { kind: "value", value: n };
}

/**
 * Validate an SLA-config draft (Req 14.4, 25.10). Flags every non-numeric or
 * out-of-range threshold as a per-field error naming that KPI's valid range,
 * and validates the variance band and min sample size. A draft is `valid` when
 * no field is invalid.
 */
export function validateSLAConfig(draft: SLAConfigDraft): SLAConfigValidation {
  const thresholdErrors: ThresholdFieldError[] = [];

  for (const [kpiId, text] of Object.entries(draft.thresholds)) {
    if (typeof text !== "string") continue;
    const classified = classifyThreshold(kpiId as CanonicalKPIId, text);
    if (classified.kind === "invalid") {
      thresholdErrors.push({ kpiId: kpiId as CanonicalKPIId, reason: classified.reason });
    }
  }

  const variance = classifyVarianceBand(draft.varianceBand);
  const varianceBandError = variance.kind === "invalid" ? variance.reason : undefined;

  const minSample = classifyMinSampleSize(draft.minSampleSize);
  const minSampleSizeError = minSample.kind === "invalid" ? minSample.reason : undefined;

  return {
    valid:
      thresholdErrors.length === 0 &&
      varianceBandError === undefined &&
      minSampleSizeError === undefined,
    thresholdErrors,
    varianceBandError,
    minSampleSizeError,
  };
}

/**
 * Build a canonical `SLAConfig` from a validated draft (Req 14.2, 25.1).
 *
 * A blank threshold field means "no override" and is omitted, so the KPI falls
 * back to its registry `defaultSLA` in classification. Callers must validate the
 * draft first; an invalid field is skipped rather than persisted, but the panel
 * blocks Save on `!valid` so this is a defensive fallback.
 */
export function buildSLAConfig(draft: SLAConfigDraft): SLAConfig {
  const thresholds: Partial<Record<CanonicalKPIId, number>> = {};
  for (const [kpiId, text] of Object.entries(draft.thresholds)) {
    if (typeof text !== "string") continue;
    const classified = classifyThreshold(kpiId as CanonicalKPIId, text);
    if (classified.kind === "value") {
      thresholds[kpiId as CanonicalKPIId] = classified.value;
    }
  }

  const variance = classifyVarianceBand(draft.varianceBand);
  const minSample = classifyMinSampleSize(draft.minSampleSize);

  return {
    varianceBand:
      variance.kind === "value" ? variance.value : DEFAULT_SLA_CONFIG.varianceBand,
    minSampleSize:
      minSample.kind === "value" ? minSample.value : DEFAULT_SLA_CONFIG.minSampleSize,
    thresholds,
  };
}

/**
 * Reconstruct an editable draft from a persisted `SLAConfig` so the panel can
 * open showing the active values. A KPI with no override shows an empty field
 * (its default applies), so the user sees exactly which KPIs are customized.
 */
export function draftFromConfig(config: SLAConfig): SLAConfigDraft {
  const thresholds: Partial<Record<CanonicalKPIId, string>> = {};
  for (const kpi of KPI_REGISTRY) {
    const override = config.thresholds[kpi.id];
    thresholds[kpi.id] = override === undefined ? "" : String(override);
  }
  return {
    thresholds,
    varianceBand: String(config.varianceBand),
    minSampleSize: String(config.minSampleSize),
  };
}

/**
 * A fresh draft seeded from the built-in defaults (SLA panel "reset", Req 14.3).
 * Every per-KPI threshold field is blank so the KPI's registry `defaultSLA`
 * applies, and the variance band / min sample size show their defaults.
 */
export function defaultDraft(): SLAConfigDraft {
  const thresholds: Partial<Record<CanonicalKPIId, string>> = {};
  for (const kpi of KPI_REGISTRY) {
    thresholds[kpi.id] = "";
  }
  return {
    thresholds,
    varianceBand: String(DEFAULT_SLA_CONFIG.varianceBand),
    minSampleSize: String(DEFAULT_SLA_CONFIG.minSampleSize),
  };
}
