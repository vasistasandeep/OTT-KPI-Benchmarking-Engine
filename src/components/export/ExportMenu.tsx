import * as React from "react";
import { Download, FileSpreadsheet, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useResultStore } from "@/stores/useResultStore";
import { useDatasetStore } from "@/stores/useDatasetStore";
import {
  buildAggregatedSummaryCSV,
  buildDeltaCSV,
  hasExportableData,
  NO_EXPORT_DATA_MESSAGE,
  type ExportLabels,
} from "@/lib/export/csv";
import { printExecutiveReport, triggerDownload } from "@/lib/export/download";
import type { FilterSlice } from "@/models/results";

/**
 * ExportMenu — the Export control on the Global Filter bar (design "Export &
 * Executive Report", Req 18.1).
 *
 * Offers the three actions the requirement names: **Export Delta CSV** (every
 * active KPI with App_A / App_B values, absolute + percentage deltas, and RAG —
 * Req 18.2, 18.3), **Download Aggregated Summary CSV** (aggregated per-app
 * values for the slice — Req 18.4), and **Print Executive Report** (print-
 * optimized report, then the print dialog — Req 18.5, 18.6).
 *
 * Every action first runs the empty-slice guard: if the active slice matched no
 * records, a "no active data to export" message is announced and no file or
 * print dialog is produced (Req 18.7). Exported filenames carry a timestamp in
 * the active display timezone with the zone named, so an export is never
 * ambiguous about which day it belongs to (Req 26.8). Exports carry aggregated
 * values only and never a user-identifier column (Req 28.12).
 */

/** A filesystem-safe timestamp in the active display timezone, zone named. */
function exportTimestamp(displayTimezone: string): string {
  const now = new Date();
  let stamp: string;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: displayTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    stamp = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
  } catch {
    // Unknown IANA zone: fall back to a UTC timestamp so a file is still named.
    stamp = now.toISOString().slice(0, 19).replace(/[:]/g, "").replace("T", "T");
  }
  // Name the zone in the filename so two files from different zones never
  // collide or read ambiguously (Req 26.8).
  const zone = displayTimezone.replace(/[^A-Za-z0-9]+/g, "_");
  return `${stamp}_${zone}`;
}

/** Build an export filename for the given kind and active slice. */
function exportFilename(kind: "delta" | "summary", slice: FilterSlice): string {
  return `ott-kpi-${kind}_${exportTimestamp(slice.displayTimezone)}.csv`;
}

export interface ExportMenuProps {
  className?: string;
}

export function ExportMenu({ className }: ExportMenuProps) {
  const result = useResultStore((s) => s.result);
  const aggregated = useResultStore((s) => s.aggregated);
  const noData = useResultStore((s) => s.noData);
  const appALabel = useDatasetStore((s) => s.appALabel);
  const appBLabel = useDatasetStore((s) => s.appBLabel);

  const [open, setOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const labels = React.useMemo<ExportLabels>(
    () => ({ appA: appALabel, appB: appBLabel }),
    [appALabel, appBLabel],
  );

  // Close the menu on an outside click or Escape.
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /** Run an action behind the empty-slice guard (Req 18.7). */
  function guarded(action: () => void) {
    if (!hasExportableData(result, noData)) {
      setNotice(NO_EXPORT_DATA_MESSAGE);
      setOpen(false);
      return;
    }
    setNotice(null);
    action();
    setOpen(false);
  }

  function handleExportDelta() {
    guarded(() => {
      if (!result) return;
      const csv = buildDeltaCSV(result, labels);
      triggerDownload(csv, exportFilename("delta", result.slice));
    });
  }

  function handleExportSummary() {
    guarded(() => {
      if (!result || !aggregated) {
        // No aggregated set means nothing to summarize (Req 18.7).
        setNotice(NO_EXPORT_DATA_MESSAGE);
        return;
      }
      const csv = buildAggregatedSummaryCSV(
        aggregated,
        result.slice,
        result.results,
        labels,
      );
      triggerDownload(csv, exportFilename("summary", result.slice));
    });
  }

  function handlePrint() {
    guarded(() => {
      printExecutiveReport();
    });
  }

  return (
    <div ref={containerRef} className={cn("relative inline-block", className)} data-print-hide>
      <Button
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Download aria-hidden />
        Export
      </Button>

      {open && (
        <div
          role="menu"
          aria-label="Export actions"
          className="absolute right-0 z-40 mt-1 w-64 overflow-hidden rounded-md border border-border bg-background py-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleExportDelta}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
          >
            <Download aria-hidden className="!size-4" />
            Export Delta CSV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleExportSummary}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
          >
            <FileSpreadsheet aria-hidden className="!size-4" />
            Download Aggregated Summary CSV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handlePrint}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
          >
            <Printer aria-hidden className="!size-4" />
            Print Executive Report
          </button>
        </div>
      )}

      {/* Polite announcement of the empty-slice guard message (Req 18.7, 28.8). */}
      <div aria-live="polite" className="sr-only" role="status">
        {notice}
      </div>
      {notice && (
        <p
          role="alert"
          className="absolute right-0 top-full z-40 mt-1 w-64 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground shadow-md"
        >
          {notice}
        </p>
      )}
    </div>
  );
}
