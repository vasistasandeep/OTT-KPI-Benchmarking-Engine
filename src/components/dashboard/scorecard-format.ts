/**
 * Presentation helpers for the ScorecardGrid (task 17.1).
 *
 * Pure formatting and classification helpers shared by the scorecards and their
 * tests. They translate the engine's `Numeric` values, RAG statuses, and
 * suppression reasons into the strings, glyph choices, and token-based color
 * classes the cards render.
 *
 * Two constraints are enforced here:
 * - RAG is **never conveyed by color alone** — every status pairs a token color
 *   with a glyph and a text label (Req 28.2).
 * - Colors resolve against the dark-theme `rag.*` tokens; nothing hard-codes a
 *   hex value (Req 15.1).
 */

import type { RAGStatus, SuppressionReason } from "@/models/results";
import { NO_DATA, NOT_AGGREGABLE, type Numeric } from "@/models/sentinels";

/** True when a value is one of the two suppression sentinels. */
export function isSentinel(value: Numeric | "N/A"): boolean {
  return value === NO_DATA || value === NOT_AGGREGABLE;
}

/**
 * Format a finite KPI value with its unit. Sentinels render as the no-data /
 * not-aggregable dash so a card never prints `null` or the raw sentinel token.
 * Finite values keep up to 2 decimals, trimming trailing zeros for density.
 */
export function formatValue(value: Numeric, unit: string): string {
  if (value === NO_DATA) return "—";
  if (value === NOT_AGGREGABLE) return "—";
  const n = value as number;
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return unit ? `${text} ${unit}` : text;
}

/**
 * Format the absolute delta (`appB - appA`). A sentinel delta (either app has
 * no finite value) renders as a dash; a finite delta is shown to 2 decimals
 * with an explicit sign so the direction is unambiguous.
 */
export function formatAbsoluteDelta(delta: Numeric, unit: string): string {
  if (isSentinel(delta)) return "—";
  const n = delta as number;
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  const sign = rounded > 0 ? "+" : "";
  return unit ? `${sign}${rounded} ${unit}` : `${sign}${rounded}`;
}

/**
 * Format the percentage delta. `"N/A"` (App_A == 0, Req 11.4) is rendered as the
 * not-applicable label; a sentinel is a dash; a finite value is shown to 2
 * decimals with an explicit sign and a percent suffix.
 */
export function formatPercentDelta(percent: Numeric | "N/A"): string {
  if (percent === "N/A") return "N/A";
  if (isSentinel(percent)) return "—";
  const n = percent as number;
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}%`;
}

/** A RAG badge's presentation: label, glyph name, and token-based classes. */
export interface RagPresentation {
  label: string;
  /** Lucide icon name chosen per status; the card maps it to a component. */
  glyph: "check" | "alert-triangle" | "x" | "help" | "shield-alert";
  /** Tailwind classes referencing the dark-theme rag.* tokens (Req 15.1). */
  className: string;
}

/**
 * Map a RAG status (with its suppression reason) to a label + glyph + color
 * class. Green/Amber/Red use their matching token; the two suppressed verdicts
 * (NoData, LowConfidence) use the neutral token and a distinct glyph so the
 * status is legible without color (Req 28.2, 25.5).
 */
export function ragPresentation(
  rag: RAGStatus,
  reason?: SuppressionReason,
): RagPresentation {
  switch (rag) {
    case "Green":
      return {
        label: "Green",
        glyph: "check",
        className: "border-rag-green/50 bg-rag-green/15 text-rag-green",
      };
    case "Amber":
      return {
        label: "Amber",
        glyph: "alert-triangle",
        className: "border-rag-amber/50 bg-rag-amber/15 text-rag-amber",
      };
    case "Red":
      return {
        label: "Red",
        glyph: "x",
        className: "border-rag-red/50 bg-rag-red/15 text-rag-red",
      };
    case "LowConfidence":
      return {
        label: "Low confidence",
        glyph: "shield-alert",
        className: "border-rag-neutral/50 bg-rag-neutral/15 text-rag-neutral",
      };
    case "NoData":
    default:
      return {
        label: reason === "not_aggregable" ? "Not aggregable" : "No data",
        glyph: "help",
        className: "border-rag-neutral/50 bg-rag-neutral/15 text-rag-neutral",
      };
  }
}

/** A short label for one of the three data-quality advisory codes (Req 22.6, 22.9, 20.4). */
export function advisoryLabel(
  code: "ASSUMED_UNIT" | "NON_MONOTONIC_QUARTILES" | "UNWEIGHTED_AGGREGATE" | "UNKNOWN_DIMENSION_MEMBER",
): string {
  switch (code) {
    case "ASSUMED_UNIT":
      return "Assumed unit";
    case "UNWEIGHTED_AGGREGATE":
      return "Unweighted";
    case "NON_MONOTONIC_QUARTILES":
      return "Non-monotonic quartiles";
    case "UNKNOWN_DIMENSION_MEMBER":
      return "Unknown dimension";
  }
}
