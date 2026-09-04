/**
 * UnitNormalizer — infers a source column's unit, resolves it against a KPI's
 * accepted units, and converts each ingested value to that KPI's canonical unit
 * before persistence (Req 22.3, 22.5, 22.6, 22.8).
 *
 * Unit resolution has three steps, mirroring the design's "Unit inference and
 * normalization" section:
 *
 *   1. Inference (Req 22.3): scan the source header for a recognized unit
 *      token, considering ONLY the mapped KPI's `acceptedUnits`. This keeps a
 *      `_s` suffix on a bitrate column from being read as seconds, since a
 *      bitrate KPI has no `s` in its accepted units.
 *   2. Fallback (Req 22.6): when nothing is inferable, resolve to the canonical
 *      unit (factor 1) and raise an `ASSUMED_UNIT` advisory naming the column
 *      and the assumed unit. Ingestion is never blocked (Req 22.8).
 *   3. Normalization (Req 22.5): multiply each value by the resolved
 *      `UnitSpec.factor`. A value already in the canonical unit multiplies by 1,
 *      so normalization is a no-op there.
 *
 * The same resolution + conversion is used for file ingestion, manual entry,
 * and the mock seeder, so every value written through the repository is already
 * expressed in the KPI's canonical unit.
 */

import type { CanonicalKPIId, DataQualityAdvisory } from "@/models";
import { getKPI } from "@/registry";
import type { UnitSpec } from "@/registry";

/**
 * Outcome of resolving a source column's unit against a KPI's accepted units.
 */
export interface ResolvedUnit {
  /** The KPI whose canonical unit the value will be expressed in. */
  kpiId: CanonicalKPIId;
  /** The accepted unit the value is treated as being in at the source. */
  unit: UnitSpec;
  /**
   * True when no unit could be inferred from the header and the KPI's canonical
   * unit was assumed as a fallback (Req 22.6).
   */
  assumed: boolean;
}

/**
 * Synonyms that map a spelled-out or abbreviated header token to the canonical
 * unit token used in the registry. Matching is restricted afterwards to the
 * KPI's own accepted units, so a synonym for a unit the KPI does not accept is
 * simply ignored.
 */
const TOKEN_SYNONYMS: Readonly<Record<string, string>> = {
  ms: "ms",
  msec: "ms",
  msecs: "ms",
  milli: "ms",
  millis: "ms",
  millisecond: "ms",
  milliseconds: "ms",
  s: "s",
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  min: "min",
  mins: "min",
  minute: "min",
  minutes: "min",
  hour: "hours",
  hours: "hours",
  hr: "hours",
  hrs: "hours",
  bps: "bps",
  kbps: "kbps",
  mbps: "Mbps",
  pct: "%",
  percent: "%",
  percentage: "%",
  ratio: "ratio",
};

/**
 * Split a header into normalized lowercase tokens. Splits on any run of
 * characters that are not letters or digits (so `_`, ` `, `-`, `/`, `.`, `()`
 * all act as separators) and also on letter/digit boundaries so `vst_ms`,
 * `vstMs`, and `bitrate(kbps)` all yield a bare `ms`/`kbps` token.
 */
function tokenizeHeader(header: string): string[] {
  const normalized = header.trim().toLowerCase();
  // Insert a boundary between a run of letters and a run of digits, e.g.
  // "vst95ms" -> "vst 95 ms", so an embedded unit is isolated as its own token.
  const spaced = normalized
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2");
  return spaced.split(/[^a-z0-9%]+/i).filter((t) => t.length > 0);
}

/**
 * The `%` symbol is not a word character, so it survives tokenization only when
 * standalone. Detect a trailing/embedded percent sign directly on the header.
 */
function hasPercentSign(header: string): boolean {
  return header.includes("%");
}

