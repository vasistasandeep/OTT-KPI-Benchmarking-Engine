import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ManualEntryForm } from "./ManualEntryForm";
import type { KPIRecord } from "@/models";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";

/** A repository stub recording the lifecycle calls the form makes. */
function makeRepo() {
  return {
    appendRecords: vi.fn().mockResolvedValue(undefined),
    updateRecord: vi.fn().mockResolvedValue(undefined),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
  } as unknown as KPIDataRepository & {
    appendRecords: ReturnType<typeof vi.fn>;
    updateRecord: ReturnType<typeof vi.fn>;
    deleteRecord: ReturnType<typeof vi.fn>;
  };
}

const manualRecord: KPIRecord = {
  id: "ds1:seed:App_A",
  datasetId: "ds1",
  app: "App_A",
  timestampUtc: "2025-03-14T00:00:00.000Z",
  sourceUtcOffsetMinutes: null,
  bucket: { hourUtc: "2025-03-14T00:00:00Z", dayUtc: "2025-03-14" },
  origin: "manual",
  dimensions: {
    platform: "iOS",
    network: "Wi-Fi",
    cdn: "Akamai",
    geography: "Country",
    streamType: "VOD Movies",
  },
  metrics: { vst_p50: 1.2 },
  ingestedGranularity: "day",
};

const fileRecord: KPIRecord = { ...manualRecord, id: "ds1:0:App_A", origin: "file" };
const mockRecord: KPIRecord = { ...manualRecord, id: "ds1:mock:App_B", origin: "mock" };

const KPIS = ["vst_p50"] as const;

describe("ManualEntryForm", () => {
  it("flags a non-numeric field and does not submit (Req 8.3)", async () => {
    const user = userEvent.setup();
    const repo = makeRepo();
    render(
      <ManualEntryForm
        datasetId="ds1"
        repository={repo}
        records={[]}
        onRecompute={vi.fn()}
        kpiIds={[...KPIS]}
      />,
    );
    await user.type(screen.getByLabelText(/for App A/i), "oops");
    await user.click(screen.getByRole("button", { name: /submit entries/i }));
    expect(repo.appendRecords).not.toHaveBeenCalled();
    expect(screen.getByText(/not a number/i)).toBeInTheDocument();
  });

  it("submits valid entries as manual records and recomputes (Req 8.2, 27.11)", async () => {
    const user = userEvent.setup();
    const repo = makeRepo();
    const onRecompute = vi.fn();
    render(
      <ManualEntryForm
        datasetId="ds1"
        repository={repo}
        records={[]}
        onRecompute={onRecompute}
        kpiIds={[...KPIS]}
      />,
    );
    await user.type(screen.getByLabelText(/for App A/i), "1.2");
    await user.click(screen.getByRole("button", { name: /submit entries/i }));
    expect(repo.appendRecords).toHaveBeenCalledTimes(1);
    const [, records] = repo.appendRecords.mock.calls[0];
    expect(records[0].origin).toBe("manual");
    expect(onRecompute).toHaveBeenCalled();
  });

  it("edits a manual row in place preserving its id and recomputes (Req 27.8, 27.11)", async () => {
    const user = userEvent.setup();
    const repo = makeRepo();
    const onRecompute = vi.fn();
    render(
      <ManualEntryForm
        datasetId="ds1"
        repository={repo}
        records={[manualRecord]}
        onRecompute={onRecompute}
        kpiIds={[...KPIS]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /edit manual record/i }));
    const input = screen.getByLabelText(/for App A/i) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "1.8");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(repo.updateRecord).toHaveBeenCalledTimes(1);
    const [, updated] = repo.updateRecord.mock.calls[0];
    expect(updated.id).toBe(manualRecord.id); // id preserved
    expect(updated.metrics.vst_p50).toBeCloseTo(1.8);
    expect(repo.appendRecords).not.toHaveBeenCalled();
    expect(onRecompute).toHaveBeenCalled();
  });

  it("deletes a manual row only after confirmation and recomputes (Req 27.10, 27.11)", async () => {
    const user = userEvent.setup();
    const repo = makeRepo();
    const onRecompute = vi.fn();
    render(
      <ManualEntryForm
        datasetId="ds1"
        repository={repo}
        records={[manualRecord]}
        onRecompute={onRecompute}
        kpiIds={[...KPIS]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /delete manual record/i }));
    // Dialog is open; deleteRecord not yet called until confirm.
    expect(repo.deleteRecord).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /delete record/i }));
    expect(repo.deleteRecord).toHaveBeenCalledWith("ds1", manualRecord.id);
    expect(onRecompute).toHaveBeenCalled();
  });

  it("does not delete when the confirmation is cancelled (Req 27.10)", async () => {
    const user = userEvent.setup();
    const repo = makeRepo();
    render(
      <ManualEntryForm
        datasetId="ds1"
        repository={repo}
        records={[manualRecord]}
        onRecompute={vi.fn()}
        kpiIds={[...KPIS]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /delete manual record/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(repo.deleteRecord).not.toHaveBeenCalled();
  });

  it("lists only manual-origin records as editable (Req 27.9)", () => {
    render(
      <ManualEntryForm
        datasetId="ds1"
        repository={makeRepo()}
        records={[manualRecord, fileRecord]}
        onRecompute={vi.fn()}
        kpiIds={[...KPIS]}
      />,
    );
    // Only the manual record surfaces edit/delete controls.
    expect(screen.getAllByRole("button", { name: /edit manual record/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /delete manual record/i })).toHaveLength(1);
  });

  it("exposes no edit or delete affordance for file- or mock-origin rows (Req 27.9)", () => {
    const repo = makeRepo();
    render(
      <ManualEntryForm
        datasetId="ds1"
        repository={repo}
        // A dataset made up entirely of read-only rows.
        records={[fileRecord, mockRecord]}
        onRecompute={vi.fn()}
        kpiIds={[...KPIS]}
      />,
    );
    // Neither the file nor the mock row is editable/deletable: no lifecycle
    // control is rendered and the manual-records table reports none.
    expect(screen.queryByRole("button", { name: /edit manual record/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete manual record/i })).toBeNull();
    expect(screen.getByText(/no manual records yet/i)).toBeInTheDocument();
    // A read-only row can never reach the repository mutators.
    expect(repo.updateRecord).not.toHaveBeenCalled();
    expect(repo.deleteRecord).not.toHaveBeenCalled();
  });

  it("edits only the targeted manual row when read-only rows are mixed in (Req 27.9)", async () => {
    const user = userEvent.setup();
    const repo = makeRepo();
    render(
      <ManualEntryForm
        datasetId="ds1"
        repository={repo}
        records={[fileRecord, manualRecord, mockRecord]}
        onRecompute={vi.fn()}
        kpiIds={[...KPIS]}
      />,
    );
    // Exactly one editable row surfaces; editing it writes back that record's id
    // and never touches a file- or mock-origin row.
    await user.click(screen.getByRole("button", { name: /edit manual record/i }));
    const input = screen.getByLabelText(/for App A/i) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "2.5");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(repo.updateRecord).toHaveBeenCalledTimes(1);
    const [, updated] = repo.updateRecord.mock.calls[0];
    expect(updated.id).toBe(manualRecord.id);
    expect(updated.origin).toBe("manual");
  });
});
