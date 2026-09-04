/**
 * Pure CSV builders for the export menu (Req 18.2, 18.4, 18.7, 26.8, 28.12).
 *
 * These functions turn an already-computed {@link ComparisonResultSet} /
 * {@link AggregatedResultSet} into CSV text. They are deliberately framework-
 * free and side-effect-free so the download trigger, the print report, and the
 * example tests (task 18.5) can all drive the exact same content:
 *
 *   - {@link buildDeltaCSV} — one row per active KPI with the App_A / App_B
 *     values, the absolute and percentage deltas, and the RAG status
 *     (Req 18.2).
 *   - {@link buildAggregatedSummaryCSV} — the aggregated per-app KPI values for
 *     the active slice (Req 18.4).
 *
 * Both prepend a metadata header naming the active display timezone (so an
 * exported row is never ambiguous about which day it belongs to, Req 26.8) and
 * neither ever emits a user-identifier column — exports carry aggregated values
 * only (Req 28.12).
 *
 * The empty-slice guard is expressed here as {@link hasExportableData}: if the
 * active slice matched no records there is nothing to export, so the caller
 * shows a "no active data to export" message and produces no file (Req 18.7).
 */

import { NO_DATA, NOT_AGGREGABLE } from "@/models/sentinels";
import type { Numeric } from "@/models/sentinels";
import type {
  AggregatedKPIValue,
  AggregatedResultSet,
  ComparisonResult,
  ComparisonResultSet,
  FilterSlice,
  RAGStatus,
} from "@/models/results";
import type { AppAssignment } from "@/models/records";
import type { CanonicalKPIId } from "@/models/ids";
import { getKPI } from "@/registry";

/** Labels shown for App_A / App_B in the exported columns (Req 19.5). */
export interface ExportLabels {
  appA: string;
  appB: string;
}

/** The default generic App labels when no dataset override is present. */
export const DEFAULT_EXPORT_LABELS: ExportLabels = { appA: "App A", appB: "App B" };

/**
 * The cell text used for each sentinel so an exported value is self-describing
 * rather than blank (Req 16.1, 23.4). A finite value is written verbatim.
 */
function formatNumeric(value: Numeric | "N/A"): string {
  if (value === NO_DATA) return "No data";
  if (value === NOT_AGGREGABLE) return "Not aggregable";
  if (value === "N/A") return "N/A";
  return String(value);
}

/** Human-readable RAG label used in the exported status column. */
function formatRAG(rag: RAGStatus): string {
  switch (rag) {
    case "LowConfidence":
      return "Low confidence";
    case "NoData":
      return "No data";
    default:
      return rag;
  }
}

/**
 * Escape a single CSV field per RFC 4180: wrap in double quotes when the value
 * contains a comma, quote, or newline, doubling any embedded quote. Keeps the
 * output well-formed regardless of custom App labels or KPI names.
 */
export function escapeCSVField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Join one row's fields into a CSV line, escaping each field. */
function toRow(fields: string[]): string {
  return fields.map(escapeCSVField).join(",");
}

/**
 * The metadata header lines prepended to every export. Naming the active
 * display timezone makes an exported timestamp unambiguous (Req 26.8); the
 * date-range summary records which slice the file was produced for.
 */
function metadataLines(slice: FilterSlice): string[] {
  const { dateRange, displayTimezone } = slice;
  const rangeText =
    dateRange.preset === "custom"
      ? `${dateRange.from ?? ""} to ${dateRange.to ?? ""}`
      : dateRange.preset === "7d"
        ? "Last 7 days"
        : "Last 30 days";
  return [
    toRow(["# Display timezone", displayTimezone]),
    toRow(["# Date range", rangeText]),
    toRow(["# Granularity", slice.granularity]),
  ];
}

/**
 * True when the active slice produced anything worth exporting. The recompute
 * pipeline reports `noData` when the slice matched no records at all; a result
 * set with no KPI rows is likewise nothing to export (Req 18.7).
 */
