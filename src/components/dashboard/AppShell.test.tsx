import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { AppShell } from "./AppShell";
import { createKPIRepository, type RepositoryBootResult } from "@/repository";
import { seedMockDataset } from "@/ingestion/mock-seeder";
import { defaultFilterSlice, useFilterStore, useResultStore } from "@/stores";
import type { FilterSlice } from "@/models/results";

/**
 * Boot an isolated in-memory repository pre-seeded with the demo dataset, so
 * the shell hydrates deterministically without touching IndexedDB or the wall
 * clock. The demo window is fixed (2025-03), so tests choose a slice that does
 * or does not cover it to exercise the with-data and no-data paths.
 */
async function bootWithDemo(): Promise<RepositoryBootResult> {
  const { repository } = await createKPIRepository({
    forceInMemory: true,
    databaseName: `test-${Math.random()}`,
  });
  const demo = seedMockDataset();
  await repository.saveDataset(demo);
  await repository.setActiveDatasetId(demo.id);
  return { repository, persistent: false };
}

/** A custom slice covering the fixed demo window (2025-03). */
function demoCoveringSlice(): FilterSlice {
  return {
    ...defaultFilterSlice(),
    dateRange: { preset: "custom", from: "2025-03-01", to: "2025-03-31" },
  };
}

beforeEach(() => {
  useFilterStore.setState({ slice: defaultFilterSlice(), revision: 0 });
  useResultStore.setState({
    result: null,
    aggregated: null,
    noData: false,
    status: "idle",
    progress: null,
    slice: null,
    error: null,
  });
});

describe("AppShell", () => {
  it("renders the sticky global filter bar", async () => {
    // Cover the demo window so hydrate resolves to a ready state quickly.
    useFilterStore.setState({ slice: demoCoveringSlice(), revision: 1 });
    render(<AppShell bootRepository={bootWithDemo} />);
    expect(await screen.findByTestId("global-filter-bar")).toBeInTheDocument();
  });

  it("hydrates on mount and renders the module slots when the slice has data (Req 3.3)", async () => {
    useFilterStore.setState({ slice: demoCoveringSlice(), revision: 1 });
    render(<AppShell bootRepository={bootWithDemo} />);

    // Module placeholder slots appear once hydrate + the first recompute finish.
    expect(
      await screen.findByRole("region", { name: /kpi scorecards/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /winner heatmap/i })).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-no-data")).not.toBeInTheDocument();
  });

  it("shows the shell no-data state when the slice matches nothing (Req 10.6)", async () => {
    // Default 30d preset resolves relative to now and cannot cover the fixed
    // 2025-03 demo window, so the slice matches no records.
    render(<AppShell bootRepository={bootWithDemo} />);

    expect(await screen.findByTestId("dashboard-no-data")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: /kpi scorecards/i }),
    ).not.toBeInTheDocument();
  });

  it("renders injected module content into the content slot", async () => {
    useFilterStore.setState({ slice: demoCoveringSlice(), revision: 1 });
    render(
      <AppShell bootRepository={bootWithDemo}>
        <div data-testid="real-module">Scorecards go here</div>
      </AppShell>,
    );
    expect(await screen.findByTestId("real-module")).toBeInTheDocument();
    // Placeholders are replaced by real content.
    expect(
      screen.queryByRole("region", { name: /winner heatmap/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the non-persistent storage advisory banner", async () => {
    const bootWithAdvisory = async (): Promise<RepositoryBootResult> => {
      const boot = await bootWithDemo();
      return { ...boot, advisory: "Private browsing: data kept in memory only." };
    };
    useFilterStore.setState({ slice: demoCoveringSlice(), revision: 1 });
    render(<AppShell bootRepository={bootWithAdvisory} />);
    expect(
      await screen.findByText(/private browsing: data kept in memory only/i),
    ).toBeInTheDocument();
  });

  it("shows an error state when boot fails", async () => {
    const bootFails = async (): Promise<RepositoryBootResult> => {
      throw new Error("boom");
    };
    render(<AppShell bootRepository={bootFails} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/boom/i);
  });

  it("renders the injected export slot in the filter bar", async () => {
    useFilterStore.setState({ slice: demoCoveringSlice(), revision: 1 });
    render(
      <AppShell
        bootRepository={bootWithDemo}
        exportSlot={<button>Export</button>}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("export-slot")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
  });
});
