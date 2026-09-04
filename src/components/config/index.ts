/**
 * Public entry point for the configuration UI (task 18.1).
 *
 * Re-exports the `SLAConfigPanel` — the SLA & Threshold editor for per-KPI
 * thresholds, the variance band, and the minimum sample size (Req 14, 25.1) —
 * so the dashboard shell can compose it without reaching into file paths.
 */

export { SLAConfigPanel } from "./SLAConfigPanel";
export type { SLAConfigPanelProps } from "./SLAConfigPanel";
