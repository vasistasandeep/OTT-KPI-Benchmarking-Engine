import * as React from "react";
import { Database, FileStack, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AppAssignment, IngestionMode } from "@/models";

/**
 * IngestionModePrompt — the modal shown after a file parses and *before* the
 * Column_Mapping modal is confirmed (Req 6.5; design "IngestionModePrompt").
 *
 * It forces a choice of `Pre_Aggregated` or `Raw_Session` ingestion mode, and —
 * when the parsed file carries no app signal in its headers (no app column, no
 * app-qualified KPI columns) — additionally requires the user to assign the
 * whole file to App_A or App_B, which is then stamped onto every record from
 * that file (Req 21.5).
 *
 * Confirmation is disabled until every required choice is made. When
 * `requiresFileLevelApp` is true the app radio group is mandatory; otherwise it
 * is not rendered at all. The dialog is not dismissible by Escape/overlay — the
 * mode is a required decision that gates the rest of the flow — but it can be
 * cancelled explicitly, which aborts ingestion.
 */

export interface IngestionModePromptProps {
  open: boolean;
  /** File name, shown in the heading so the user knows what they are configuring. */
  fileName: string;
  /** Whether a file-level App assignment is required for this file (Req 21.5). */
  requiresFileLevelApp: boolean;
  /** A pre-selected but unconfirmed file-level app from a cached mapping (Req 7.7). */
  suggestedFileApp?: AppAssignment;
  /** Called with the confirmed mode (and app when required). */
  onConfirm: (mode: IngestionMode, fileApp?: AppAssignment) => void;
  /** Called when the user cancels the whole ingestion. */
  onCancel: () => void;
}

const MODE_OPTIONS: {
  value: IngestionMode;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    value: "Pre_Aggregated",
    label: "Pre-aggregated summaries",
    description: "Rows are already summarized KPI values per date/hour and dimension.",
    icon: Database,
  },
  {
    value: "Raw_Session",
    label: "Raw session logs",
    description: "Rows are individual playback sessions; KPIs are computed on the fly.",
    icon: FileStack,
  },
];

export function IngestionModePrompt({
  open,
  fileName,
  requiresFileLevelApp,
  suggestedFileApp,
  onConfirm,
  onCancel,
}: IngestionModePromptProps) {
  const headingId = React.useId();
  const descId = React.useId();
  const [mode, setMode] = React.useState<IngestionMode | null>(null);
  const [fileApp, setFileApp] = React.useState<AppAssignment | null>(
    suggestedFileApp ?? null,
  );

  // Reset when the dialog reopens for a new file.
  React.useEffect(() => {
    if (open) {
      setMode(null);
      setFileApp(suggestedFileApp ?? null);
    }
  }, [open, suggestedFileApp]);

  const canConfirm = mode !== null && (!requiresFileLevelApp || fileApp !== null);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      labelledBy={headingId}
      describedBy={descId}
      dismissible={false}
      className="max-w-lg"
    >
      <DialogHeader>
        <div>
          <h2 id={headingId} className="text-base font-semibold tracking-tight">
            How should this file be ingested?
          </h2>
          <p id={descId} className="mt-0.5 text-xs text-muted-foreground">
            {fileName}
          </p>
        </div>
      </DialogHeader>

      <DialogBody className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Ingestion mode</legend>
          {MODE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = mode === opt.value;
            return (
              <label
                key={opt.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent/40",
                )}
              >
                <input
                  type="radio"
                  name="ingestion-mode"
                  className="mt-1"
                  value={opt.value}
                  checked={selected}
                  onChange={() => setMode(opt.value)}
                />
                <span className="flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon className="text-muted-foreground" aria-hidden />
                    {opt.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {opt.description}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {requiresFileLevelApp && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">
              Assign this file to an app
            </legend>
            <p className="text-xs text-muted-foreground">
              This file carries no app column or app-suffixed columns, so every
              record it produces will be attributed to the app you choose here.
            </p>
            <div className="flex gap-2">
              {(["App_A", "App_B"] as const).map((app) => {
                const selected = fileApp === app;
                return (
                  <label
                    key={app}
                    className={cn(
                      "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border p-2 text-sm font-medium transition-colors",
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent/40",
                    )}
                  >
                    <input
                      type="radio"
                      name="file-app"
                      className="sr-only"
                      value={app}
                      checked={selected}
                      onChange={() => setFileApp(app)}
                    />
                    {app === "App_A" ? "App A" : "App B"}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!canConfirm}
          onClick={() => {
            if (mode === null) return;
            onConfirm(mode, requiresFileLevelApp ? (fileApp ?? undefined) : undefined);
          }}
        >
          Continue to mapping
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
