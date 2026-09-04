import * as React from "react";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AppAssignment, CanonicalKPIId, DimensionId, KPIRecord } from "@/models";
import { KPI_REGISTRY, getKPI } from "@/registry";
import { DIMENSION_REGISTRY } from "@/registry/dimensions";
import {
  applyManualEdit,
  buildManualRecords,
  draftFromRecord,
  isEditable,
  validateManualEntry,
  type FieldError,
  type ManualEntryCell,
  type ManualEntryDraft,
} from "@/ingestion/manual-entry";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";

/**
 * ManualEntryForm — the dual-entry table and its edit/delete lifecycle
 * (design "Manual entry (Req 8)"; Req 8.1, 8.2, 8.3, 27.8, 27.9, 27.10, 27.11).
 *
 * A user types a value per KPI for App_A and App_B against a chosen date and
 * dimension selection (Req 8.1). Per-field numeric validation flags any
 * non-numeric cell and excludes only that field from submission; the rest of
 * the row is still submitted (Req 8.3). Submitting builds `origin: "manual"`,
 * pre-aggregated records — values normalized to each KPI's canonical unit and
 * the date normalized to UTC — and appends them through the repository (Req 8.2).
 *
 * Submitted manual rows are listed with their date, app, dimensions, and KPI
 * values; each offers **edit** and **delete** (Req 27.8). Edit reopens the row
 * in the same validated form and, on save, re-normalizes and writes back via
 * `updateRecord` preserving the record `id` (Req 27.8). Delete removes the row
 * via `deleteRecord` behind a confirmation dialog (Req 27.10). Only records with
 * `origin: "manual"` are editable or deletable; file-ingested and mock-seeded
 * rows render read-only (Req 27.9). Every submit, edit, and delete calls back
 * into `onRecompute` so the active slice recomputes and every dashboard module
 * re-renders (Req 27.11).
 */

/** An empty cell for a KPI, entered in its canonical unit by default. */
function emptyCell(kpiId: CanonicalKPIId): ManualEntryCell {
  const kpi = getKPI(kpiId);
  return { kpiId, appAValue: "", appBValue: "", unit: kpi?.canonicalUnit };
}

/** A fresh, empty draft with the given KPIs and no dimension selections. */
function emptyDraft(kpiIds: CanonicalKPIId[]): ManualEntryDraft {
  return {
    date: new Date().toISOString().slice(0, 10),
    dimensions: {},
    cells: kpiIds.map(emptyCell),
  };
}

/** Whether a specific KPI/app field is flagged invalid (Req 8.3). */
function hasFieldError(errors: FieldError[], kpiId: CanonicalKPIId, app: AppAssignment): boolean {
  return errors.some((e) => e.kpiId === kpiId && e.app === app);
}

export interface ManualEntryFormProps {
  /** The dataset manual records are written to. */
  datasetId: string;
  repository: KPIDataRepository;
  /** App_A display label (Req 19.5). */
  appALabel?: string;
  /** App_B display label (Req 19.5). */
  appBLabel?: string;
  /** Existing records in the active dataset; only manual rows are editable (Req 27.9). */
  records: readonly KPIRecord[];
  /**
   * Called after any submit / edit / delete so the active slice recomputes and
   * every dashboard module re-renders (Req 27.11). May be async.
   */
  onRecompute: () => void | Promise<void>;
  /** The KPIs offered in the entry table; defaults to every registered KPI. */
  kpiIds?: CanonicalKPIId[];
}

