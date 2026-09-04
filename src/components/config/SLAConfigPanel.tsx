import * as React from "react";
import { RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CanonicalKPIId } from "@/models";
import { KPI_REGISTRY, getKPI } from "@/registry";
import { useSLAStore } from "@/stores";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";
import {
  buildSLAConfig,
  defaultDraft,
  draftFromConfig,
  formatValidRange,
  validateSLAConfig,
  type SLAConfigDraft,
  type ThresholdFieldError,
} from "@/config/sla-config";

/**
 * SLAConfigPanel — the SLA & Threshold configuration editor
 * (design "SLAConfigPanel (Req 14)"; Req 14.1, 14.2, 14.3, 14.4, 22.7, 25.1,
 * 25.10, 25.11).
 *
 * The analyst customizes the per-KPI SLA threshold (shown beside its canonical
 * unit — Req 22.7), the variance band that drives the Amber RAG band (Req 11.6,
 * 14.1), and the minimum contributing sample size that gates thin-sample
 * verdicts (Req 25.1). Each threshold field is bounded by its KPI's valid range;
 * a non-numeric or out-of-range entry is rejected and the valid range is shown
 * (Req 14.4). Min sample size is validated as a non-negative integer, defaults
 * to 100, and 0 disables the confidence gate (Req 25.1, 25.10, 25.11).
 *
 * Save persists through the repository (`saveSLAConfig`) and pushes the same
 * config into `useSLAStore`, so every subsequent RAG classification applies it
 * (Req 14.2). Reset restores the built-in defaults in the form; the change only
 * takes effect once the user saves (Req 14.3).
 *
 * The component owns no validation of its own — it renders the state
 * `@/config/sla-config` derives and calls back into it, so the whole decision
 * path is unit-testable without mounting the component (task 18.2).
 */

/** Whether a specific KPI's threshold field is flagged invalid (Req 14.4). */
function thresholdError(
  errors: ThresholdFieldError[],
  kpiId: CanonicalKPIId,
): string | undefined {
  return errors.find((e) => e.kpiId === kpiId)?.reason;
}

export interface SLAConfigPanelProps {
  /** Persistence adapter; Save writes through `saveSLAConfig` (Req 14.2). */
  repository: KPIDataRepository;
  /**
   * Called after a successful Save so the active slice recomputes and every RAG
   * classification re-renders with the new thresholds (Req 14.2). May be async.
   */
  onSaved?: () => void | Promise<void>;
  /** The KPIs offered in the editor; defaults to every registered KPI. */
  kpiIds?: CanonicalKPIId[];
}

