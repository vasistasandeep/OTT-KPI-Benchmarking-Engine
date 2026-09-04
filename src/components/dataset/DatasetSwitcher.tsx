import * as React from "react";
import { Check, Database, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Dataset, DatasetMeta } from "@/models";
import { restoreActiveDataset } from "@/stores/recompute";
import { useDatasetStore } from "@/stores/useDatasetStore";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";
import {
  DuplicateNameError,
  type RetentionCheckOutcome,
  type RetentionLimitReached,
} from "@/repository/support";

/**
 * DatasetSwitcher — the top-navigation control for managing stored datasets
 * (design "DatasetSwitcher (Req 19)"; Req 19.1–19.9, 27.6, 27.7).
 *
 * It lists every stored dataset from {@link useDatasetStore} and lets the user:
 *
 *   - **select** the active dataset (Req 19.2), persisting the selection and
 *     loading its records so every dashboard module recomputes against it;
 *   - **rename** a dataset (Req 19.3), rejecting a name that collides with an
 *     existing one (Req 19.7);
 *   - **create** a new empty benchmark run as a new dataset (Req 19.4), likewise
 *     rejecting a duplicate name (Req 19.7);
 *   - **override** the App_A / App_B display labels for the active dataset
 *     (Req 19.5), which the store propagates across scorecards, heatmaps, and
 *     charts because they read `appALabel` / `appBLabel` from the store (Req 19.6);
 *   - **delete** a dataset (Req 19.8, 19.9): deleting the active dataset promotes
 *     another remaining dataset, and deleting the last one falls back to the demo
 *     dataset — both handled by {@link restoreActiveDataset}.
 *
 * Every mutation flows through the injected {@link KPIDataRepository} (the single
 * persistence surface) and then re-reads the metadata list and, when the active
 * selection changed, reloads the active dataset into the store and calls
 * `onRecompute` so the pipeline re-slices and every module re-renders.
 *
 * After any save it also runs the repository's retention check; when a
 * configured ceiling is reached it never prunes silently — it surfaces the
 * oldest datasets as deletion candidates for explicit user confirmation
 * (Req 27.6, 27.7).
 */