export function ManualEntryForm({
  datasetId,
  repository,
  appALabel = "App A",
  appBLabel = "App B",
  records,
  onRecompute,
  kpiIds,
}: ManualEntryFormProps) {
  const offeredKpis = React.useMemo<CanonicalKPIId[]>(
    () => kpiIds ?? KPI_REGISTRY.map((k) => k.id),
    [kpiIds],
  );

  const [draft, setDraft] = React.useState<ManualEntryDraft>(() => emptyDraft(offeredKpis));
  const [submitted, setSubmitted] = React.useState(false);
  /** The record currently being edited (its id), or null for a new entry. */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  /** The record queued for deletion behind the confirmation dialog (Req 27.10). */
  const [pendingDelete, setPendingDelete] = React.useState<KPIRecord | null>(null);
  /** A read-only-attempt notice when a non-manual row's controls are used (Req 27.9). */
  const [readOnlyNotice, setReadOnlyNotice] = React.useState<string | null>(null);

  const validation = React.useMemo(() => validateManualEntry(draft), [draft]);

  const manualRecords = React.useMemo(
    () => records.filter((r) => isEditable(r)),
    [records],
  );

  function setCellValue(kpiId: CanonicalKPIId, app: AppAssignment, value: string) {
    setDraft((prev) => ({
      ...prev,
      cells: prev.cells.map((c) =>
        c.kpiId === kpiId
          ? app === "App_A"
            ? { ...c, appAValue: value }
            : { ...c, appBValue: value }
          : c,
      ),
    }));
  }

  function setDimension(dimId: DimensionId, member: string) {
    setDraft((prev) => ({
      ...prev,
      dimensions: { ...prev.dimensions, [dimId]: member },
    }));
  }

  function setDate(date: string) {
    setDraft((prev) => ({ ...prev, date }));
  }

  function resetForm() {
    setDraft(emptyDraft(offeredKpis));
    setEditingId(null);
    setSubmitted(false);
  }

  async function handleSubmit() {
    setSubmitted(true);
    if (!validation.valid) return;

    if (editingId) {
      // Edit: re-normalize and write back preserving the record id (Req 27.8).
      const original = records.find((r) => r.id === editingId);
      if (!original) {
        setEditingId(null);
        return;
      }
      if (!isEditable(original)) {
        // Guard: a non-manual row can never be edited (Req 27.9).
        setReadOnlyNotice("Only manually entered records can be modified.");
        return;
      }
      const updated = applyManualEdit(original, draft);
      if (!updated) return;
      await repository.updateRecord(datasetId, updated);
    } else {
      // New submission: build one manual record per app that carried a value.
      const { records: built } = buildManualRecords(draft, { datasetId });
      if (built.length === 0) return;
      await repository.appendRecords(datasetId, built);
    }

    await onRecompute();
    resetForm();
  }

  /** Reopen a manual row in the validated form for editing (Req 27.8, 27.9). */
  function handleEdit(record: KPIRecord) {
    if (!isEditable(record)) {
      setReadOnlyNotice("Only manually entered records can be modified.");
      return;
    }
    setReadOnlyNotice(null);
    setEditingId(record.id);
    setSubmitted(false);
    // Merge the record's stored values into a full draft over every offered KPI
    // so the form shows every field, pre-filled where the record has a value.
    const recordDraft = draftFromRecord(record);
    const byKpi = new Map(recordDraft.cells.map((c) => [c.kpiId, c]));
    setDraft({
      date: recordDraft.date,
      dimensions: recordDraft.dimensions,
      cells: offeredKpis.map((id) => byKpi.get(id) ?? emptyCell(id)),
    });
  }

  /** Request deletion of a manual row; opens the confirmation dialog (Req 27.10). */
  function handleDeleteRequest(record: KPIRecord) {
    if (!isEditable(record)) {
      setReadOnlyNotice("Only manually entered records can be modified.");
      return;
    }
    setReadOnlyNotice(null);
    setPendingDelete(record);
  }

  /** Confirm the queued deletion: remove via deleteRecord and recompute (Req 27.10, 27.11). */
  async function handleDeleteConfirm() {
    const record = pendingDelete;
    if (!record) return;
    setPendingDelete(null);
    if (!isEditable(record)) return;
    await repository.deleteRecord(datasetId, record.id);
    if (editingId === record.id) resetForm();
    await onRecompute();
  }

  const dateInvalid = submitted && validation.dateError !== undefined;

  return (
    <section aria-labelledby="manual-entry-heading" className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 id="manual-entry-heading" className="text-base font-semibold tracking-tight">
            {editingId ? "Edit manual entry" : "Manual entry"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Type {appALabel} and {appBLabel} values directly for a date and
            dimension selection.
          </p>
        </div>
        {editingId && (
          <Button variant="ghost" size="sm" onClick={resetForm}>
            Cancel edit
          </Button>
        )}
      </header>

      {readOnlyNotice && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle aria-hidden className="!size-3.5" />
          {readOnlyNotice}
        </p>
      )}

      {/* Shared date + dimension selectors (Req 8.1) */}
      <div className="flex flex-wrap items-end gap-4 rounded-md border border-border bg-muted/30 p-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Date</span>
          <input
            type="date"
            value={draft.date}
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={dateInvalid}
            aria-label="Entry date"
            className={cn(
              "h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              dateInvalid && "border-destructive",
            )}
          />
          {dateInvalid && (
            <span className="text-[11px] text-destructive">{validation.dateError}</span>
          )}
        </label>
        {DIMENSION_REGISTRY.map((dim) => (
          <label key={dim.id} className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{dim.name}</span>
            <select
              value={draft.dimensions[dim.id] ?? ""}
              onChange={(e) => setDimension(dim.id, e.target.value)}
              aria-label={dim.name}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">— any —</option>
              {dim.members.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {/* Dual-entry table (Req 8.1, 8.3) */}
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">KPI</th>
              <th scope="col" className="px-3 py-2 font-medium">Unit</th>
              <th scope="col" className="px-3 py-2 font-medium">{appALabel}</th>
              <th scope="col" className="px-3 py-2 font-medium">{appBLabel}</th>
            </tr>
          </thead>
          <tbody>
            {draft.cells.map((cell) => {
              const kpi = getKPI(cell.kpiId);
              const aInvalid = submitted && hasFieldError(validation.fieldErrors, cell.kpiId, "App_A");
              const bInvalid = submitted && hasFieldError(validation.fieldErrors, cell.kpiId, "App_B");
              const aId = `manual-${cell.kpiId}-a`;
              const bId = `manual-${cell.kpiId}-b`;
              return (
                <tr key={cell.kpiId} className="border-t border-border">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {kpi?.name ?? cell.kpiId}
                  </th>
                  <td className="px-3 py-2 text-muted-foreground">
                    {cell.unit ?? kpi?.canonicalUnit}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      id={aId}
                      inputMode="decimal"
                      value={cell.appAValue}
                      onChange={(e) => setCellValue(cell.kpiId, "App_A", e.target.value)}
                      aria-label={`${kpi?.name ?? cell.kpiId} for ${appALabel}`}
                      aria-invalid={aInvalid}
                      className={cn(
                        "h-8 w-28 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        aInvalid && "border-destructive bg-destructive/10",
                      )}
                    />
                    {aInvalid && (
                      <span className="mt-0.5 block text-[11px] text-destructive">
                        not a number
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      id={bId}
                      inputMode="decimal"
                      value={cell.appBValue}
                      onChange={(e) => setCellValue(cell.kpiId, "App_B", e.target.value)}
                      aria-label={`${kpi?.name ?? cell.kpiId} for ${appBLabel}`}
                      aria-invalid={bInvalid}
                      className={cn(
                        "h-8 w-28 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        bInvalid && "border-destructive bg-destructive/10",
                      )}
                    />
                    {bInvalid && (
                      <span className="mt-0.5 block text-[11px] text-destructive">
                        not a number
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {submitted && validation.empty && validation.dateError === undefined && (
        <p role="alert" className="text-xs text-destructive">
          Enter at least one value before submitting.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={handleSubmit}>
          {editingId ? "Save changes" : (
            <>
              <Plus aria-hidden /> Submit entries
            </>
          )}
        </Button>
      </div>

      {/* Submitted manual rows with edit / delete (Req 27.8, 27.9) */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Manual records</h3>
        {manualRecords.length === 0 ? (
          <p className="text-xs text-muted-foreground">No manual records yet.</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2 font-medium">App</th>
                  <th scope="col" className="px-3 py-2 font-medium">Dimensions</th>
                  <th scope="col" className="px-3 py-2 font-medium">Values</th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {manualRecords.map((record) => {
                  const dims = Object.entries(record.dimensions)
                    .map(([, v]) => v)
                    .join(", ");
                  const values = Object.entries(record.metrics ?? {})
                    .map(([kpiId, v]) => `${getKPI(kpiId as CanonicalKPIId)?.name ?? kpiId}: ${v}`)
                    .join("; ");
                  return (
                    <tr key={record.id} className="border-t border-border align-top">
                      <td className="px-3 py-2">{record.bucket.dayUtc}</td>
                      <td className="px-3 py-2">
                        {record.app === "App_A" ? appALabel : appBLabel}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{dims || "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{values || "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(record)}
                            aria-label={`Edit manual record from ${record.bucket.dayUtc}`}
                          >
                            <Pencil aria-hidden /> Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteRequest(record)}
                            aria-label={`Delete manual record from ${record.bucket.dayUtc}`}
                          >
                            <Trash2 aria-hidden /> Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete confirmation dialog (Req 27.10) */}
      <DeleteConfirmDialog
        record={pendingDelete}
        appLabel={pendingDelete?.app === "App_A" ? appALabel : appBLabel}
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDeleteConfirm}
      />
    </section>
  );
}

/** The confirmation dialog gating a manual-record deletion (Req 27.10). */
function DeleteConfirmDialog({
  record,
  appLabel,
  onCancel,
  onConfirm,
}: {
  record: KPIRecord | null;
  appLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const headingId = React.useId();
  const descId = React.useId();
  return (
    <Dialog
      open={record !== null}
      onClose={onCancel}
      labelledBy={headingId}
      describedBy={descId}
      className="max-w-md"
    >
      <DialogHeader>
        <h2 id={headingId} className="text-base font-semibold tracking-tight">
          Delete manual record?
        </h2>
      </DialogHeader>
      <DialogBody>
        <p id={descId} className="text-sm text-muted-foreground">
          This will permanently remove the {appLabel} record
          {record ? ` from ${record.bucket.dayUtc}` : ""}. A manually entered
          record is not recoverable from any source file.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete record
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
