/**
 * Public entry point for the dashboard shell (task 16.1).
 *
 * Re-exports the app shell and the global filter bar so the app root can
 * compose the dashboard without reaching into file paths. The dashboard
 * modules (scorecards, heatmap, charts, tables) are added in tasks 17.x and
 * dropped into the shell's content slot.
 */

export { AppShell, type AppShellProps } from "./AppShell";
export {
  GlobalFilterBar,
  type GlobalFilterBarProps,
} from "./GlobalFilterBar";
export { ScorecardGrid, type ScorecardGridProps } from "./ScorecardGrid";
export { Sparkline, type SparklineProps } from "./Sparkline";
export {
  buildScorecardSeries,
  SPARKLINE_DAYS,
  type KpiSeries,
  type SeriesPoint,
} from "./scorecard-series";
export {
  PercentileDistribution,
  type PercentileDistributionProps,
} from "./PercentileDistribution";
export {
  derivePercentileDistribution,
  hasNotAggregableCell,
  PERCENTILE_METRICS,
  PERCENTILE_RANKS,
  type PercentileDistributionData,
  type PercentileMetric,
  type PercentileMetricSeries,
} from "./percentile-data";
export { WinnerHeatmap, type WinnerHeatmapProps } from "./WinnerHeatmap";
export {
  buildHeatmapMatrix,
  parseSegmentKey,
  type HeatmapMatrix,
  type HeatmapRow,
  type HeatmapCell,
} from "./winner-heatmap-model";
export {
  TimeSeriesOverlay,
  type TimeSeriesOverlayProps,
} from "./TimeSeriesOverlay";
