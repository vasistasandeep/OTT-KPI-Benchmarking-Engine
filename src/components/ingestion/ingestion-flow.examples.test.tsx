/**
 * Example tests for the ingestion-mode prompt ordering and file-level app
 * assignment (task 12.2).
 *
 * Two acceptance criteria are pinned here as concrete, worked examples that
 * complement the per-component unit tests:
 *
 *   - **Prompt ordering (Req 6.5):** the IngestionModePrompt is presented and
 *     resolved *before* the Column_Mapping modal can be confirmed. A file that
 *     has just parsed shows the mode prompt; the mapping modal is not mounted
 *     until the mode is confirmed, so mapping confirmation is unreachable until
 *     the mode decision has been made. This mirrors how the dashboard shell
 *     sequences the two modals — the mode prompt gates the mapping step.
 *
 *   - **File-level app stamped onto every record (Req 21.5):** a file carrying
 *     no app column and no app-qualified KPI columns requires a file-level App
 *     assignment, and that assignment is applied to *every* record produced
 *     from the file. Driven end-to-end through the pure flow
 *     (`proposeMappingDraft` → `buildConfirmedMapping` → `buildRecords`) across
 *     several file shapes and both apps.
 *
 * Requirements: 6.5, 21.5.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";

import { IngestionModePrompt } from "./IngestionModePrompt";
import { ColumnMappingModal } from "./ColumnMappingModal";
import {
  buildConfirmedMapping,
  proposeMappingDraft,
} from "@/ingestion/ingestion-flow";
import { buildRecords } from "@/ingestion/record-builder";
import type { ParsedFile } from "@/ingestion/file-parser";
import type { AppAssignment, IngestionMode } from "@/models";

// ---------------------------------------------------------------------------
// A minimal orchestrator that composes the two modals the way the shell does:
// the mode prompt first, then — only once a mode is confirmed — the mapping
// modal. This is the smallest harness that exercises the *ordering* the flow
// guarantees without depending on the full dashboard shell.
// ---------------------------------------------------------------------------

function IngestionFlowHarness({
  parsed,
  onMappingConfirmed,
}: {
  parsed: ParsedFile;
  onMappingConfirmed: () => void;
}) {
  const draft = React.useMemo(() => proposeMappingDraft(parsed), [parsed]);
  const [mode, setMode] = React.useState<IngestionMode | null>(null);
  const [fileApp, setFileApp] = React.useState<AppAssignment | undefined>(
    undefined,
  );

  // The mapping modal only exists after the mode prompt has been resolved.
  const mappingOpen = mode !== null;

  return (
    <>
      <IngestionModePrompt
        open={!mappingOpen}
        fileName="march.csv"
        requiresFileLevelApp={draft.requiresFileLevelApp}
        onConfirm={(m, app) => {
          setMode(m);
          setFileApp(app);
        }}
        onCancel={vi.fn()}
      />
      {mappingOpen && (
        <ColumnMappingModal
          open
          fileName="march.csv"
          draft={draft}
          fileAppAssignment={fileApp}
          onConfirm={onMappingConfirmed}
          onCancel={vi.fn()}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Fixtures: files with no app signal (long/file-level) so a file-level app is
// required. Each is a realistic, minimal shape mapping to a single KPI.
// ---------------------------------------------------------------------------

/** A file-level file: date + platform + one KPI column, no app signal at all. */
const fileLevelParsed: ParsedFile = {
  headers: ["date", "platform", "vst_ms"],
  rows: [
    { date: "2025-03-14", platform: "iOS", vst_ms: "1420" },
    { date: "2025-03-15", platform: "Android", vst_ms: "1380" },
    { date: "2025-03-16", platform: "iOS", vst_ms: "1500" },
  ],
  sampleValues: {
    date: ["2025-03-14", "2025-03-15", "2025-03-16"],
    platform: ["iOS", "Android", "iOS"],
    vst_ms: ["1420", "1380", "1500"],
  },
};

describe("ingestion-mode prompt ordering (Req 6.5)", () => {
  it("shows the mode prompt before the mapping modal is available", () => {
    render(
      <IngestionFlowHarness
        parsed={fileLevelParsed}
        onMappingConfirmed={vi.fn()}
      />,
    );

    // The only dialog on screen is the mode prompt.
    expect(
      screen.getByRole("dialog", { name: /how should this file be ingested/i }),
    ).toBeInTheDocument();
    // The mapping modal has not been rendered yet.
    expect(screen.queryByRole("dialog", { name: /map columns/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /confirm mapping/i }),
    ).toBeNull();
  });

  it("does not surface mapping confirmation until the mode is confirmed", async () => {
    const user = userEvent.setup();
    const onMappingConfirmed = vi.fn();
    render(
      <IngestionFlowHarness
        parsed={fileLevelParsed}
        onMappingConfirmed={onMappingConfirmed}
      />,
    );

    // With only the mode prompt open, there is no way to confirm a mapping.
    expect(
      screen.queryByRole("button", { name: /confirm mapping/i }),
    ).toBeNull();

    // Resolve the mode prompt (this file needs a file-level app too, Req 21.5).
    await user.click(screen.getByLabelText(/pre-aggregated/i));
    await user.click(screen.getByLabelText(/app a/i));
    await user.click(
      screen.getByRole("button", { name: /continue to mapping/i }),
    );

    // Only now does the mapping modal — and its confirm action — appear.
    expect(
      screen.getByRole("dialog", { name: /map columns/i }),
    ).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: /confirm mapping/i });
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(onMappingConfirmed).toHaveBeenCalledTimes(1);
  });
});

describe("file-level app assignment stamped onto every record (Req 21.5)", () => {
  it.each<AppAssignment>(["App_A", "App_B"])(
    "stamps the chosen file-level app (%s) onto every produced record",
    (fileApp) => {
      const draft = proposeMappingDraft(fileLevelParsed);
      // The file carries no app signal, so a file-level app is required.
      expect(draft.requiresFileLevelApp).toBe(true);

      const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", fileApp);
      expect(mapping.fileAppAssignment).toBe(fileApp);

      const { records, rejected } = buildRecords(fileLevelParsed.rows, mapping, {
        datasetId: "ds-file-level",
        ingestionMode: "Pre_Aggregated",
      });

      // Every row produced a record and none was rejected.
      expect(rejected).toHaveLength(0);
      expect(records).toHaveLength(fileLevelParsed.rows.length);
      // Every record — regardless of row or dimension — carries the file app.
      expect(records.every((r) => r.app === fileApp)).toBe(true);
    },
  );

  it("stamps the file-level app on raw-session records too", () => {
    const rawParsed: ParsedFile = {
      headers: ["date", "vst"],
      rows: [
        { date: "2025-03-14T00:00:00Z", vst: "1.4" },
        { date: "2025-03-14T01:00:00Z", vst: "1.6" },
      ],
      sampleValues: {
        date: ["2025-03-14T00:00:00Z", "2025-03-14T01:00:00Z"],
        vst: ["1.4", "1.6"],
      },
    };
    const draft = proposeMappingDraft(rawParsed);
    expect(draft.requiresFileLevelApp).toBe(true);

    const mapping = buildConfirmedMapping(draft, "Raw_Session", "App_B");
    const { records } = buildRecords(rawParsed.rows, mapping, {
      datasetId: "ds-raw",
      ingestionMode: "Raw_Session",
    });

    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.app === "App_B")).toBe(true);
  });
});
