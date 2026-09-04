import * as React from "react";
import { AlertTriangle, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AppAssignment, CanonicalKPIId, MappingTarget, SourceLayout } from "@/models";
import { KPI_REGISTRY, getKPI } from "@/registry";
import { DIMENSION_REGISTRY } from "@/registry/dimensions";
import {
  resolveColumnUnit,
  requiresFileLevelApp,
  type ColumnDraft,
  type MappingDraft,
} from "@/ingestion/ingestion-flow";
import { validateMapping, type MappingValidationResult } from "@/ingestion/mapping-validator";

/**
 * ColumnMappingModal — the guided column-mapping screen (Req 7.1–7.9, 21.3,
 * 22.4, 26.2, 28.13; design "Column Mapping modal").
 *
 * For each source column it shows up to five non-empty sample values beside a
 * searchable selector that lists every Canonical KPI and Dimension (plus the
 * structural targets: app column, timestamp, volume weight, user id). The
 * fuzzy-proposed target is pre-selected and its match score shown; a column that
 * did not reach the auto-map threshold is marked as needing selection (Req 7.3).
 *
 * When a column maps to a KPI, a per-column unit selector lists that KPI's
 * accepted units with the inferred unit preselected (Req 22.4); an assumed unit
 * is flagged. Timestamp columns whose sample values carry no UTC offset show a
 * naive-timestamp note (Req 26.2). A layout toggle exposes the detected default
 * (Req 21.3), and — when a user id column is mapped — a hashing toggle offers to
 * pseudonymize identifiers at ingestion (Req 28.13).
 *
 * Confirmation runs `validateMapping` (Req 7.8, 7.9) and only calls `onConfirm`
 * when the mapping is valid; blocking findings are shown inline and the
 * offending columns are highlighted.
 */

/** A selectable mapping option in the per-column selector. */
interface TargetOption {
  /** Stable value used as the option key and to reconstruct the target. */
  value: string;
  label: string;
  group: string;
  build: () => MappingTarget;
}

/** Structural (non-KPI, non-dimension) targets a column can take. */
const STRUCTURAL_OPTIONS: TargetOption[] = [
  { value: "unmapped", label: "— Not mapped —", group: "General", build: () => ({ kind: "unmapped" }) },
  { value: "timestamp", label: "Timestamp / date", group: "Structure", build: () => ({ kind: "timestamp" }) },
  { value: "app", label: "App column (long layout)", group: "Structure", build: () => ({ kind: "app" }) },
  { value: "volumeWeight", label: "Volume weight", group: "Structure", build: () => ({ kind: "volumeWeight" }) },
  { value: "userId", label: "User identifier", group: "Structure", build: () => ({ kind: "userId" }) },
];

/** The full option list (structural + every KPI + every dimension), built once. */
const ALL_OPTIONS: TargetOption[] = [
  ...STRUCTURAL_OPTIONS,
  ...KPI_REGISTRY.map((kpi) => ({
    value: `kpi:${kpi.id}`,
    label: kpi.name,
    group: kpi.pillar,
    build: (): MappingTarget => ({ kind: "kpi", kpiId: kpi.id }),
  })),
  ...DIMENSION_REGISTRY.map((dim) => ({
    value: `dim:${dim.id}`,
    label: dim.name,
    group: "Dimensions",
    build: (): MappingTarget => ({ kind: "dimension", dimensionId: dim.id }),
  })),
];

/** The option `value` that corresponds to a given target, for pre-selection. */
function targetToValue(target: MappingTarget): string {
  switch (target.kind) {
    case "kpi":
      return `kpi:${target.kpiId}`;
    case "dimension":
      return `dim:${target.dimensionId}`;
    default:
      return target.kind;
  }
}

