import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DatasetSwitcher } from "./DatasetSwitcher";
import type { Dataset, DatasetMeta } from "@/models";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";
import { DuplicateNameError, type RetentionCheckOutcome } from "@/repository/support";
import { useDatasetStore } from "@/stores/useDatasetStore";

/** Build a minimal dataset with the given id/name and optional label overrides. */
function makeDataset(overrides: Partial<Dataset> & Pick<Dataset, "id" | "name">): Dataset {
  return {
    createdAt: "2025-01-01T00:00:00.000Z",
    appALabel: "App A",
    appBLabel: "App B",
    recordCount: 0,
    sourceType: "Aggregated",
    ingestionMode: "Pre_Aggregated",
    records: [],
    ...overrides,
  };
}

function metaOf(d: Dataset): DatasetMeta {
  const { records: _records, ...meta } = d;
  return meta;
}

/**
 * A repository stub over an in-memory list. It reproduces the persistence
 * behaviours the switcher relies on: duplicate-name rejection, active-pointer
 * clearing on delete, and a scriptable retention outcome.
 */
function makeRepo(initial: Dataset[], retention: RetentionCheckOutcome = { kind: "ok" }) {
  const store = new Map(initial.map((d) => [d.id, d]));
  let activeId: string | undefined = initial[0]?.id;

  const repo = {
    listDatasets: vi.fn(async () => [...store.values()].map(metaOf)),
    getDataset: vi.fn(async (id: string) => store.get(id)),
    saveDataset: vi.fn(async (dataset: Dataset) => {
      for (const existing of store.values()) {
        if (existing.name === dataset.name && existing.id !== dataset.id) {
          throw new DuplicateNameError(dataset.name);
        }
      }
      store.set(dataset.id, dataset);
    }),
    renameDataset: vi.fn(async (id: string, name: string) => {
      for (const existing of store.values()) {
        if (existing.name === name && existing.id !== id) {
          throw new DuplicateNameError(name);
        }
      }
      const d = store.get(id);
      if (d) store.set(id, { ...d, name });
    }),
    deleteDataset: vi.fn(async (id: string) => {
      store.delete(id);
      if (activeId === id) activeId = undefined;
    }),
    getActiveDatasetId: vi.fn(async () => activeId),
    setActiveDatasetId: vi.fn(async (id: string) => {
      activeId = id;
    }),
    checkRetention: vi.fn(async () => retention),
  } as unknown as KPIDataRepository & Record<string, ReturnType<typeof vi.fn>>;

  return { repo, store, getActiveId: () => activeId };
}

/** Seed the store as the app shell would after hydration. */
function seedStore(active: Dataset | null, all: Dataset[]) {
  useDatasetStore.getState().setActiveDataset(active);
  useDatasetStore.getState().setDatasets(all.map(metaOf));
}

afterEach(() => {
  useDatasetStore.setState({
    activeDataset: null,
    datasets: [],
    appALabel: "App A",
    appBLabel: "App B",
  });
});

