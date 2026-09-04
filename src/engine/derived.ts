/**
 * Derived-KPI resolution (ratio-of-aggregates).
 *
 * A derived KPI is computed from other KPIs' *already-aggregated* values for the
 * active slice, never from records and never by averaging per-group derived
 * values. Stickiness is the only derived KPI in the current taxonomy:
 *
 *   Stickiness = 100 * aggregate(DAU, slice) / aggregate(MAU, slice)
 *
 * `resolveDerived` is a pure function. It consumes the operand aggregates the
 * engine has already produced for the slice (step 4 of the fixed execution
 * order) and applies the derivation (step 5). Because it only ever sees the
 * aggregates — not the per-group values — there is structurally no way for it to
 * average per-group ratios (Req 24.2, 24.3).
 *
 * Sentinel inheritance: if any operand aggregate is `NO_DATA` or
 * `NOT_AGGREGABLE`, the derived value takes that same sentinel and names the
 * operand responsible so the UI can explain the empty cell (Req 24.4). If the
 * denominator operand aggregates to exactly 0, the ratio is undefined and the
 * result is `NO_DATA` per the zero-divisor rule (Req 24.5, 16.1).
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 16.1.
 */

import { NO_DATA, NOT_AGGREGABLE } from "../models/sentinels";
import type { Numeric } from "../models/sentinels";
import type { CanonicalKPIId } from "../models/ids";
import type { KPIDerivation } from "../registry/kpi-types";

/**
 * The outcome of resolving a derived KPI for a slice.
 *
 * When `value` is a sentinel (`NO_DATA` or `NOT_AGGREGABLE`), `responsibleOperand`
 * names the operand KPI that caused it — either the operand that was itself a
 * sentinel (Req 24.4) or the denominator that aggregated to 0 (Req 24.5). When
 * `value` is a finite number, `responsibleOperand` is `undefined`.
 */
export interface DerivedResolution {
  value: Numeric;
  /** The operand KPI responsible for a sentinel result, when applicable. */
  responsibleOperand?: CanonicalKPIId;
}

/** A source of aggregated operand values for the active slice. */
export type OperandAggregates =
  | ReadonlyMap<CanonicalKPIId, Numeric>
  | ((operand: CanonicalKPIId) => Numeric | undefined);

/** Round a finite number to 2 decimal places. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Look an operand's aggregate up from either a Map or a lookup function. */
function lookup(aggregates: OperandAggregates, operand: CanonicalKPIId): Numeric | undefined {
  return typeof aggregates === "function" ? aggregates(operand) : aggregates.get(operand);
}

/**
 * Resolve a derived KPI from its operands' aggregated values for the active
 * slice.
 *
 * The derivation's operands are read in order: for `divide`, the first operand
 * is the numerator and the second is the denominator. Sentinel operands are
 * detected before any arithmetic — the first operand (in declaration order) that
 * is `NO_DATA` or `NOT_AGGREGABLE` becomes the responsible operand and its
 * sentinel is inherited (Req 24.4). A missing operand aggregate (no value
 * supplied for the slice) is treated as `NO_DATA` and named the same way. Only
 * once every operand is a finite number is the operation applied; a zero
 * denominator then yields `NO_DATA` naming the denominator (Req 24.5, 16.1).
 *
 * @param derivation the operands, operation, and optional scale (Req 24.1).
 * @param aggregates aggregated operand values already computed for the slice.
 */
export function resolveDerived(
  derivation: KPIDerivation,
  aggregates: OperandAggregates,
): DerivedResolution {
  const resolved: number[] = [];

  // Pass 1: inherit the first operand's sentinel (or missing -> NO_DATA), in
  // declaration order, before any arithmetic runs (Req 24.4).
  for (const operand of derivation.operands) {
    const raw = lookup(aggregates, operand);
    if (raw === undefined || raw === NO_DATA) {
      return { value: NO_DATA, responsibleOperand: operand };
    }
    if (raw === NOT_AGGREGABLE) {
      return { value: NOT_AGGREGABLE, responsibleOperand: operand };
    }
    resolved.push(raw);
  }

  // Pass 2: every operand is finite — apply the operation.
  const scale = derivation.scale ?? 1;

  switch (derivation.operation) {
    case "divide": {
      const [numerator, denominator] = resolved;
      // Zero denominator -> undefined ratio -> NO_DATA (Req 24.5, 16.1).
      if (denominator === 0) {
        return { value: NO_DATA, responsibleOperand: derivation.operands[1] };
      }
      return { value: round2((scale * numerator) / denominator) };
    }
    case "multiply": {
      const product = resolved.reduce((acc, v) => acc * v, 1);
      return { value: round2(scale * product) };
    }
    case "subtract": {
      const [first, ...rest] = resolved;
      const difference = rest.reduce((acc, v) => acc - v, first);
      return { value: round2(scale * difference) };
    }
  }
}
