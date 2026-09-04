import { AppShell, ScorecardGrid } from "@/components/dashboard";

/**
 * Application root.
 *
 * Renders the dashboard {@link AppShell}, which composes the sticky Global
 * Filter bar over the content area and boots the recompute pipeline
 * (`createKPIRepository` → `hydrate`) on mount. The comparison modules are
 * dropped into the shell's content slot: the {@link ScorecardGrid} (task 17.1)
 * is wired here; the winner heatmap, trend overlay, and percentile distribution
 * (tasks 17.2–17.4) join it as they are completed.
 */
export default function App() {
  return (
    <AppShell>
      <ScorecardGrid />
    </AppShell>
  );
}