export function hasExportableData(
  result: ComparisonResultSet | null,
  noData: boolean,
): result is ComparisonResultSet {
  return !noData && result !== null && result.results.length > 0;
}

/** The message shown when there is nothing to export (Req 18.7). */
export const NO_EXPORT_DATA_MESSAGE = "There is no active data to export.";

/** A comparison row rendered as CSV fields (Req 18.2). */
function deltaRow(result: ComparisonResult, kpiName: string, unit: string): string[] {
  return [
    kpiName,
    unit,
    formatNumeric(result.appAValue),
    formatNumeric(result.appBValue),
    formatNumeric(result.absoluteDelta),
    formatNumeric(result.percentDelta),
    formatRAG(result.rag),
  ];
}

/**
 * Build the Delta CSV for the active slice: every active KPI with the App_A and
 * App_B values, the absolute and percentage deltas, and the RAG status
 * (Req 18.2). No user-identifier column is ever emitted (Req 28.12).
 */
export function buildDeltaCSV(
  result: ComparisonResultSet,
  labels: ExportLabels = DEFAULT_EXPORT_LABELS,
): string {
  const header = toRow([
    "KPI",
    "Unit",
    `${labels.appA} value`,
    `${labels.appB} value`,
    "Absolute delta",
    "Percentage delta (%)",
    "RAG status",
  ]);

  const rows = result.results.map((r) => {
    const kpi = getKPI(r.kpiId);
    return toRow(deltaRow(r, kpi?.name ?? r.kpiId, kpi?.canonicalUnit ?? ""));
  });

  return [...metadataLines(result.slice), header, ...rows].join("\r\n");
}

/** Order the aggregated per-app values by KPI id so App_A / App_B pair up. */
function pairByKpi(
  values: readonly AggregatedKPIValue[],
): Map<CanonicalKPIId, Partial<Record<AppAssignment, AggregatedKPIValue>>> {
  const byKpi = new Map<CanonicalKPIId, Partial<Record<AppAssignment, AggregatedKPIValue>>>();
  for (const v of values) {
    const existing = byKpi.get(v.kpiId) ?? {};
    existing[v.app] = v;
    byKpi.set(v.kpiId, existing);
  }
  return byKpi;
}

/**
 * Build the Aggregated Summary CSV for the active slice: the aggregated KPI
 * value per app, its unit, and its contributing-record count (Req 18.4). Rows
 * follow the comparison result order so the summary and the delta export line
 * up. No user-identifier column is ever emitted (Req 28.12).
 */
export function buildAggregatedSummaryCSV(
  aggregated: AggregatedResultSet,
  slice: FilterSlice,
  order: readonly ComparisonResult[],
  labels: ExportLabels = DEFAULT_EXPORT_LABELS,
): string {
  const header = toRow([
    "KPI",
    "Unit",
    `${labels.appA} value`,
    `${labels.appA} contributing records`,
    `${labels.appB} value`,
    `${labels.appB} contributing records`,
  ]);

  const byKpi = pairByKpi(aggregated.overall);
  // Preserve the comparison ordering; fall back to registry order for any
  // aggregated KPI not present in the comparison set.
  const kpiIds = order.length > 0 ? order.map((r) => r.kpiId) : [...byKpi.keys()];

  const rows = kpiIds.map((kpiId) => {
    const kpi = getKPI(kpiId);
    const pair = byKpi.get(kpiId) ?? {};
    const a = pair.App_A;
    const b = pair.App_B;
    return toRow([
      kpi?.name ?? kpiId,
      kpi?.canonicalUnit ?? a?.unit ?? b?.unit ?? "",
      a ? formatNumeric(a.value) : "No data",
      a ? String(a.contributingRecords) : "0",
      b ? formatNumeric(b.value) : "No data",
      b ? String(b.contributingRecords) : "0",
    ]);
  });

  return [...metadataLines(slice), header, ...rows].join("\r\n");
}
