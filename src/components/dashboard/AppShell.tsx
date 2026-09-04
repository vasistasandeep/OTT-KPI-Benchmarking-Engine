import * as React from "react";
import { Activity, DatabaseZap, Loader2, PencilLine, SearchX } from "lucide-react";

import { GlobalFilterBar } from "./GlobalFilterBar";
import { ScorecardGrid } from "./ScorecardGrid";
import { WinnerHeatmap } from "./WinnerHeatmap";
import { TimeSeriesOverlay } from "./TimeSeriesOverlay";
import { PercentileDistribution } from "./PercentileDistribution";
import { Button } from "@/components/ui/button";
import { DatasetSwitcher } from "@/components/dataset";
import { ExecutiveReport, ExportMenu } from "@/components/export";
import { UploadDataFlow } from "@/components/ingestion";
import { ManualEntryForm } from "@/components/manual";
import {
  createKPIRepository,
  type KPIDataRepository,
  type RepositoryBootResult,
} from "@/repository";
import {
  hydrate,
  restoreActiveDataset,
  runRecompute,
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
 * Below the header it renders a data toolbar (Upload data, DatasetSwitcher, and
 * a Manual entry toggle) and the sticky {@link GlobalFilterBar} with the
 * {@link ExportMenu} in its trailing slot. The content area then composes the
 * real dashboard modules — {@link ScorecardGrid}, {@link WinnerHeatmap},
 * {@link TimeSeriesOverlay}, {@link PercentileDistribution} — wrapped in the
 * {@link ExecutiveReport} print target. A `children` override replaces the
 * default module composition (used by tests and isolated harnesses).
 *
 * When the active slice matches no records, the shell surfaces a single no-data
 * state in the content area (Req 10.6).
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
   * Optional Export menu rendered into the filter bar's trailing slot. Defaults
   * to the real {@link ExportMenu}; tests inject their own node.
   */
  exportSlot?: React.ReactNode;
  /**
   * The dashboard module content. When omitted the shell renders the default
   * module composition (ScorecardGrid, WinnerHeatmap, TimeSeriesOverlay,
   * PercentileDistribution); passing children replaces it (tests/harnesses).
   */
  children?: React.ReactNode;
}

/** The recompute lifecycle status the shell reflects in the content area. */
type BootPhase = "booting" | "ready" | "error";

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
  // The booted repository, lifted into state so the toolbar (upload, dataset
  // switcher, manual entry) can share the single persistence surface the boot
  // effect created (task: wire dashboard composition).
  const [repository, setRepository] = React.useState<KPIDataRepository | null>(
    null,
  );
  const [manualOpen, setManualOpen] = React.useState(false);

  const noData = useResultStore((s) => s.noData);
  const status = useResultStore((s) => s.status);
  const progressLabel = useResultStore((s) => s.progress?.label ?? null);
  const activeDataset = useDatasetStore((s) => s.activeDataset);
  const appALabel = useDatasetStore((s) => s.appALabel);
  const appBLabel = useDatasetStore((s) => s.appBLabel);
  const setActiveDataset = useDatasetStore((s) => s.setActiveDataset);
  const setDatasets = useDatasetStore((s) => s.setDatasets);
  const datasetName = activeDataset?.name ?? null;

  /**
   * Reload the active dataset (records included) from the repository into the
   * store, refresh the dataset metadata list, then recompute so every module —
   * including ScorecardGrid's sparkline derivation and `applySlice` — sees the
   * new records. Used after an ingest, a manual edit, or a dataset change.
   */
  const reloadAndRecompute = React.useCallback(async () => {
    if (!repository) return;
    const active = await restoreActiveDataset(repository);
    setActiveDataset(active);
    setDatasets(await repository.listDatasets());
    await runRecompute();
  }, [repository, setActiveDataset, setDatasets]);

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
        setRepository(boot.repository);
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

      {/* Data toolbar: upload, dataset switcher, manual entry. Chrome that has
          no place on a printed report is marked data-print-hide (Req 18.5). */}
      {phase === "ready" && repository && (
        <div
          data-print-hide
          className="flex flex-col gap-3 border-b border-border px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-3">
            <UploadDataFlow
              repository={repository}
              appALabel={appALabel}
              appBLabel={appBLabel}
              onIngested={reloadAndRecompute}
            />
            <DatasetSwitcher
              repository={repository}
              onRecompute={reloadAndRecompute}
            />
            <Button
              type="button"
              size="sm"
              variant={manualOpen ? "default" : "outline"}
              aria-expanded={manualOpen}
              aria-controls="manual-entry-section"
              onClick={() => setManualOpen((v) => !v)}
            >
              <PencilLine className="size-3.5" aria-hidden="true" />
              Manual entry
            </Button>
          </div>

          {manualOpen && activeDataset && (
            <section
              id="manual-entry-section"
              aria-label="Manual entry"
              className="rounded-lg border border-border bg-card/40 p-4"
            >
              <ManualEntryForm
                datasetId={activeDataset.id}
                repository={repository}
                appALabel={appALabel}
                appBLabel={appBLabel}
                records={activeDataset.records}
                onRecompute={reloadAndRecompute}
              />
            </section>
          )}
        </div>
      )}

      <GlobalFilterBar exportSlot={exportSlot ?? <ExportMenu />} />

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
            <ExecutiveReport>
              <div
                className="flex flex-col gap-4"
                aria-busy={status === "computing"}
              >
                {children ?? (
                  <>
                    <ScorecardGrid />
                    <WinnerHeatmap />
                    <TimeSeriesOverlay />
                    <PercentileDistribution />
                  </>
                )}
              </div>
            </ExecutiveReport>
          ))}
      </main>
    </div>
  );
}
