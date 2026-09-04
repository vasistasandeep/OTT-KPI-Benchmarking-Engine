/**
 * Public entry point for the export module (Req 18).
 *
 * Re-exports the Export menu on the filter bar and the Executive Report print
 * wrapper, alongside the pure CSV builders and browser side-effect helpers so
 * consumers and tests can import from one place.
 */

export { ExportMenu } from "./ExportMenu";
export type { ExportMenuProps } from "./ExportMenu";
export { ExecutiveReport } from "./ExecutiveReport";
export type { ExecutiveReportProps } from "./ExecutiveReport";

export {
  buildDeltaCSV,
  buildAggregatedSummaryCSV,
  hasExportableData,
  escapeCSVField,
  NO_EXPORT_DATA_MESSAGE,
  DEFAULT_EXPORT_LABELS,
} from "@/lib/export/csv";
export type { ExportLabels } from "@/lib/export/csv";

export {
  triggerDownload,
  printExecutiveReport,
  ensurePrintStyles,
  PRINT_CSS,
  PRINT_STYLE_ID,
  PRINTING_CLASS,
} from "@/lib/export/download";
