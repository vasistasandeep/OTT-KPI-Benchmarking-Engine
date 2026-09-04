import { AppShell } from "@/components/dashboard";

/**
 * Application root.
 *
 * Renders the dashboard {@link AppShell}, which composes the data toolbar
 * (upload, dataset switcher, manual entry) and the sticky Global Filter bar over
 * the content area, boots the recompute pipeline (`createKPIRepository` →
 * `hydrate`) on mount, and renders the comparison modules — the ScorecardGrid,
 * WinnerHeatmap, TimeSeriesOverlay, and PercentileDistribution — wrapped in the
 * ExecutiveReport print target. No children are passed, so the shell's default
 * module composition is used.
 */
export default function App() {
  return <AppShell />;
}
