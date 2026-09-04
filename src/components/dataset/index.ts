/**
 * Public entry point for the dataset-management UI (task 18.3).
 *
 * Re-exports the `DatasetSwitcher` — the top-navigation active-dataset selector
 * with rename / create / delete, App_A/App_B label overrides, and retention
 * deletion-candidate confirmation (Req 19, 27.6, 27.7) — so the dashboard shell
 * can compose it without reaching into file paths.
 */

export { DatasetSwitcher } from "./DatasetSwitcher";
export type { DatasetSwitcherProps } from "./DatasetSwitcher";
