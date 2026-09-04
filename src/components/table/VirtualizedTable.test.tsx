import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import type { ColumnDef } from "@tanstack/react-table";

import { VirtualizedTable } from "./VirtualizedTable";

/**
 * jsdom performs no layout: `@tanstack/react-virtual` measures its scroll
 * element via `getBoundingClientRect` / `ResizeObserver`, both of which report
 * zero in a headless DOM, so the real virtualizer paints no window. The full
 * dataset aria semantics (`aria-rowcount` / `aria-colcount` / `aria-rowindex`)
 * are the true contract for Req 28.9 and are derived from the data model, not
 * measurement — those are asserted against the *unmocked* virtualizer below.
 *
 * To exercise the windowed-row rendering (true row index math, cell mapping,
 * and the polite live region) deterministically, the virtualizer is mocked to
 * return a fixed window. This tests our own rendering logic given a known set
 * of virtual items rather than depending on jsdom producing layout.
 */
const ROW_HEIGHT = 32;
const WINDOW_START = 0;
const WINDOW_END = 11; // 12 rows in the window

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    const last = Math.min(WINDOW_END, count - 1);
    const items: { index: number; key: number; start: number; size: number }[] = [];
    for (let i = WINDOW_START; i <= last; i += 1) {
      items.push({ index: i, key: i, start: i * ROW_HEIGHT, size: ROW_HEIGHT });
    }
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * ROW_HEIGHT,
    };
  },
}));

interface Row {
  id: number;
  label: string;
  value: number;
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    label: `Row ${i}`,
    value: i * 2,
  }));
}

const columns: ColumnDef<Row, unknown>[] = [
  { id: "id", header: "ID", accessorKey: "id" },
  { id: "label", header: "Label", accessorKey: "label" },
  { id: "value", header: "Value", accessorKey: "value" },
];

describe("VirtualizedTable", () => {
  it("declares the full dataset shape via aria-rowcount / aria-colcount (Req 28.9)", () => {
    render(
      <VirtualizedTable data={makeRows(12_000)} columns={columns} ariaLabel="Records" />,
    );

    const grid = screen.getByRole("grid", { name: "Records" });
    // 12,000 data rows + 1 header row.
    expect(grid).toHaveAttribute("aria-rowcount", "12001");
    expect(grid).toHaveAttribute("aria-colcount", "3");
  });

  it("keeps aria-rowcount tied to the data model, not the visible window (Req 15.3, 28.9)", () => {
    render(
      <VirtualizedTable data={makeRows(50_000)} columns={columns} ariaLabel="Big" />,
    );

    const grid = screen.getByRole("grid", { name: "Big" });
    // The announced full-count reflects all 50k rows even though only a small
    // window is painted (Req 15.3, 28.9).
    expect(grid).toHaveAttribute("aria-rowcount", "50001");

    const rendered = within(grid).getAllByRole("row");
    expect(rendered.length).toBeLessThan(200);
  });

  it("materializes only the visible window, not all rows (Req 15.3)", () => {
    render(
      <VirtualizedTable data={makeRows(10_000)} columns={columns} ariaLabel="Windowed" />,
    );

    const grid = screen.getByRole("grid", { name: "Windowed" });
    const dataRows = within(grid)
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-rowindex") !== "1");

    // Only the window (12 rows) is materialized — nowhere near 10,000 (Req 15.3).
    expect(dataRows.length).toBe(12);
  });

  it("gives each rendered data row its true 1-based index past the header (Req 28.9)", () => {
    render(
      <VirtualizedTable data={makeRows(10_000)} columns={columns} ariaLabel="Indexed" />,
    );

    const grid = screen.getByRole("grid", { name: "Indexed" });
    // Header row is aria-rowindex 1.
    const header = within(grid).getByRole("row", { name: /ID/ });
    expect(header).toHaveAttribute("aria-rowindex", "1");

    // The first data row (data index 0) is aria-rowindex 2 — its true position
    // in the full set, offset past the header.
    const firstCell = within(grid).getByRole("gridcell", { name: "Row 0" });
    expect(firstCell.closest('[role="row"]')).toHaveAttribute("aria-rowindex", "2");
    expect(firstCell).toHaveAttribute("aria-colindex", "2");
  });

  it("announces the visible window through a polite live region (Req 28.9)", () => {
    render(
      <VirtualizedTable data={makeRows(10_000)} columns={columns} ariaLabel="Live" />,
    );

    const live = screen.getByTestId("virtualized-table-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    // Window is data indices 0..11 → announced as 1-based "1 to 12 of 10,000".
    expect(live).toHaveTextContent("Showing rows 1 to 12 of 10,000");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <VirtualizedTable data={makeRows(500)} columns={columns} ariaLabel="Accessible records" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
