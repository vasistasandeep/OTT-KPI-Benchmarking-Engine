import * as React from "react";
import { Activity, DatabaseZap, Loader2, SearchX } from "lucide-react";

import { GlobalFilterBar } from "./GlobalFilterBar";
import { WinnerHeatmap } from "./WinnerHeatmap";
import { createKPIRepository, type RepositoryBootResult } from "@/repository";
import {
  hydrate,
  useDatasetStore,
  useResultStore,
  type RecomputeHandle,
} from "@/stores";

/**
 * AppShell — the top-level dashboard layout (design "Dashboard shell", task 16.1).
 *
 * It composes the sticky {@link GlobalFilterBar} above a scrolling content area
 * and owns the app's boot lifecycle: on mount it boots the repository
 * (`createKPIRepository`) and calls {@link hydrate}, which restores the active
 * dataset + SLA config, wires filter-change → recompute, and runs the first
 * recompute (Req 3.3, 10.5). The returned {@link RecomputeHandle} is disposed on
 * unmount so the filter subscription and any pending recompute are torn down.
 *
 * The content area is intentionally a set of clearly-marked slots. The real
 * dashboard modules (scorecards, winner heatmap, trend charts, breakdown
 * tables) are built in tasks 17.x and dropped into these slots later; this task
 * only proves the shell composes, hydrates, and reflects the store state.
 *
 * When the active slice matches no records, the shell surfaces a single no-data
 * state in the content area (Req 10.6); once modules exist, each renders its own
 * no-data state and this shell-level one is replaced.
 *
 * All colors resolve against the dark-theme token layer in `index.css`; nothing
 * here hard-codes a color (Req 15.1).
 */

export interface AppShellProps {
  /**
   * Test/host seam for booting the repository. Defaults to the real
   * `createKPIRepository`; tests inject an in-memory or forced result so the
   * shell hydrates deterministically without touching IndexedDB.
   */
  bootRepository?: () => Promise<RepositoryBootResult>;
  /**
   * Optional Export menu rendered into the filter bar's trailing slot. Wired by
   * task 18.x; omitted here.
   */
  exportSlot?: React.ReactNode;
  /**
   * The dashboard module content. Later tasks (17.x) pass the composed modules;
   * when omitted the shell renders labelled placeholder slots so the layout is
   * verifiable in isolation.
   */
  children?: React.ReactNode;
}

/** The recompute lifecycle status the shell reflects in the content area. */
type BootPhase = "booting" | "ready" | "error";

/** A labelled placeholder for a module built in a later task (17.x). */
function ModuleSlot({ title, note }: { title: string; note: string }) {
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-dashed border-border bg-card/40 p-6"
    >
      <h2 className="text-sm font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </section>
  );
}

/** The shell-level no-data state shown when the slice matches nothing (Req 10.6). */
function NoDataState() {
  return (
    <div
      data-testid="dashboard-no-data"
      className="flex flex-col items-center justify-center rounded-lg border border-border bg-card/40 py-16 text-center"
    >
      <SearchX className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium text-foreground">
        No data for the current filters
      </p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        No records match the active slice. Widen the date range, clear a
        dimension selection, or enable both apps to see results.
      </p>
    </div>
  );
}

export function AppShell({
  bootRepository = createKPIRepository,
  exportSlot,
  children,
}: AppShellProps) {
  const [phase, setPhase] = React.useState<BootPhase>("booting");
  const [advisory, setAdvisory] = React.useState<string | undefined>(undefined);
  const [bootError, setBootError] = React.useState<string | null>(null);

  const noData = useResultStore((s) => s.noData);
  const status = useResultStore((s) => s.status);
  const progressLabel = useResultStore((s) => s.progress?.label ?? null);
  const datasetName = useDatasetStore((s) => s.activeDataset?.name ?? null);

  // A single polite live region announcing the recompute lifecycle so screen
  // readers hear when results are being recomputed, updated, or failed without
  // relying on the visual busy affordance (Req 28.8). Kept text-only and
  // visually hidden; the message tracks the store's status/progress.
  const recomputeAnnouncement = React.useMemo(() => {
    switch (status) {
      case "computing":
        return progressLabel ? `Recomputing… ${progressLabel}` : "Recomputing…";
      case "ready":
        return "Results updated";
      case "error":
        return "Recompute failed";
      default:
        return "";
    }
  }, [status, progressLabel]);

  // Boot the repository and wire the recompute pipeline once, on mount (Req 3.3).
  React.useEffect(() => {
    let disposed = false;
    let handle: RecomputeHandle | null = null;

    (async () => {
      try {
        const boot = await bootRepository();
        if (disposed) return;
        setAdvisory(boot.advisory);
        handle = await hydrate(boot.repository);
        if (disposed) {
          handle.dispose();
          return;
        }
        setPhase("ready");
      } catch (cause) {
        if (disposed) return;
        setBootError(
          cause instanceof Error ? cause.message : "Failed to start the dashboard.",
        );
        setPhase("error");
      }
    })();

    return () => {
      disposed = true;
      handle?.dispose();
    };
  }, [bootRepository]);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Global recompute lifecycle announcer, polite + visually hidden (Req 28.8). */}
      <div
        aria-live="polite"
        aria-atomic="true"
        role="status"
        className="sr-only"
        data-testid="recompute-live-region"
      >
        {recomputeAnnouncement}
      </div>

      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Activity className="text-primary" aria-hidden="true" />
            <h1 className="text-base font-semibold tracking-tight">
              OTT KPI Benchmarking Engine
            </h1>
          </div>
          {datasetName && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <DatabaseZap className="size-3.5" aria-hidden="true" />
              {datasetName}
            </span>
          )}
        </div>
      </header>

      {/* Incognito / non-persistent storage advisory banner. */}
      {advisory && (
        <div
          role="status"
          className="border-b border-rag-amber/40 bg-rag-amber/10 px-4 py-2 text-xs text-foreground"
        >
          {advisory}
        </div>
      )}

      <GlobalFilterBar exportSlot={exportSlot} />

      <main className="flex-1 px-4 py-4">
        {phase === "booting" && (
          <div
            data-testid="dashboard-loading"
            className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading dashboard…
          </div>
        )}

        {phase === "error" && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-sm text-foreground"
          >
            {bootError}
          </div>
        )}

        {phase === "ready" &&
          (noData ? (
            <NoDataState />
          ) : (
            <div className="flex flex-col gap-4" aria-busy={status === "computing"}>
              {children ?? (
                <>
                  <ModuleSlot
                    title="KPI Scorecards"
                    note="Per-pillar scorecards with delta and RAG badging arrive in task 17.x."
                  />
                  <WinnerHeatmap />
                  <ModuleSlot
                    title="Trend Charts & Breakdown Tables"
                    note="Trend charts and virtualized breakdown tables arrive in task 17.x."
                  />
                </>
              )}
            </div>
          ))}
      </main>
    </div>
  );
}