/**
 * Infer the source unit of a column from its header, considering only the
 * accepted units of the mapped KPI (Req 22.3).
 *
 * Returns the matching {@link UnitSpec}, or `undefined` when the header carries
 * no token that maps to one of this KPI's accepted units. The `Mbps`/`kbps`
 * distinction is case-insensitive on the header but resolved against the exact
 * accepted-unit token, so a bitrate KPI's `kbps` and `Mbps` are told apart.
 */
export function inferUnit(header: string, kpiId: CanonicalKPIId): UnitSpec | undefined {
  const kpi = getKPI(kpiId);
  if (!kpi) return undefined;

  const acceptedByToken = new Map<string, UnitSpec>();
  for (const spec of kpi.acceptedUnits) {
    acceptedByToken.set(spec.token.toLowerCase(), spec);
  }

  const tokens = tokenizeHeader(header);
  if (hasPercentSign(header)) {
    tokens.push("%");
  }

  // Scan tokens; the last recognized unit token wins so a trailing suffix such
  // as the `ms` in `vst_ms` takes precedence over any earlier coincidental hit.
  let match: UnitSpec | undefined;
  for (const token of tokens) {
    const canonicalToken = TOKEN_SYNONYMS[token] ?? token;
    const spec = acceptedByToken.get(canonicalToken.toLowerCase());
    if (spec) {
      match = spec;
    }
  }
  return match;
}

/**
 * Resolve the unit for a column mapped to a KPI: infer it from the header, or
 * fall back to the KPI's canonical unit and flag the value as assumed
 * (Req 22.6). The returned unit always has a valid conversion factor.
 */
export function resolveUnit(header: string, kpiId: CanonicalKPIId): ResolvedUnit {
  const kpi = getKPI(kpiId);
  if (!kpi) {
    throw new Error(`Unknown KPI id: ${kpiId}`);
  }

  const inferred = inferUnit(header, kpiId);
  if (inferred) {
    return { kpiId, unit: inferred, assumed: false };
  }

  // Fallback: assume the canonical unit. The registry guarantees the canonical
  // unit is present in acceptedUnits at factor 1, but resolve defensively.
  const canonical =
    kpi.acceptedUnits.find((u) => u.token === kpi.canonicalUnit) ??
    ({ token: kpi.canonicalUnit, factor: 1 } as UnitSpec);

  return { kpiId, unit: canonical, assumed: true };
}

/**
 * Convert a single value to the KPI's canonical unit by multiplying by the
 * resolved unit's factor (Req 22.5). A value already canonical multiplies by 1.
 */
export function normalizeValue(value: number, unit: UnitSpec): number {
  return value * unit.factor;
}

/**
 * Build the `ASSUMED_UNIT` data-quality advisory for a column whose unit could
 * not be inferred (Req 22.6). Names the source column and the assumed unit.
 */
export function assumedUnitAdvisory(
  sourceColumn: string,
  kpiId: CanonicalKPIId,
  assumedUnit: string,
): DataQualityAdvisory {
  return {
    code: "ASSUMED_UNIT",
    detail:
      `Could not infer a unit for source column "${sourceColumn}" mapped to ` +
      `"${kpiId}"; assumed the canonical unit "${assumedUnit}". Please confirm.`,
  };
}

/**
 * Resolve and convert a single mapped value in one step. Returns the canonical
 * value plus an optional `ASSUMED_UNIT` advisory when the unit was assumed.
 *
 * This is the entry point used by file ingestion, manual entry, and the mock
 * seeder alike: each supplies the raw value and its source header, and receives
 * back a value already expressed in the KPI's canonical unit (Req 22.5, 22.8).
 */
export function normalizeMappedValue(
  value: number,
  sourceColumn: string,
  kpiId: CanonicalKPIId,
): { value: number; advisory?: DataQualityAdvisory } {
  const resolved = resolveUnit(sourceColumn, kpiId);
  const canonicalValue = normalizeValue(value, resolved.unit);
  if (resolved.assumed) {
    return {
      value: canonicalValue,
      advisory: assumedUnitAdvisory(sourceColumn, kpiId, resolved.unit.token),
    };
  }
  return { value: canonicalValue };
}