/** A fresh, empty pre-aggregated dataset for a new benchmark run (Req 19.4). */
function newEmptyDataset(name: string): Dataset {
  const now = new Date().toISOString();
  // A collision-resistant id independent of the (user-chosen, mutable) name.
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `ds-${now}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    name,
    createdAt: now,
    appALabel: "App A",
    appBLabel: "App B",
    recordCount: 0,
    sourceType: "Aggregated",
    ingestionMode: "Pre_Aggregated",
    records: [],
  };
}

export interface DatasetSwitcherProps {
  repository: KPIDataRepository;
  /**
   * Called after the active dataset changes so the recompute pipeline re-slices
   * and every dashboard module re-renders (design "Recompute pipeline"). May be
   * async. Defaults to a no-op for isolated rendering.
   */
  onRecompute?: () => void | Promise<void>;
}

export function DatasetSwitcher({ repository, onRecompute }: DatasetSwitcherProps) {
  const activeDataset = useDatasetStore((s) => s.activeDataset);
  const datasets = useDatasetStore((s) => s.datasets);
  const appALabel = useDatasetStore((s) => s.appALabel);
  const appBLabel = useDatasetStore((s) => s.appBLabel);
  const setActiveDataset = useDatasetStore((s) => s.setActiveDataset);
  const setDatasets = useDatasetStore((s) => s.setDatasets);

  /** Which modal is open. */
  const [dialog, setDialog] = React.useState<
    | { kind: "rename"; target: DatasetMeta }
    | { kind: "create" }
    | { kind: "labels" }
    | { kind: "delete"; target: DatasetMeta }
    | { kind: "retention"; reached: RetentionLimitReached }
    | null
  >(null);
  const [error, setError] = React.useState<string | null>(null);

  const activeId = activeDataset?.id ?? null;

  /** Re-read the metadata list into the store after any change. */
  const refreshDatasets = React.useCallback(async () => {
    setDatasets(await repository.listDatasets());
  }, [repository, setDatasets]);

  /**
   * Evaluate retention ceilings without pruning; surface the oldest datasets as
   * deletion candidates for user confirmation when a ceiling is reached
   * (Req 27.6, 27.7).
   */
  const checkRetention = React.useCallback(async () => {
    const outcome: RetentionCheckOutcome = await repository.checkRetention(activeId ?? undefined);
    if (outcome.kind === "RetentionLimitReached") {
      setDialog({ kind: "retention", reached: outcome });
    }
  }, [repository, activeId]);

  /** Select and load a dataset as the active one (Req 19.2). */
  async function handleSelect(id: string) {
    if (id === activeId) return;
    const loaded = await repository.getDataset(id);
    if (!loaded) {
      // The list is stale — refresh and bail.
      await refreshDatasets();
      return;
    }
    await repository.setActiveDatasetId(id);
    setActiveDataset(loaded);
    await onRecompute?.();
  }

  /** Rename an existing dataset, rejecting a duplicate name (Req 19.3, 19.7). */
  async function handleRename(target: DatasetMeta, name: string) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Enter a dataset name.");
      return;
    }
    try {
      await repository.renameDataset(target.id, trimmed);
    } catch (cause) {
      if (cause instanceof DuplicateNameError) {
        setError(cause.message);
        return;
      }
      throw cause;
    }
    await refreshDatasets();
    // If the active dataset was renamed, reload it so the store mirrors the name.
    if (target.id === activeId) {
      const reloaded = await repository.getDataset(target.id);
      if (reloaded) setActiveDataset(reloaded);
    }
    closeDialog();
  }

  /** Create a new empty benchmark run and make it active (Req 19.4, 19.7). */
  async function handleCreate(name: string) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Enter a dataset name.");
      return;
    }
    const dataset = newEmptyDataset(trimmed);
    try {
      // saveDataset rejects a duplicate name up front (Req 19.7).
      await repository.saveDataset(dataset);
    } catch (cause) {
      if (cause instanceof DuplicateNameError) {
        setError(cause.message);
        return;
      }
      throw cause;
    }
    await repository.setActiveDatasetId(dataset.id);
    setActiveDataset(dataset);
    await refreshDatasets();
    closeDialog();
    await onRecompute?.();
    await checkRetention();
  }

  /**
   * Override the App_A / App_B display labels for the active dataset (Req 19.5).
   * Persisting them and reloading the active dataset lets the store propagate
   * the new labels across every scorecard, heatmap, and chart (Req 19.6).
   */
  async function handleSaveLabels(nextAppA: string, nextAppB: string) {
    if (!activeDataset) return;
    const a = nextAppA.trim() || "App A";
    const b = nextAppB.trim() || "App B";
    const updated: Dataset = { ...activeDataset, appALabel: a, appBLabel: b };
    await repository.saveDataset(updated);
    setActiveDataset(updated);
    await refreshDatasets();
    closeDialog();
    await onRecompute?.();
  }

  /**
   * Delete a dataset. Deleting the active dataset promotes another remaining
   * dataset; deleting the last one falls back to the demo dataset — both via
   * {@link restoreActiveDataset} (Req 19.8, 19.9).
   */
  async function handleDelete(target: DatasetMeta) {
    const wasActive = target.id === activeId;
    await repository.deleteDataset(target.id);
    if (wasActive) {
      // Promote another remaining dataset, or seed the demo fallback (19.8/19.9).
      const promoted = await restoreActiveDataset(repository);
      setActiveDataset(promoted);
      await refreshDatasets();
      closeDialog();
      await onRecompute?.();
    } else {
      await refreshDatasets();
      closeDialog();
    }
  }

  /**
   * Confirm deletion of a retention deletion-candidate (Req 27.7). The candidate
   * carries only `id`/`name`/`createdAt`, so delete by id directly (it may be an
   * older stored dataset not currently loaded into the switcher list).
   */
  async function handleRetentionDelete(candidate: { id: string; name: string }) {
    const meta: DatasetMeta =
      datasets.find((d) => d.id === candidate.id) ??
      ({
        id: candidate.id,
        name: candidate.name,
        recordCount: 0,
      } as DatasetMeta);
    await handleDelete(meta);
  }

  function closeDialog() {
    setDialog(null);
    setError(null);
  }

  return (
    <div className="flex items-center gap-2">
      <Database aria-hidden className="text-muted-foreground" />
      <label className="sr-only" htmlFor="dataset-switcher-select">
        Active dataset
      </label>
      <select
        id="dataset-switcher-select"
        aria-label="Active dataset"
        value={activeId ?? ""}
        onChange={(e) => void handleSelect(e.target.value)}
        className="h-9 max-w-[16rem] rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {datasets.length === 0 && <option value="">No datasets</option>}
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          const target = datasets.find((d) => d.id === activeId);
          if (target) setDialog({ kind: "rename", target });
        }}
        disabled={!activeId}
        aria-label="Rename active dataset"
      >
        <Pencil aria-hidden /> Rename
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          setDialog({ kind: "create" });
        }}
        aria-label="Create new dataset"
      >
        <Plus aria-hidden /> New
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          setDialog({ kind: "labels" });
        }}
        disabled={!activeDataset}
        aria-label="Edit App A and App B labels"
      >
        <Check aria-hidden /> Labels
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          const target = datasets.find((d) => d.id === activeId);
          if (target) setDialog({ kind: "delete", target });
        }}
        disabled={!activeId}
        aria-label="Delete active dataset"
      >
        <Trash2 aria-hidden /> Delete
      </Button>

      {dialog?.kind === "rename" && (
        <NameDialog
          title="Rename dataset"
          confirmLabel="Rename"
          initialName={dialog.target.name}
          error={error}
          onCancel={closeDialog}
          onConfirm={(name) => void handleRename(dialog.target, name)}
        />
      )}

      {dialog?.kind === "create" && (
        <NameDialog
          title="New benchmark run"
          description="Create a new, empty dataset. Ingest a file or add manual entries afterward."
          confirmLabel="Create"
          initialName=""
          error={error}
          onCancel={closeDialog}
          onConfirm={(name) => void handleCreate(name)}
        />
      )}

      {dialog?.kind === "labels" && (
        <LabelsDialog
          initialAppA={appALabel}
          initialAppB={appBLabel}
          onCancel={closeDialog}
          onConfirm={(a, b) => void handleSaveLabels(a, b)}
        />
      )}

      {dialog?.kind === "delete" && (
        <DeleteDatasetDialog
          target={dialog.target}
          isActive={dialog.target.id === activeId}
          isLast={datasets.length <= 1}
          onCancel={closeDialog}
          onConfirm={() => void handleDelete(dialog.target)}
        />
      )}

      {dialog?.kind === "retention" && (
        <RetentionDialog
          reached={dialog.reached}
          onClose={closeDialog}
          onDelete={(candidate) => void handleRetentionDelete(candidate)}
        />
      )}
    </div>
  );
}

/** A single-field name dialog reused for rename and create (Req 19.3, 19.4, 19.7). */
function NameDialog({
  title,
  description,
  confirmLabel,
  initialName,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  initialName: string;
  error: string | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const headingId = React.useId();
  const descId = React.useId();
  const [name, setName] = React.useState(initialName);

  return (
    <Dialog
      open
      onClose={onCancel}
      labelledBy={headingId}
      describedBy={description ? descId : undefined}
      className="max-w-md"
    >
      <DialogHeader>
        <h2 id={headingId} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-4" />
        </button>
      </DialogHeader>
      <DialogBody>
        {description && (
          <p id={descId} className="mb-3 text-sm text-muted-foreground">
            {description}
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Dataset name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConfirm(name);
            }}
            aria-label="Dataset name"
            aria-invalid={error !== null}
            className={cn(
              "h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              error && "border-destructive",
            )}
          />
        </label>
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onConfirm(name)}>{confirmLabel}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Editor for the active dataset's App_A / App_B display labels (Req 19.5, 19.6). */
function LabelsDialog({
  initialAppA,
  initialAppB,
  onCancel,
  onConfirm,
}: {
  initialAppA: string;
  initialAppB: string;
  onCancel: () => void;
  onConfirm: (appA: string, appB: string) => void;
}) {
  const headingId = React.useId();
  const [appA, setAppA] = React.useState(initialAppA);
  const [appB, setAppB] = React.useState(initialAppB);

  return (
    <Dialog open onClose={onCancel} labelledBy={headingId} className="max-w-md">
      <DialogHeader>
        <h2 id={headingId} className="text-base font-semibold tracking-tight">
          App labels
        </h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-4" />
        </button>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <p className="text-sm text-muted-foreground">
          These labels replace the generic App A / App B names across every
          scorecard, heatmap, and chart.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">App A label</span>
          <input
            autoFocus
            value={appA}
            onChange={(e) => setAppA(e.target.value)}
            aria-label="App A label"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">App B label</span>
          <input
            value={appB}
            onChange={(e) => setAppB(e.target.value)}
            aria-label="App B label"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onConfirm(appA, appB)}>Save labels</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Confirmation dialog for deleting a dataset (Req 19.8, 19.9). */
function DeleteDatasetDialog({
  target,
  isActive,
  isLast,
  onCancel,
  onConfirm,
}: {
  target: DatasetMeta;
  isActive: boolean;
  isLast: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const headingId = React.useId();
  const descId = React.useId();
  return (
    <Dialog
      open
      onClose={onCancel}
      labelledBy={headingId}
      describedBy={descId}
      className="max-w-md"
    >
      <DialogHeader>
        <h2 id={headingId} className="text-base font-semibold tracking-tight">
          Delete dataset?
        </h2>
      </DialogHeader>
      <DialogBody>
        <p id={descId} className="text-sm text-muted-foreground">
          This permanently removes “{target.name}” and its {target.recordCount}{" "}
          records.{" "}
          {isActive && isLast
            ? "It is the only dataset, so the demo dataset will be restored as the active dataset."
            : isActive
              ? "It is the active dataset, so another dataset will be promoted to active."
              : ""}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete dataset
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Retention dialog: presents the oldest stored datasets as deletion candidates
 * when a configured ceiling is reached, deleting only after the user confirms
 * each one (Req 27.6, 27.7).
 */
function RetentionDialog({
  reached,
  onClose,
  onDelete,
}: {
  reached: RetentionLimitReached;
  onClose: () => void;
  onDelete: (candidate: { id: string; name: string; createdAt: string }) => void;
}) {
  const headingId = React.useId();
  const descId = React.useId();
  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={headingId}
      describedBy={descId}
      className="max-w-lg"
    >
      <DialogHeader>
        <h2 id={headingId} className="text-base font-semibold tracking-tight">
          Storage retention limit reached
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-4" />
        </button>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <p id={descId} className="text-sm text-muted-foreground">
          {reached.message}
        </p>
        {reached.deletionCandidates.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {reached.deletionCandidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 text-sm">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    created {c.createdAt.slice(0, 10)}
                  </span>
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => onDelete(c)}
                  aria-label={`Delete ${c.name} to free storage`}
                >
                  <Trash2 aria-hidden /> Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No deletion candidates are available for this limit.
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Keep all datasets
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
