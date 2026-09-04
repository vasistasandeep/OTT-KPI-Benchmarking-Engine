/**
 * Public entry point for the ingestion UI modals (task 12.1).
 *
 * Re-exports the two modals that make up the file-ingestion flow — the
 * `IngestionModePrompt` (mode + file-level app assignment, Req 6.5, 21.5) and
 * the `ColumnMappingModal` (per-column mapping, units, layout, Req 7.x, 22.4) —
 * so the dashboard shell can compose them without reaching into file paths.
 */

export { IngestionModePrompt } from "./IngestionModePrompt";
export type { IngestionModePromptProps } from "./IngestionModePrompt";

export { ColumnMappingModal } from "./ColumnMappingModal";
export type { ColumnMappingModalProps } from "./ColumnMappingModal";

export { UploadDataFlow } from "./UploadDataFlow";
export type { UploadDataFlowProps } from "./UploadDataFlow";