describe("DatasetSwitcher", () => {
  it("selects a dataset, persisting the choice and recomputing (Req 19.2)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const b = makeDataset({ id: "b", name: "Beta" });
    const { repo, getActiveId } = makeRepo([a, b]);
    seedStore(a, [a, b]);
    const onRecompute = vi.fn();

    render(<DatasetSwitcher repository={repo} onRecompute={onRecompute} />);
    await user.selectOptions(screen.getByLabelText("Active dataset"), "b");

    expect(repo.setActiveDatasetId).toHaveBeenCalledWith("b");
    expect(getActiveId()).toBe("b");
    expect(useDatasetStore.getState().activeDataset?.id).toBe("b");
    expect(onRecompute).toHaveBeenCalled();
  });

  it("renames a dataset and reflects the new name (Req 19.3)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const { repo } = makeRepo([a]);
    seedStore(a, [a]);

    render(<DatasetSwitcher repository={repo} onRecompute={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /rename active dataset/i }));
    const input = screen.getByLabelText("Dataset name");
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(repo.renameDataset).toHaveBeenCalledWith("a", "Renamed");
    expect(useDatasetStore.getState().activeDataset?.name).toBe("Renamed");
  });

  it("rejects a rename whose name collides with an existing dataset (Req 19.7)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const b = makeDataset({ id: "b", name: "Beta" });
    const { repo } = makeRepo([a, b]);
    seedStore(a, [a, b]);

    render(<DatasetSwitcher repository={repo} onRecompute={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /rename active dataset/i }));
    const input = screen.getByLabelText("Dataset name");
    await user.clear(input);
    await user.type(input, "Beta");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/must be unique/i);
    // The dialog stays open and the active name is unchanged.
    expect(useDatasetStore.getState().activeDataset?.name).toBe("Alpha");
  });

  it("creates a new empty dataset and makes it active (Req 19.4)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const { repo, store } = makeRepo([a]);
    seedStore(a, [a]);
    const onRecompute = vi.fn();

    render(<DatasetSwitcher repository={repo} onRecompute={onRecompute} />);
    await user.click(screen.getByRole("button", { name: /create new dataset/i }));
    await user.type(screen.getByLabelText("Dataset name"), "Q2 Run");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(repo.saveDataset).toHaveBeenCalled();
    const created = [...store.values()].find((d) => d.name === "Q2 Run");
    expect(created).toBeDefined();
    expect(created?.recordCount).toBe(0);
    expect(useDatasetStore.getState().activeDataset?.name).toBe("Q2 Run");
    expect(onRecompute).toHaveBeenCalled();
  });

  it("rejects creating a dataset with a duplicate name (Req 19.7)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const { repo } = makeRepo([a]);
    seedStore(a, [a]);

    render(<DatasetSwitcher repository={repo} onRecompute={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /create new dataset/i }));
    await user.type(screen.getByLabelText("Dataset name"), "Alpha");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/must be unique/i);
  });

  it("overrides App_A/App_B labels and propagates them via the store (Req 19.5, 19.6)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const { repo } = makeRepo([a]);
    seedStore(a, [a]);

    render(<DatasetSwitcher repository={repo} onRecompute={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /edit app a and app b labels/i }));
    const appA = screen.getByLabelText("App A label");
    const appB = screen.getByLabelText("App B label");
    await user.clear(appA);
    await user.type(appA, "Current");
    await user.clear(appB);
    await user.type(appB, "Experimental");
    await user.click(screen.getByRole("button", { name: /save labels/i }));

    expect(repo.saveDataset).toHaveBeenCalled();
    const state = useDatasetStore.getState();
    expect(state.appALabel).toBe("Current");
    expect(state.appBLabel).toBe("Experimental");
  });

  it("promotes another dataset when the active one is deleted (Req 19.8)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const b = makeDataset({ id: "b", name: "Beta" });
    const { repo, store } = makeRepo([a, b]);
    seedStore(a, [a, b]);

    render(<DatasetSwitcher repository={repo} onRecompute={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /delete active dataset/i }));
    await user.click(screen.getByRole("button", { name: /delete dataset/i }));

    expect(repo.deleteDataset).toHaveBeenCalledWith("a");
    expect(store.has("a")).toBe(false);
    // Beta is promoted as the new active dataset.
    expect(useDatasetStore.getState().activeDataset?.id).toBe("b");
  });

  it("falls back to the demo dataset when the last dataset is deleted (Req 19.9)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const { repo } = makeRepo([a]);
    seedStore(a, [a]);

    render(<DatasetSwitcher repository={repo} onRecompute={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /delete active dataset/i }));
    await user.click(screen.getByRole("button", { name: /delete dataset/i }));

    expect(repo.deleteDataset).toHaveBeenCalledWith("a");
    // restoreActiveDataset seeds and persists the demo dataset (sourceType Mock).
    const active = useDatasetStore.getState().activeDataset;
    expect(active).not.toBeNull();
    expect(active?.sourceType).toBe("Mock");
  });

  it("surfaces retention deletion candidates for confirmation (Req 27.6, 27.7)", async () => {
    const user = userEvent.setup();
    const a = makeDataset({ id: "a", name: "Alpha" });
    const retention: RetentionCheckOutcome = {
      kind: "RetentionLimitReached",
      limit: "maxDatasets",
      ceiling: 1,
      current: 2,
      deletionCandidates: [{ id: "old", name: "Old Run", createdAt: "2024-01-01T00:00:00.000Z" }],
      message: "You have reached the maximum of 1 stored datasets.",
    };
    const { repo } = makeRepo([a], retention);
    seedStore(a, [a]);

    render(<DatasetSwitcher repository={repo} onRecompute={vi.fn()} />);
    // Creating a dataset triggers the retention check after the save.
    await user.click(screen.getByRole("button", { name: /create new dataset/i }));
    await user.type(screen.getByLabelText("Dataset name"), "Another");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/retention limit reached/i)).toBeInTheDocument();
    expect(within(dialog).getByText("Old Run")).toBeInTheDocument();

    // Confirming a candidate deletes only that dataset (Req 27.7).
    await user.click(within(dialog).getByRole("button", { name: /delete old run to free storage/i }));
    expect(repo.deleteDataset).toHaveBeenCalledWith("old");
  });
});
