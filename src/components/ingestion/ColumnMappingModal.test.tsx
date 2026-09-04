import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ColumnMappingModal } from "./ColumnMappingModal";
import { proposeMappingDraft } from "@/ingestion/ingestion-flow";
import type { ParsedFile } from "@/ingestion/file-parser";

const parsed: ParsedFile = {
  headers: ["date", "platform", "vst_ms"],
  rows: [{ date: "2025-03-14", platform: "iOS", vst_ms: "1420" }],
  sampleValues: {
    date: ["2025-03-14"],
    platform: ["iOS"],
    vst_ms: ["1420", "1380", "1500"],
  },
};

describe("ColumnMappingModal", () => {
  it("shows up to five sample values per source column (Req 7.1)", () => {
    const draft = proposeMappingDraft(parsed);
    render(
      <ColumnMappingModal
        open
        fileName="march.csv"
        draft={draft}
        fileAppAssignment="App_A"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const row = screen.getByRole("rowheader", { name: /vst_ms/i }).closest("tr")!;
    const cells = within(row);
    expect(cells.getByText("1420")).toBeInTheDocument();
    expect(cells.getByText("1500")).toBeInTheDocument();
  });

  it("preselects the inferred unit for a KPI column (Req 22.4)", () => {
    const draft = proposeMappingDraft(parsed);
    render(
      <ColumnMappingModal
        open
        fileName="march.csv"
        draft={draft}
        fileAppAssignment="App_A"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const unit = screen.getByLabelText(/unit for vst_ms/i) as HTMLSelectElement;
    expect(unit.value).toBe("ms");
  });

  it("blocks confirmation and shows a message when no KPI is mapped (Req 7.8)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    // A draft with everything unmapped: no KPI.
    const draft = proposeMappingDraft({
      headers: ["c1", "c2"],
      rows: [{ c1: "x", c2: "y" }],
      sampleValues: { c1: ["x"], c2: ["y"] },
    });
    // Force both to dimension so schema is mappable but no KPI.
    const withDim = {
      ...draft,
      columns: draft.columns.map((c) => ({
        ...c,
        target: { kind: "dimension" as const, dimensionId: "platform" as const },
      })),
    };
    render(
      <ColumnMappingModal
        open
        fileName="f.csv"
        draft={withDim}
        fileAppAssignment="App_A"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /confirm mapping/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/at least one column to a KPI/i);
  });

  it("confirms a valid mapping (Req 7.6)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const draft = proposeMappingDraft(parsed);
    render(
      <ColumnMappingModal
        open
        fileName="march.csv"
        draft={draft}
        fileAppAssignment="App_A"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /confirm mapping/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("exposes a layout toggle defaulting to the detected layout (Req 21.3)", () => {
    const draft = proposeMappingDraft(parsed);
    render(
      <ColumnMappingModal
        open
        fileName="march.csv"
        draft={draft}
        fileAppAssignment="App_A"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const longRadio = screen.getByLabelText(/long \(app per row\)/i) as HTMLInputElement;
    expect(longRadio.checked).toBe(true);
  });
});
