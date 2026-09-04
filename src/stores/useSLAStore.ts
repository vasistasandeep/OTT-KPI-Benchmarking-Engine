/**
 * `useSLAStore` — the active SLA configuration: per-KPI thresholds, the variance
 * band, and the minimum sample size that drives the confidence gate (design
 * "State stores", Req 14). The comparator reads this config to classify RAG and
 * to suppress thin-sample verdicts.
 *
 * The store holds the config in memory and exposes setters the SLA panel (task
 * 18.1) drives. Persistence is the repository's job: {@link hydrateSLA} loads
 * the saved config on boot, and callers persist edits through the repository
 * separately so the store never depends on a storage API directly.
 *
 * Requirements: 14 (SLA config), 25.1 (default min sample size), 11.6 (default
 * variance band).
 */

import { create } from "zustand";

import type { SLAConfig } from "@/models/config";
import type { CanonicalKPIId } from "@/models/ids";
import { DEFAULT_SLA_CONFIG } from "@/repository";

/** The SLA store's state and actions. */
export interface SLAStoreState {
  /** The active SLA configuration applied to every RAG classification. */
  config: SLAConfig;
  /** Replace the whole config (used by `hydrateSLA` and the SLA panel's save). */
  setConfig(config: SLAConfig): void;
  /** Set the variance band (%) used by the Amber band (Req 11.6, 14.1). */
  setVarianceBand(varianceBand: number): void;
  /** Set the minimum contributing sample size per app; 0 disables the gate (Req 25.1). */
  setMinSampleSize(minSampleSize: number): void;
  /** Override one KPI's threshold, in the KPI's canonical unit (Req 14.2). */
  setThreshold(kpiId: CanonicalKPIId, threshold: number): void;
  /** Restore the built-in defaults (SLA panel "reset", Req 14). */
  reset(): void;
}

/** A fresh copy of the default SLA config so no two stores share a `thresholds` object. */
function defaultConfig(): SLAConfig {
  return {
    varianceBand: DEFAULT_SLA_CONFIG.varianceBand,
    minSampleSize: DEFAULT_SLA_CONFIG.minSampleSize,
    thresholds: {},
  };
}

export const useSLAStore = create<SLAStoreState>((set) => ({
  config: defaultConfig(),

  setConfig: (config) => set({ config }),

  setVarianceBand: (varianceBand) =>
    set((state) => ({ config: { ...state.config, varianceBand } })),

  setMinSampleSize: (minSampleSize) =>
    set((state) => ({ config: { ...state.config, minSampleSize } })),

  setThreshold: (kpiId, threshold) =>
    set((state) => ({
      config: {
        ...state.config,
        thresholds: { ...state.config.thresholds, [kpiId]: threshold },
      },
    })),

  reset: () => set({ config: defaultConfig() }),
}));
