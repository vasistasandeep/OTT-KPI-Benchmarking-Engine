/**
 * Public entry point for the manual-entry UI (task 13.1).
 *
 * Re-exports the `ManualEntryForm` — the dual-entry table with its edit/delete
 * lifecycle (Req 8, 27.8–27.11) — so the dashboard shell can compose it without
 * reaching into file paths.
 */

export { ManualEntryForm } from "./ManualEntryForm";
export type { ManualEntryFormProps } from "./ManualEntryForm";
