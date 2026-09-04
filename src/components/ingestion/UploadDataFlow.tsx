import * as React from "react";
import { AlertTriangle, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ColumnMappingModal } from "./ColumnMappingModal";
import { IngestionModePrompt } from "./IngestionModePrompt";
import { parseFile, ParseError, type ParsedFile } from "@/ingestion/file-parser";
import {
  buildConfirmedMapping,
  ingestConfirmedMapping,
  proposeMappingDraft,
  type MappingDraft,
} from "@/ingestion/ingestion-flow";
import type { AppAssignment, IngestionMode } from "@/models";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";

/**
 * UploadDataFlow — the file-upload orchestrator that owns the whole
 * parse → mode → mapping → ingest state machine (Req 6.1–6.5, 7.x, 21.5).
 *
 * It renders an "Upload data" button backed by a hidden file input. When a file
 * is selected it:
 *   1. parses the file with {@link parseFile} (CSV / TSV / XLSX / XLS / JSON),
 *      surfacing a dismissible {@link ParseError} banner on failure (Req 6.3);
 *   2. proposes an editable {@link MappingDraft} via {@link proposeMappingDraft};
 *   3. shows the {@link IngestionModePrompt} FIRST (Req 6.5), computing
 *      `requiresFileLevelApp` from the proposed draft;
 *   4. then shows the {@link ColumnMappingModal};
 *   5. on confirm, builds the confirmed mapping and calls
 *      {@link ingestConfirmedMapping}, which persists the dataset and sets it
 *      active in the repository;
 *   6. calls back into {@link UploadDataFlowProps.onIngested} so the shell
 *      reloads the new dataset into the store, refreshes the dataset list, and
 *      recomputes.
 *
 * Everything is client-resident: parsing, mapping, hashing, and persistence run
 * against in-memory data and the injected repository. No network calls.
 */

/** A collision-resistant id, guarding environments lacking `crypto.randomUUID`. */
function makeDatasetId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ds-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The internal state machine phases for a single upload. */
type FlowState =
  | { kind: "idle" }
  | { kind: "parsing"; fileName: string }
  | {
      kind: "mode";
      fileName: string;
      parsed: ParsedFile;
      draft: MappingDraft;
    }
  | {
      kind: "mapping";
      fileName: string;
      parsed: ParsedFile;
      draft: MappingDraft;
      mode: IngestionMode;
      fileApp?: AppAssignment;
    }
  | { kind: "ingesting"; fileName: string };

export interface UploadDataFlowProps {
  /** The booted repository ingested datasets are written to. */
  repository: KPIDataRepository;
  /** App_A display label for the new dataset's meta (Req 19.5). */
  appALabel: string;
  /** App_B display label for the new dataset's meta (Req 19.5). */
  appBLabel: string;
  /**
   * Called after a successful ingest with the newly-active dataset id, so the
   * shell can reload it into the store, refresh the dataset list, and recompute.
   */
  onIngested: (datasetId: string) => void | Promise<void>;
  className?: string;
}

export function UploadDataFlow({
  repository,
  appALabel,
  appBLabel,
  onIngested,
  className,
}: UploadDataFlowProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [state, setState] = React.useState<FlowState>({ kind: "idle" });
  const [error, setError] = React.useState<string | null>(null);

  /** Reset the flow back to idle and clear the file input value. */
  const reset = React.useCallback(() => {
    setState({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  async function handleFile(file: File) {
    setError(null);
    setState({ kind: "parsing", fileName: file.name });
    try {
      const parsed = await parseFile(file);
      const draft = proposeMappingDraft(parsed);
      setState({ kind: "mode", fileName: file.name, parsed, draft });
    } catch (cause) {
      if (cause instanceof ParseError) {
        setError(cause.message);
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read the selected file.",
        );
      }
      reset();
    }
  }

  function handleModeConfirm(mode: IngestionMode, fileApp?: AppAssignment) {
    setState((prev) =>
      prev.kind === "mode"
        ? {
            kind: "mapping",
            fileName: prev.fileName,
            parsed: prev.parsed,
            draft: prev.draft,
            mode,
            fileApp,
          }
        : prev,
    );
  }

  async function handleMappingConfirm(
    confirmedDraft: MappingDraft,
    hashUserIds: boolean,
  ) {
    if (state.kind !== "mapping") return;
    const { parsed, mode, fileApp, fileName } = state;
    setState({ kind: "ingesting", fileName });
    try {
      const mapping = buildConfirmedMapping(confirmedDraft, mode, fileApp);
      const datasetId = makeDatasetId();
      await ingestConfirmedMapping(repository, parsed, mapping, {
        datasetId,
        datasetName: fileName,
        appALabel,
        appBLabel,
        hashUserIds,
      });
      reset();
      await onIngested(datasetId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not ingest the selected file.",
      );
      reset();
    }
  }

  const busy = state.kind === "parsing" || state.kind === "ingesting";

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.xlsx,.xls,.json"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        aria-label="Upload data"
      >
        <Upload className="size-3.5" aria-hidden="true" />
        {state.kind === "parsing"
          ? "Parsing…"
          : state.kind === "ingesting"
            ? "Importing…"
            : "Upload data"}
      </Button>

      {error && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-foreground"
        >
          <AlertTriangle className="mt-0.5 size-3.5 text-destructive" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Step 3: the ingestion-mode prompt is shown BEFORE the mapping modal (Req 6.5). */}
      {state.kind === "mode" && (
        <IngestionModePrompt
          open
          fileName={state.fileName}
          requiresFileLevelApp={state.draft.requiresFileLevelApp}
          onConfirm={handleModeConfirm}
          onCancel={reset}
        />
      )}

      {/* Step 4: the per-column mapping modal. */}
      {state.kind === "mapping" && (
        <ColumnMappingModal
          open
          fileName={state.fileName}
          draft={state.draft}
          fileAppAssignment={state.fileApp}
          onConfirm={(draft, hashUserIds) =>
            void handleMappingConfirm(draft, hashUserIds)
          }
          onCancel={reset}
        />
      )}
    </div>
  );
}
