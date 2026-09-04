import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type TableOptions,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";

/**
 * VirtualizedTable — a reusable high-density, windowed table for large
 * record/breakdown views (design "High-density comparative UI"; Req 15.2, 15.3,
 * 28.9).
 *
 * Rendering is headless-composed: {@link useReactTable} owns column/row modelling
 * and {@link useVirtualizer} windows the body so that at 10,000+ rows only the
 * visible slice (plus a small overscan) is materialized in the DOM (Req 15.3).
 * The layout is the compact broadcast style used across the dashboard — small
 * tabular-numeral type, aligned columns, dark-theme surface and border tokens.
 *
 * Windowing is an accessibility hazard because most rows are absent from the
 * DOM, so the table declares the *full* dataset shape rather than the visible
 * window (Req 28.9):
 *   - `role="grid"` with `aria-rowcount` = header rows + total data rows, and
 *     `aria-colcount` = total column count;
 *   - each rendered row carries `aria-rowindex` = its true 1-based index within
 *     the full row set (the header row is index 1, the first data row index 2),
 *     so a screen reader announces "row 4,120 of 12,000", not a window-relative
 *     position;
 *   - each cell carries `aria-colindex` for the same reason on the column axis.
 * Scroll-position changes are announced through a **polite** live region
 * (Req 28.9): assertive announcements would interrupt, which windowing does not
 * warrant.
 *
 * ## Testability seam
 * jsdom performs no layout, so a virtualizer measuring `getBoundingClientRect`
 * sees a zero-height scroll element and would materialize an arbitrary window.
 * The full-dataset aria semantics (`aria-rowcount` / `aria-colcount` /
 * `aria-rowindex`) are therefore the contract under test — they reflect the
 * data model, not pixel measurement, and hold regardless of how many rows the
 * virtualizer decides to paint. For deterministic materialization in a headless
 * environment, {@link VirtualizedTableProps.estimateRowHeight} and
 * {@link VirtualizedTableProps.overscan} are injectable and
 * {@link VirtualizedTableProps.getScrollElement} lets a test supply a sized
 * element.
 */

export interface VirtualizedTableProps<TData> {
  /** The full row data. Only the visible window is materialized (Req 15.3). */
  data: readonly TData[];
  /** TanStack column definitions. */
  columns: ColumnDef<TData, unknown>[];
  /** Accessible name for the grid (announced by assistive technology). */
  ariaLabel: string;
  /**
   * Estimated row height in px, fed to the virtualizer. Injectable so tests can
   * pin materialization; defaults to the dashboard's compact row height.
   */
  estimateRowHeight?: number;
  /** Rows rendered beyond the visible window on each side. */
  overscan?: number;
  /** Fixed viewport height for the scroll container, in px. */
  height?: number;
  /**
   * Override for the virtualizer's scroll element resolver. Defaults to the
   * internal scroll-container ref; tests may inject a sized element so a window
   * materializes without real layout.
   */
  getScrollElement?: () => HTMLElement | null;
  /**
   * Initial viewport rect handed to the virtualizer. In a browser this is
   * measured from the scroll element, but jsdom performs no layout, so a test
   * can supply a rect here to make a deterministic window materialize without
   * real measurement.
   */
  initialRect?: { width: number; height: number };
  /** Extra table options (sorting, filtering, …) merged into the core config. */
  tableOptions?: Partial<TableOptions<TData>>;
  /** Stable row id accessor, forwarded to TanStack. */
  getRowId?: (row: TData, index: number) => string;
  className?: string;
}

/** Format a count with grouping separators for the live-region message. */
function formatCount(n: number): string {
  return n.toLocaleString();
}

export function VirtualizedTable<TData>({
  data,
  columns,
  ariaLabel,
  estimateRowHeight = 32,
  overscan = 8,
  height = 480,
  getScrollElement,
  initialRect,
  tableOptions,
  getRowId,
  className,
}: VirtualizedTableProps<TData>) {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const table = useReactTable<TData>({
    data: data as TData[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId,
    ...tableOptions,
  });

  const rows = table.getRowModel().rows;
  const totalRows = rows.length;
  const totalColumns = table.getAllLeafColumns().length;

  // aria-rowcount includes the single header row (Req 28.9): the header is
  // row index 1, so the first data row is index 2.
  const HEADER_ROWS = 1;
  const ariaRowCount = totalRows + HEADER_ROWS;

  const resolveScrollElement = React.useCallback(
    () => getScrollElement?.() ?? scrollRef.current,
    [getScrollElement],
  );

  const rowVirtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: resolveScrollElement,
    estimateSize: () => estimateRowHeight,
    overscan,
    ...(initialRect ? { initialRect } : {}),
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const virtualHeight = rowVirtualizer.getTotalSize();

  // Polite live-region text: which slice of the full set is on screen (Req 28.9).
  const [liveMessage, setLiveMessage] = React.useState("");
  const firstIndex = virtualItems[0]?.index;
  const lastIndex = virtualItems[virtualItems.length - 1]?.index;

  React.useEffect(() => {
    if (totalRows === 0 || firstIndex === undefined || lastIndex === undefined) {
      setLiveMessage("");
      return;
    }
    // aria-rowindex is 1-based with the header at 1, so add 1 to the 0-based
    // data indices to match what the row announces.
    setLiveMessage(
      `Showing rows ${formatCount(firstIndex + 1)} to ${formatCount(
        lastIndex + 1,
      )} of ${formatCount(totalRows)}`,
    );
  }, [firstIndex, lastIndex, totalRows]);

  const headerGroups = table.getHeaderGroups();

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card/40 text-foreground",
        className,
      )}
    >
      {/* Polite announcement of the visible window (Req 28.9). */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="virtualized-table-live"
      >
        {liveMessage}
      </div>

      <div
        ref={scrollRef}
        data-testid="virtualized-table-scroll"
        style={{ height, overflow: "auto" }}
        className="relative w-full"
      >
        <div
          role="grid"
          aria-label={ariaLabel}
          aria-rowcount={ariaRowCount}
          aria-colcount={totalColumns}
          className="w-full text-2xs"
        >
          {/* Sticky header row. It is aria-rowindex 1 (Req 28.9). */}
          <div role="rowgroup" className="sticky top-0 z-10 bg-card">
            {headerGroups.map((headerGroup) => (
              <div
                key={headerGroup.id}
                role="row"
                aria-rowindex={HEADER_ROWS}
                className="flex border-b border-border"
              >
                {headerGroup.headers.map((header, colIndex) => (
                  <div
                    key={header.id}
                    role="columnheader"
                    aria-colindex={colIndex + 1}
                    style={{ width: header.getSize() }}
                    className="flex-1 whitespace-nowrap px-2 py-1.5 text-left text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Windowed body: a spacer div reserves the full scroll height while
              only the visible rows are absolutely positioned within it. */}
          <div
            role="rowgroup"
            style={{ height: virtualHeight, position: "relative" }}
          >
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index] as Row<TData>;
              // True 1-based position in the full set, offset past the header
              // row so the header is index 1 and data starts at index 2 (Req 28.9).
              const trueRowIndex = virtualRow.index + 1 + HEADER_ROWS;
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={trueRowIndex}
                  data-index={virtualRow.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="flex items-center border-b border-border/60 hover:bg-accent/40"
                >
                  {row.getVisibleCells().map((cell, colIndex) => (
                    <div
                      key={cell.id}
                      role="gridcell"
                      aria-colindex={colIndex + 1}
                      style={{ width: cell.column.getSize() }}
                      className="flex-1 truncate px-2 py-1 tabular-nums"
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
