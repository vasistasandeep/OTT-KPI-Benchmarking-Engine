import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

import { GlobalFilterBar } from "./GlobalFilterBar";
import { defaultFilterSlice, useFilterStore } from "@/stores";

/** Reset the filter store to its default slice before each test. */
beforeEach(() => {
  useFilterStore.setState({ slice: defaultFilterSlice(), revision: 0 });
});

describe("GlobalFilterBar", () => {
  it("is sticky at the top so it stays visible while content scrolls (Req 10.1)", () => {
    render(<GlobalFilterBar />);
    const bar = screen.getByTestId("global-filter-bar");
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("top-0");
  });

  it("offers the three date-range presets and writes the choice to the store (Req 10.2)", async () => {
    const user = userEvent.setup();
    render(<GlobalFilterBar />);

    // Defaults to the 30d preset.
    expect(useFilterStore.getState().slice.dateRange.preset).toBe("30d");

    await user.click(screen.getByRole("button", { name: /last 7 days/i }));
    expect(useFilterStore.getState().slice.dateRange.preset).toBe("7d");

    // Custom reveals the from/to date inputs.
    await user.click(screen.getByRole("button", { name: /^custom$/i }));
    expect(useFilterStore.getState().slice.dateRange.preset).toBe("custom");
    expect(screen.getByLabelText(/custom range start/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/custom range end/i)).toBeInTheDocument();
  });

  it("writes a custom from/to date to the store (Req 10.2, 26.7)", async () => {
    const user = userEvent.setup();
    render(<GlobalFilterBar />);

    await user.click(screen.getByRole("button", { name: /^custom$/i }));
    const from = screen.getByLabelText(/custom range start/i);
    await user.type(from, "2024-03-01");

    expect(useFilterStore.getState().slice.dateRange.from).toBe("2024-03-01");
  });

  it("renders all five multi-select dimension chip groups (Req 10.3)", () => {
    render(<GlobalFilterBar />);
    for (const name of [
      /platform/i,
      /network & isp/i,
      /cdn provider/i,
      /geography/i,
      /stream type/i,
    ]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    }
  });

  it("toggles a dimension member into the slice selection (Req 10.3)", async () => {
    const user = userEvent.setup();
    render(<GlobalFilterBar />);

    const platform = screen.getByRole("group", { name: /platform/i });
    const chip = within(platform).getByRole("checkbox", { name: /^iOS$/i });
    expect(chip).toHaveAttribute("aria-checked", "false");

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-checked", "true");
    expect(useFilterStore.getState().slice.dimensionSelections.platform).toContain(
      "iOS",
    );

    // Toggling again removes it.
    await user.click(chip);
    expect(
      useFilterStore.getState().slice.dimensionSelections.platform,
    ).not.toContain("iOS");
  });

  it("toggles apps but keeps at least one selected (Req 10.4)", async () => {
    const user = userEvent.setup();
    render(<GlobalFilterBar />);

    const apps = screen.getByRole("group", { name: /^apps$/i });
    const appA = within(apps).getByRole("checkbox", { name: /app a/i });
    const appB = within(apps).getByRole("checkbox", { name: /app b/i });

    // Deselect App_A → only App_B remains.
    await user.click(appA);
    expect(useFilterStore.getState().slice.apps).toEqual(["App_B"]);

    // Attempting to deselect the last remaining app is a no-op.
    await user.click(appB);
    expect(useFilterStore.getState().slice.apps).toEqual(["App_B"]);
  });

  it("defaults the display timezone to UTC and labels the active zone (Req 26.8, 26.9)", async () => {
    const user = userEvent.setup();
    render(<GlobalFilterBar />);

    expect(useFilterStore.getState().slice.displayTimezone).toBe("UTC");
    expect(screen.getByTestId("active-timezone")).toHaveTextContent("UTC");

    await user.selectOptions(
      screen.getByLabelText(/display timezone/i),
      "Asia/Kolkata",
    );
    expect(useFilterStore.getState().slice.displayTimezone).toBe("Asia/Kolkata");
    expect(screen.getByTestId("active-timezone")).toHaveTextContent("Asia/Kolkata");
  });

  it("renders the Export menu into the trailing slot", () => {
    render(<GlobalFilterBar exportSlot={<button>Export</button>} />);
    const slot = screen.getByTestId("export-slot");
    expect(within(slot).getByRole("button", { name: /export/i })).toBeInTheDocument();
  });

  it("bumps the store revision on a filter change so recompute is triggered (Req 10.5)", async () => {
    const user = userEvent.setup();
    render(<GlobalFilterBar />);

    const before = useFilterStore.getState().revision;
    await user.click(screen.getByRole("button", { name: /last 7 days/i }));
    expect(useFilterStore.getState().revision).toBeGreaterThan(before);
  });

  it("has no axe violations", async () => {
    const { container } = render(<GlobalFilterBar />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
