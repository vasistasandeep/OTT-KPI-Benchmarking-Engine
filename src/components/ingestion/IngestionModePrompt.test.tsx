import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

import { IngestionModePrompt } from "./IngestionModePrompt";

describe("IngestionModePrompt", () => {
  it("requires a mode before Continue is enabled (Req 6.5)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <IngestionModePrompt
        open
        fileName="march.csv"
        requiresFileLevelApp={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const continueBtn = screen.getByRole("button", { name: /continue to mapping/i });
    expect(continueBtn).toBeDisabled();

    await user.click(screen.getByLabelText(/pre-aggregated/i));
    expect(continueBtn).toBeEnabled();

    await user.click(continueBtn);
    expect(onConfirm).toHaveBeenCalledWith("Pre_Aggregated", undefined);
  });

  it("requires a file-level app when the file carries no app signal (Req 21.5)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <IngestionModePrompt
        open
        fileName="march.csv"
        requiresFileLevelApp
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Choose a mode but not an app — Continue stays disabled.
    await user.click(screen.getByLabelText(/raw session/i));
    const continueBtn = screen.getByRole("button", { name: /continue to mapping/i });
    expect(continueBtn).toBeDisabled();

    // Now assign the app.
    await user.click(screen.getByLabelText(/app a/i));
    expect(continueBtn).toBeEnabled();

    await user.click(continueBtn);
    expect(onConfirm).toHaveBeenCalledWith("Raw_Session", "App_A");
  });

  it("is labelled as a modal dialog (Req 28.6)", () => {
    render(
      <IngestionModePrompt
        open
        fileName="march.csv"
        requiresFileLevelApp={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(/how should this file be ingested/i);
  });

  it("has no axe violations when a file-level app is required (Req 28.5)", async () => {
    const { container } = render(
      <IngestionModePrompt
        open
        fileName="march.csv"
        requiresFileLevelApp
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
