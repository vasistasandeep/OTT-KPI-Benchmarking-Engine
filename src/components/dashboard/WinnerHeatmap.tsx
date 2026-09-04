import * as React from "react";
import {
  CircleDashed,
  Equal,
  SearchX,
  ShieldQuestion,
  Trophy,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { AppAssignment, DimensionId } from "@/models";
import { DIMENSION_REGISTRY, getDimensionDefinition } from "@/registry/dimensions";
import { KPI_REGISTRY } from "@/registry/kpi-registry";
import type { KPIDefinition } from "@/registry/kpi-types";
import { useDatasetStore, useResultStore, useSLAStore } from "@/stores";
import type { WinnerOutcome } from "@/engine/winner";

import {
  buildHeatmapMatrix,
  type HeatmapCell,
} from "./winner-heatmap-model";

/**
 * WinnerHeatmap — the KPI × dimension-segment winner matrix (Req 12; design
 * "Winner Heatmap").
 *
 * Rows are the core KPIs; columns are the members of a single, selectable
 * dimension (the segment-dimension selector, Req 12.4). Each cell compares
 * App_A against App_B for its (KPI, segment) and shows the winner, computed by
 * the shared, directionality-aware {@link determineWinner} gate through
 * {@link buildHeatmapMatrix} (Req 12.2, 12.5, 23.4, 25.8, 25.9).
 *
 * The winner is **never conveyed by color alone** (Req 28.2): every cell —
 * including the four non-winner states (no-data, not-aggregable, low-confidence,
 * tie) — carries a distinct glyph *and* a text label, and each cell's
 * accessible name spells the verdict out in full. Color is a redundant cue on
 * top of the glyph and label, tuned against the dark-theme RAG tokens in
 * `index.css`.
 *
 * The module reads the pre-computed per-segment aggregates from
 * {@link useResultStore} (`aggregated.bySegment`) and never re-aggregates, so
 * it stays consistent with the scorecards and honours the engine's
 * aggregability guards (Req 23.4). App labels come from {@link useDatasetStore}
 * so a dataset's custom App_A / App_B names propagate here (Req 19.6); the
 * confidence floor comes from {@link useSLAStore} (Req 25.8).
 */

/** The subset of KPIs shown as heatmap rows: the core, non-derived KPIs. */
const HEATMAP_KPIS: readonly KPIDefinition[] = KPI_REGISTRY;

/** Visual + accessible descriptor for one winner outcome (Req 28.2). */
interface OutcomeStyle {
  /** A distinct glyph, so the cell is decodable without color. */
  Icon: LucideIcon;
  /** A short label rendered in the cell alongside the glyph. */
  label: (appLabel: (app: AppAssignment) => string) => string;
  /** Tailwind classes for the cell fill/text; a redundant cue only. */
  className: string;
}

/**
 * The per-outcome glyph + label + fill. The label and glyph are the primary
 * carriers of meaning; the fill class is redundant (Req 28.2). Winner cells are
 * resolved separately because their label depends on which app won.
 */
const OUTCOME_STYLES: Record<Exclude<WinnerOutcome, AppAssignment>, OutcomeStyle> = {
  neutral: {
    Icon: Equal,
    label: () => "Tie",
    className: "bg-rag-neutral/15 text-foreground",
  },
  no_data: {
    Icon: SearchX,
    label: () => "No data",
    className: "bg-muted/40 text-muted-foreground",
  },
  not_aggregable: {
    Icon: XCircle,
    label: () => "Not comparable",
    className: "bg-secondary/60 text-muted-foreground",
  },
  low_confidence: {
    Icon: ShieldQuestion,
    label: () => "Low confidence",
    className: "bg-rag-amber/15 text-foreground",
  },
};

/** The winner (App_A / App_B) cell style; label is the winning app's name. */
const WINNER_STYLE: Omit<OutcomeStyle, "label"> = {
  Icon: Trophy,
  className: "bg-rag-green/20 text-foreground",
};

/** A human sentence describing a cell, used as its accessible name (Req 28.2). */
function cellDescription(
  cell: HeatmapCell,
  kpi: KPIDefinition,
  appLabel: (app: AppAssignment) => string,
): string {
  const where = `${kpi.name}, ${cell.segmentMember}`;
  switch (cell.winner.outcome) {
    case "App_A":
    case "App_B":
      return `${where}: ${appLabel(cell.winner.outcome)} wins`;
    case "neutral":
      return `${where}: tie, no winner`;
    case "no_data":
      return `${where}: no data for one or both apps`;
    case "not_aggregable":
      return `${where}: not comparable at this slice`;
    case "low_confidence":
      return `${where}: low confidence, sample below the minimum size`;
    default:
      return where;
  }
}

/** Render one matrix cell with its glyph, label, and accessible description. */
function Cell({
  cell,
  kpi,
  appLabel,
}: {
  cell: HeatmapCell;
  kpi: KPIDefinition;
  appLabel: (app: AppAssignment) => string;
}) {
  const isWinner =
    cell.winner.outcome === "App_A" || cell.winner.outcome === "App_B";

  const style: OutcomeStyle = isWinner
    ? {
        ...WINNER_STYLE,
        label: () => appLabel(cell.winner.outcome as AppAssignment),
      }
    : OUTCOME_STYLES[cell.winner.outcome as Exclude<WinnerOutcome, AppAssignment>];

  const { Icon } = style;
  const label = style.label(appLabel);
  const description = cellDescription(cell, kpi, appLabel);

  return (
    <td
      role="gridcell"
      aria-label={description}
      title={description}
      data-outcome={cell.winner.outcome}
      className="p-1 align-middle"
    >
      <div
        className={cn(
          "flex min-h-9 items-center justify-center gap-1 rounded-md border border-border/60 px-1.5 py-1 text-2xs font-medium",
          style.className,
        )}
      >
        <Icon className="size-3 shrink-0" aria-hidden={true} />
        <span className="truncate">{label}</span>
      </div>
    </td>
  );
}

/** The heatmap's own no-data state, shown when the slice yields no segments. */
function HeatmapEmptyState({ reason }: { reason: string }) {
  return (
    <div
      data-testid="heatmap-no-data"
      className="flex flex-col items-center justify-center rounded-lg border border-border bg-card/40 py-12 text-center"
    >
      <CircleDashed className="size-7 text-muted-foreground" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium text-foreground">
        No segments to compare
      </p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">{reason}</p>
    </div>
  );
}

export interface WinnerHeatmapProps {
  className?: string;
}

export function WinnerHeatmap({ className }: WinnerHeatmapProps) {
  const aggregated = useResultStore((s) => s.aggregated);
  const minSampleSize = useSLAStore((s) => s.config.minSampleSize);
  const appALabel = useDatasetStore((s) => s.appALabel);
  const appBLabel = useDatasetStore((s) => s.appBLabel);

  const appLabel = React.useCallback(
    (app: AppAssignment): string => (app === "App_A" ? appALabel : appBLabel),
    [appALabel, appBLabel],
  );

  // Default the segment dimension to the first registered dimension (platform).
  const [dimension, setDimension] = React.useState<DimensionId>(
    DIMENSION_REGISTRY[0].id,
  );

  const matrix = React.useMemo(() => {
    if (!aggregated) return null;
    return buildHeatmapMatrix(aggregated, dimension, HEATMAP_KPIS, {
      minSampleSize,
    });
  }, [aggregated, dimension, minSampleSize]);

  const dimensionName = getDimensionDefinition(dimension).name;

  const selectorId = React.useId();

  return (
    <section
      aria-label="Winner Heatmap"
      className={cn(
        "rounded-lg border border-border bg-card/40 p-4",
        className,
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Winner Heatmap
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            KPI winner by {dimensionName.toLowerCase()} segment. Each cell shows
            a glyph and label, never color alone.
          </p>
        </div>

        {/* Segment-dimension selector (Req 12.4). */}
        <div className="flex items-center gap-2">
          <label
            htmlFor={selectorId}
            className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Segment by
          </label>
          <select
            id={selectorId}
            value={dimension}
            onChange={(e) => setDimension(e.target.value as DimensionId)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {DIMENSION_REGISTRY.map((dim) => (
              <option key={dim.id} value={dim.id}>
                {dim.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!matrix || matrix.segmentMembers.length === 0 ? (
        <HeatmapEmptyState
          reason={
            !aggregated
              ? "Results are still computing for the active slice."
              : `No ${dimensionName.toLowerCase()} segments are present in the active slice. Pick another dimension or widen the filters.`
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table
            role="grid"
            aria-label={`KPI winners by ${dimensionName} segment`}
            className="w-full border-separate border-spacing-0 text-left"
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-10 bg-card px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  KPI
                </th>
                {matrix.segmentMembers.map((member) => (
                  <th
                    key={member}
                    scope="col"
                    className="whitespace-nowrap px-2 py-1.5 text-center text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {member}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.kpi.id}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 whitespace-nowrap bg-card px-2 py-1 text-xs font-medium text-foreground"
                  >
                    {row.kpi.name}
                  </th>
                  {row.cells.map((cell) => (
                    <Cell
                      key={`${row.kpi.id}::${cell.segmentMember}`}
                      cell={cell}
                      kpi={row.kpi}
                      appLabel={appLabel}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend: every state's glyph + label, so the matrix is self-documenting. */}
      <ul
        aria-label="Heatmap legend"
        className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground"
      >
        <li className="flex items-center gap-1">
          <Trophy className="size-3" aria-hidden="true" />
          Winner (app label)
        </li>
        <li className="flex items-center gap-1">
          <Equal className="size-3" aria-hidden="true" />
          Tie
        </li>
        <li className="flex items-center gap-1">
          <ShieldQuestion className="size-3" aria-hidden="true" />
          Low confidence
        </li>
        <li className="flex items-center gap-1">
          <XCircle className="size-3" aria-hidden="true" />
          Not comparable
        </li>
        <li className="flex items-center gap-1">
          <SearchX className="size-3" aria-hidden="true" />
          No data
        </li>
      </ul>
    </section>
  );
}
