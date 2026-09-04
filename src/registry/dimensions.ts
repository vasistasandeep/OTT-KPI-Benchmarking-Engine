/**
 * Dimension registry (Req 2).
 *
 * Defines the five slicing dimensions and their seed member values. Every
 * dimension is `extensible`: an ingested value not present in the seed members
 * is retained and appended as a new member of the corresponding dimension
 * (Req 2.7), which is why the registry is the single source of truth for the
 * *seed* set only, not a closed enumeration.
 *
 * `DimensionId` is owned by the core models forward declaration in
 * `src/models/ids.ts` (a stable literal union). It is re-exported here so the
 * registry is the canonical place consumers import both the id type and the
 * definitions from, without redefining a conflicting union.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6.
 */

import type { DimensionId } from "../models/ids";

// Re-export the id type so consumers can import it from the registry alongside
// the definitions. This is a re-export, not a redefinition (Req 2.6).
export type { DimensionId } from "../models/ids";

/**
 * The defined "Unknown" member used when a record is missing a value for a
 * dimension used in the active slice. (Req 16.2)
 */
export const UNKNOWN_MEMBER = "Unknown";

/**
 * Definition of one slicing dimension: its id, display name, seed member
 * values, and whether unknown ingested values are appended as new members.
 */
export interface DimensionDefinition {
  /** Stable identifier for the dimension. */
  id: DimensionId;
  /** Human-readable dimension name for UI labels. */
  name: string;
  /** Seed member values; extended at ingest with unknown values. (Req 2.7) */
  members: string[];
  /** Unknown ingested values are appended as new members. (Req 2.7) */
  extensible: true;
}

/**
 * Platform / Form Factor member values covering Connected TV form factors,
 * Mobile form factors, and Desktop Web. (Req 2.1)
 */
export const PLATFORM_MEMBERS: readonly string[] = [
  // Connected TV
  "Tizen",
  "WebOS",
  "Android TV",
  "Apple TV",
  "FireTV",
  // Mobile
  "iOS",
  "Android",
  // Desktop
  "Desktop Web",
];

/**
 * Named telecom ISP member values seeded for the Network & ISP dimension.
 * The dimension supports named ISPs in addition to the connection-type
 * members below. (Req 2.2)
 */
export const NAMED_ISP_MEMBERS: readonly string[] = [
  "Jio",
  "Airtel",
  "Vodafone Idea",
  "BSNL",
  "Comcast Xfinity",
  "AT&T",
  "Verizon",
  "T-Mobile",
  "Spectrum",
];

/**
 * Network & ISP member values: the connection types plus seeded named ISPs.
 * (Req 2.2)
 */
export const NETWORK_MEMBERS: readonly string[] = [
  "Wi-Fi",
  "Cellular 5G",
  "Cellular 4G",
  "Broadband",
  ...NAMED_ISP_MEMBERS,
];

/** CDN Provider member values. (Req 2.3) */
export const CDN_MEMBERS: readonly string[] = [
  "Akamai",
  "Cloudflare",
  "Fastly",
  "AWS CloudFront",
];

/**
 * Geography member value levels for Country, Region or State, and
 * Metropolitan Market. (Req 2.4)
 */
export const GEOGRAPHY_MEMBERS: readonly string[] = [
  "Country",
  "Region",
  "Metro",
];

/** Stream Type member values. (Req 2.5) */
export const STREAM_TYPE_MEMBERS: readonly string[] = [
  "Live Sports/Events",
  "VOD Movies",
  "VOD Series",
  "FAST linear",
];

/**
 * The dimension registry: all five slicing dimensions with their seed members.
 * Every dimension is `extensible`, so any KPI can be filtered, grouped, and
 * aggregated across every defined dimension. (Req 2.1–2.6)
 */
export const DIMENSION_REGISTRY: readonly DimensionDefinition[] = [
  {
    id: "platform",
    name: "Platform / Form Factor",
    members: [...PLATFORM_MEMBERS],
    extensible: true,
  },
  {
    id: "network",
    name: "Network & ISP",
    members: [...NETWORK_MEMBERS],
    extensible: true,
  },
  {
    id: "cdn",
    name: "CDN Provider",
    members: [...CDN_MEMBERS],
    extensible: true,
  },
  {
    id: "geography",
    name: "Geography",
    members: [...GEOGRAPHY_MEMBERS],
    extensible: true,
  },
  {
    id: "streamType",
    name: "Stream Type",
    members: [...STREAM_TYPE_MEMBERS],
    extensible: true,
  },
];

/** Index of dimension definitions by id for O(1) lookup. */
const DIMENSION_BY_ID: Readonly<Record<DimensionId, DimensionDefinition>> =
  Object.fromEntries(
    DIMENSION_REGISTRY.map((d) => [d.id, d]),
  ) as Record<DimensionId, DimensionDefinition>;

/** All defined dimension ids, in registry order. */
export const DIMENSION_IDS: readonly DimensionId[] = DIMENSION_REGISTRY.map(
  (d) => d.id,
);

/** Return the definition for a dimension id. */
export function getDimensionDefinition(id: DimensionId): DimensionDefinition {
  return DIMENSION_BY_ID[id];
}
