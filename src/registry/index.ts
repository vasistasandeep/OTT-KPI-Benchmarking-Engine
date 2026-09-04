/**
 * Public entry point for the registries.
 *
 * Re-exports the KPI taxonomy types and the seeded KPI registry (task 3.1).
 * The dimension registry (task 3.3) will be re-exported here as well.
 */

// KPI taxonomy types (Req 1, 22.1, 24.1)
export type {
  Pillar,
  Directionality,
  AggregationKind,
  UnitSpec,
  KPIDerivation,
  KPIDefinition,
} from "./kpi-types";

// KPI taxonomy registry and lookups (Req 1)
export {
  KPI_REGISTRY,
  KPI_BY_ID,
  ALL_KPI_IDS,
  getKPI,
  getKPIsByPillar,
} from "./kpi-registry";