/** A tiny searchable dropdown listing every target, grouped by pillar/dimension. */
function TargetSelector({
  value,
  onChange,
  labelId,
}: {
  value: string;
  onChange: (option: TargetOption) => void;
  labelId: string;
}) {
  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return ALL_OPTIONS;
    return ALL_OPTIONS.filter(
      (o) => o.label.toLowerCase().includes(q) || o.group.toLowerCase().includes(q),
    );
  }, [query]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, TargetOption[]>();
    for (const o of filtered) {
      const list = map.get(o.group) ?? [];
      list.push(o);
      map.set(o.group, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="space-y-1">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search KPIs & dimensions"
          aria-label="Search mapping targets"
          className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <select
        aria-labelledby={labelId}
        value={value}
        size={1}
        onChange={(e) => {
          const opt = ALL_OPTIONS.find((o) => o.value === e.target.value);
          if (opt) onChange(opt);
        }}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {grouped.map(([group, options]) => (
          <optgroup key={group} label={group}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/** Per-column unit selector for a KPI-mapped column (Req 22.4). */
function UnitSelector({
  kpiId,
  value,
  assumed,
  onChange,
  labelId,
}: {
  kpiId: CanonicalKPIId;
  value: string | undefined;
  assumed: boolean;
  onChange: (unit: string) => void;
  labelId: string;
}) {
  const kpi = getKPI(kpiId);
  if (!kpi) return null;
  return (
    <div className="flex items-center gap-1">
      <select
        aria-labelledby={labelId}
        value={value ?? kpi.canonicalUnit}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border border-input bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {kpi.acceptedUnits.map((u) => (
          <option key={u.token} value={u.token}>
            {u.token}
          </option>
        ))}
      </select>
      {assumed && (
        <span
          className="inline-flex items-center gap-1 text-[11px] text-amber-500"
          title="No unit could be inferred; the canonical unit was assumed."
        >
          <AlertTriangle aria-hidden className="!size-3" />
          assumed
        </span>
      )}
    </div>
  );
}

export interface ColumnMappingModalProps {
  open: boolean;
  fileName: string;
  /** The editable draft produced by `proposeMappingDraft`. */
  draft: MappingDraft;
  /** The confirmed file-level app assignment from the mode prompt, if any (Req 21.5). */
  fileAppAssignment?: AppAssignment;
  /** Whether the confirmed ingestion mode allows a user-id hashing toggle (Req 28.13). */
  onConfirm: (draft: MappingDraft, hashUserIds: boolean) => void;
  onCancel: () => void;
}

export function ColumnMappingModal({
  open,
  fileName,
  draft: initialDraft,
  fileAppAssignment,
  onConfirm,
  onCancel,
}: ColumnMappingModalProps) {
  const headingId = React.useId();
  const [draft, setDraft] = React.useState<MappingDraft>(initialDraft);
  const [hashUserIds, setHashUserIds] = React.useState(false);
  const [showErrors, setShowErrors] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setDraft(initialDraft);
      setHashUserIds(false);
      setShowErrors(false);
    }
  }, [open, initialDraft]);

  const assignments = React.useMemo(() => {
    const out: Record<string, MappingTarget> = {};
    for (const c of draft.columns) out[c.header] = c.target;
    return out;
  }, [draft]);

  const validation: MappingValidationResult = React.useMemo(
    () => validateMapping(assignments),
    [assignments],
  );

  const conflictedColumns = React.useMemo(() => {
    const set = new Set<string>();
    for (const c of validation.duplicateConflicts) {
      for (const col of c.columns) set.add(col);
    }
    return set;
  }, [validation]);

  const hasUserIdColumn = draft.columns.some((c) => c.target.kind === "userId");
  const needsFileApp = requiresFileLevelApp(draft.columns, draft.layout);

  /** Update one column's target, re-resolving its unit when it becomes a KPI. */
  function setColumnTarget(header: string, option: TargetOption) {
    setDraft((prev) => {
      const columns = prev.columns.map((c): ColumnDraft => {
        if (c.header !== header) return c;
        const target = option.build();
        if (target.kind === "kpi") {
          // Preserve any wide-layout app qualifier the column already carried.
          const prevApp = c.target.kind === "kpi" ? c.target.app : undefined;
          if (prevApp) target.app = prevApp;
          const { unit, assumed } = resolveColumnUnit(header, target.kpiId);
          return { ...c, target, unit, assumedUnit: assumed };
        }
        return { ...c, target, unit: undefined, assumedUnit: false };
      });
      return { ...prev, columns };
    });
  }

  function setColumnUnit(header: string, unit: string) {
    setDraft((prev) => ({
      ...prev,
      columns: prev.columns.map((c) =>
        c.header === header ? { ...c, unit, assumedUnit: false } : c,
      ),
    }));
  }

  function setColumnApp(header: string, app: AppAssignment) {
    setDraft((prev) => ({
      ...prev,
      columns: prev.columns.map((c) =>
        c.header === header && c.target.kind === "kpi"
          ? { ...c, target: { ...c.target, app } }
          : c,
      ),
    }));
  }

  function setLayout(layout: SourceLayout) {
    setDraft((prev) => ({ ...prev, layout }));
  }

  function handleConfirm() {
    if (!validation.valid) {
      setShowErrors(true);
      return;
    }
    onConfirm(draft, hasUserIdColumn && hashUserIds);
  }

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      labelledBy={headingId}
      className="max-w-4xl"
    >
      <DialogHeader>
        <div>
          <h2 id={headingId} className="text-base font-semibold tracking-tight">
            Map columns
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {fileName}
            {draft.fromCache && " · pre-filled from a previous mapping"}
            {fileAppAssignment && ` · file assigned to ${fileAppAssignment === "App_A" ? "App A" : "App B"}`}
          </p>
        </div>
      </DialogHeader>

      <DialogBody className="space-y-4">
        {/* Layout toggle (Req 21.3) */}
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-muted/30 p-3">
          <fieldset className="flex items-center gap-3">
            <legend className="sr-only">Source layout</legend>
            <span className="text-xs font-medium">Layout</span>
            {(["long", "wide"] as const).map((l) => (
              <label key={l} className="flex items-center gap-1.5 text-xs">
                <input
                  type="radio"
                  name="layout"
                  value={l}
                  checked={draft.layout === l}
                  onChange={() => setLayout(l)}
                />
                {l === "long" ? "Long (app per row)" : "Wide (app per column)"}
              </label>
            ))}
          </fieldset>
          {draft.layoutAmbiguity && (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-500">
              <AlertTriangle aria-hidden className="!size-3" />
              {draft.layoutAmbiguity}
            </p>
          )}
        </div>

        {/* Column table */}
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Source column</th>
                <th scope="col" className="px-3 py-2 font-medium">Sample values</th>
                <th scope="col" className="px-3 py-2 font-medium">Maps to</th>
                <th scope="col" className="px-3 py-2 font-medium">Unit / app</th>
              </tr>
            </thead>
            <tbody>
              {draft.columns.map((col) => {
                const labelId = `map-${col.header}`;
                const unitLabelId = `unit-${col.header}`;
                const isConflicted = conflictedColumns.has(col.header);
                const isKpi = col.target.kind === "kpi";
                const unmappedNeedsSelection =
                  col.target.kind === "unmapped" && col.score < 0.8;
                return (
                  <tr
                    key={col.header}
                    className={cn(
                      "border-t border-border align-top",
                      showErrors && isConflicted && "bg-destructive/10",
                    )}
                  >
                    <th
                      scope="row"
                      id={labelId}
                      className="px-3 py-2 text-left font-medium"
                    >
                      {col.header}
                      {unmappedNeedsSelection && (
                        <span className="mt-0.5 block text-[11px] font-normal text-amber-500">
                          needs selection
                        </span>
                      )}
                      {col.naiveTimestamp && (
                        <span
                          className="mt-0.5 block text-[11px] font-normal text-amber-500"
                          title="Sample values carry no UTC offset; they will be read as UTC."
                        >
                          naive timestamp → assumed UTC
                        </span>
                      )}
                    </th>
                    <td className="px-3 py-2 text-muted-foreground">
                      {col.samples.length === 0 ? (
                        <span className="italic">no samples</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {col.samples.map((s, i) => (
                            <li key={i} className="truncate font-mono">
                              {s}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="w-56 px-3 py-2">
                      <TargetSelector
                        labelId={labelId}
                        value={targetToValue(col.target)}
                        onChange={(opt) => setColumnTarget(col.header, opt)}
                      />
                      {col.score > 0 && col.score < 1 && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          match {(col.score * 100).toFixed(0)}%
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isKpi && col.target.kind === "kpi" && (
                        <div className="space-y-1">
                          <span id={unitLabelId} className="sr-only">
                            Unit for {col.header}
                          </span>
                          <UnitSelector
                            kpiId={col.target.kpiId}
                            value={col.unit}
                            assumed={col.assumedUnit}
                            onChange={(u) => setColumnUnit(col.header, u)}
                            labelId={unitLabelId}
                          />
                          {draft.layout === "wide" && (
                            <div className="flex items-center gap-2 text-[11px]">
                              {(["App_A", "App_B"] as const).map((app) => (
                                <label key={app} className="flex items-center gap-1">
                                  <input
                                    type="radio"
                                    name={`app-${col.header}`}
                                    checked={col.target.kind === "kpi" && col.target.app === app}
                                    onChange={() => setColumnApp(col.header, app)}
                                  />
                                  {app === "App_A" ? "A" : "B"}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* User-id hashing toggle (Req 28.13) */}
        {hasUserIdColumn && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={hashUserIds}
              onChange={(e) => setHashUserIds(e.target.checked)}
            />
            Replace user identifiers with a salted hash at ingestion
          </label>
        )}

        {/* File-level app reminder (Req 21.5) */}
        {needsFileApp && !fileAppAssignment && (
          <p className="flex items-center gap-1.5 text-[11px] text-amber-500">
            <AlertTriangle aria-hidden className="!size-3" />
            This file needs a file-level app assignment; go back and choose App A
            or App B.
          </p>
        )}

        {/* Validation findings (Req 7.8, 7.9) */}
        {showErrors && !validation.valid && (
          <div
            role="alert"
            className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            {validation.errors.map((err, i) => (
              <p key={i}>{err.detail}</p>
            ))}
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={needsFileApp && !fileAppAssignment}
        >
          Confirm mapping
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