export function SLAConfigPanel({ repository, onSaved, kpiIds }: SLAConfigPanelProps) {
  const config = useSLAStore((s) => s.config);
  const setConfig = useSLAStore((s) => s.setConfig);

  const offeredKpis = React.useMemo<CanonicalKPIId[]>(
    () => kpiIds ?? KPI_REGISTRY.map((k) => k.id),
    [kpiIds],
  );

  // Seed the editable draft from the active config on first render; changes to
  // the persisted config elsewhere re-seed the form.
  const [draft, setDraft] = React.useState<SLAConfigDraft>(() => draftFromConfig(config));
  React.useEffect(() => {
    setDraft(draftFromConfig(config));
  }, [config]);

  const [submitted, setSubmitted] = React.useState(false);
  const [savedNotice, setSavedNotice] = React.useState(false);

  const validation = React.useMemo(() => validateSLAConfig(draft), [draft]);

  function setThresholdText(kpiId: CanonicalKPIId, value: string) {
    setSavedNotice(false);
    setDraft((prev) => ({
      ...prev,
      thresholds: { ...prev.thresholds, [kpiId]: value },
    }));
  }

  function setVarianceBandText(value: string) {
    setSavedNotice(false);
    setDraft((prev) => ({ ...prev, varianceBand: value }));
  }

  function setMinSampleSizeText(value: string) {
    setSavedNotice(false);
    setDraft((prev) => ({ ...prev, minSampleSize: value }));
  }

  /** Restore the built-in defaults in the form; takes effect on Save (Req 14.3). */
  function handleReset() {
    setSubmitted(false);
    setSavedNotice(false);
    setDraft(defaultDraft());
  }

  /** Validate, persist, and apply the config to subsequent classification (Req 14.2). */
  async function handleSave() {
    setSubmitted(true);
    if (!validateSLAConfig(draft).valid) return;

    const nextConfig = buildSLAConfig(draft);
    await repository.saveSLAConfig(nextConfig);
    setConfig(nextConfig);
    setSubmitted(false);
    setSavedNotice(true);
    await onSaved?.();
  }

  const varianceInvalid = submitted && validation.varianceBandError !== undefined;
  const minSampleInvalid = submitted && validation.minSampleSizeError !== undefined;

  return (
    <section aria-labelledby="sla-config-heading" className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 id="sla-config-heading" className="text-base font-semibold tracking-tight">
            SLA &amp; thresholds
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Customize per-KPI RAG thresholds, the variance band, and the minimum
            sample size. Values are in each KPI's canonical unit.
          </p>
        </div>
      </header>

      {/* Global settings: variance band + min sample size (Req 14.1, 25.1) */}
      <div className="flex flex-wrap items-start gap-4 rounded-md border border-border bg-muted/30 p-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Variance band</span>
          <div className="flex items-center gap-1.5">
            <input
              inputMode="decimal"
              value={draft.varianceBand}
              onChange={(e) => setVarianceBandText(e.target.value)}
              aria-label="Variance band"
              aria-invalid={varianceInvalid}
              className={cn(
                "h-8 w-28 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                varianceInvalid && "border-destructive bg-destructive/10",
              )}
            />
            <span className="text-muted-foreground">%</span>
          </div>
          {varianceInvalid && (
            <span className="text-[11px] text-destructive">
              {validation.varianceBandError}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Min sample size</span>
          <input
            inputMode="numeric"
            value={draft.minSampleSize}
            onChange={(e) => setMinSampleSizeText(e.target.value)}
            aria-label="Minimum sample size"
            aria-invalid={minSampleInvalid}
            className={cn(
              "h-8 w-28 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              minSampleInvalid && "border-destructive bg-destructive/10",
            )}
          />
          {minSampleInvalid ? (
            <span className="text-[11px] text-destructive">
              {validation.minSampleSizeError}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Set to 0 to disable the confidence gate.
            </span>
          )}
        </label>
      </div>

      {/* Per-KPI threshold editor (Req 14.2, 14.4, 22.7) */}
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">KPI</th>
              <th scope="col" className="px-3 py-2 font-medium">SLA threshold</th>
              <th scope="col" className="px-3 py-2 font-medium">Unit</th>
              <th scope="col" className="px-3 py-2 font-medium">Valid range</th>
            </tr>
          </thead>
          <tbody>
            {offeredKpis.map((kpiId) => {
              const kpi = getKPI(kpiId);
              const error = submitted
                ? thresholdError(validation.thresholdErrors, kpiId)
                : undefined;
              const fieldId = `sla-threshold-${kpiId}`;
              const placeholder =
                kpi?.defaultSLA !== undefined ? `default ${kpi.defaultSLA}` : "";
              return (
                <tr key={kpiId} className="border-t border-border align-top">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {kpi?.name ?? kpiId}
                  </th>
                  <td className="px-3 py-2">
                    <input
                      id={fieldId}
                      inputMode="decimal"
                      value={draft.thresholds[kpiId] ?? ""}
                      placeholder={placeholder}
                      onChange={(e) => setThresholdText(kpiId, e.target.value)}
                      aria-label={`SLA threshold for ${kpi?.name ?? kpiId}`}
                      aria-invalid={error !== undefined}
                      className={cn(
                        "h-8 w-28 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        error && "border-destructive bg-destructive/10",
                      )}
                    />
                    {error && (
                      <span className="mt-0.5 block text-[11px] text-destructive">
                        {error}
                      </span>
                    )}
                  </td>
                  {/* Canonical unit shown beside each field (Req 22.7) */}
                  <td className="px-3 py-2 text-muted-foreground">
                    {kpi?.canonicalUnit ?? ""}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatValidRange(kpiId)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {savedNotice && (
        <p role="status" className="text-xs text-muted-foreground">
          Thresholds saved. New values apply to every comparison.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={handleSave}>
          <Save aria-hidden /> Save thresholds
        </Button>
        <Button variant="ghost" onClick={handleReset}>
          <RotateCcw aria-hidden /> Reset to defaults
        </Button>
      </div>
    </section>
  );
}
