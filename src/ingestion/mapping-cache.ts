/**
 * MappingCache — persists a confirmed column mapping keyed by a hash of the
 * sorted, normalized source-header set, and pre-populates the mapping modal
 * when a later file yields the same header set (Req 7.6, 7.7; design "Mapping
 * reuse cache").
 *
 * The reuse key is a hash of the **sorted, normalized** header set, so header
 * *order* never matters: a weekly export whose columns are reordered between
 * runs still resolves to the same cached mapping. Normalization reuses the
 * FuzzyMatcher's {@link normalizeHeader} (lowercased, punctuation stripped,
 * camelCase / snake_case split) so cosmetic header variants
 * (`video_start_time` vs `videoStartTime`) hash identically.
 *
 * On confirmation the full decision set is stored — per-column targets
 * (including wide-layout app qualifiers), the resolved layout, the per-column
 * units, and any `fileAppAssignment` — so a recurring file is a one-click
 * confirm.
 *
 * The one decision that is **never** silently reapplied is the file-level app
 * assignment. The same header set is typically reused for *both* apps' files,
 * so blindly reusing the previous `fileAppAssignment` would attribute a file to
 * the wrong app. A cached `fileAppAssignment` is therefore surfaced as a
 * *pre-selected but unconfirmed* default for the modal to re-prompt, rather
 * than baked into the reused mapping (Req 7.7; design "Mapping reuse cache").
 *
 * This module owns only the cache key derivation and the reuse-shaping logic;
 * the actual read/write goes through the injected
 * {@link KPIDataRepository} whose `getColumnMapping` / `saveColumnMapping` are
 * already keyed by `headerSetHash` (task 4.2).
 *
 * Requirements: 7.6, 7.7.
 */

import type { ColumnMapping } from "@/models/config";
import type { AppAssignment } from "@/models/records";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";
import { normalizeHeader } from "./fuzzy-matcher";

/**
 * Compute the reuse key for a set of source headers: a hash of the sorted,
 * normalized header set (Req 7.6, 7.7).
 *
 * Headers are normalized with {@link normalizeHeader}, de-duplicated (a header
 * set is a *set*), and sorted, so the key is independent of the order the
 * columns appeared in the file. Empty normalized headers are dropped so a
 * blank/punctuation-only column never perturbs the key.
 *
 * The hash is a 32-bit FNV-1a folded into an 8-char hex string; a separator
 * that cannot appear in a normalized header (`\u0000`) is inserted between
 * tokens so `["ab","c"]` and `["a","bc"]` cannot collide by concatenation.
 */
export function computeHeaderSetHash(headers: readonly string[]): string {
  const normalized = Array.from(
    new Set(headers.map((h) => normalizeHeader(h)).filter((h) => h.length > 0)),
  ).sort();

  const joined = normalized.join("\u0000");

  // FNV-1a (32-bit). Deterministic, dependency-free, and adequate for a
  // client-side reuse key where the only requirement is that equal header sets
  // map to the same key and differing sets almost never collide.
  let hash = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to an unsigned 32-bit int and render as fixed-width hex.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A cached mapping shaped for reuse in the modal (Req 7.7).
 *
 * The `mapping` is the cached decision set with its `fileAppAssignment`
 * stripped, so nothing app-attributing is silently reapplied. When the cached
 * mapping carried a `fileAppAssignment`, it is surfaced separately as
 * `suggestedFileAppAssignment` — a pre-selected default the modal MUST
 * re-prompt the user to confirm before ingestion.
 */
export interface ReusedMapping {
  /**
   * The cached mapping to pre-populate the modal with: per-column targets,
   * layout, and per-column units. Its `fileAppAssignment` is intentionally
   * absent — see {@link suggestedFileAppAssignment}.
   */
  readonly mapping: ColumnMapping;
  /**
   * The `fileAppAssignment` from the cached mapping, if any, pre-selected in
   * the modal but still requiring explicit user confirmation (Req 7.7).
   * `undefined` when the cached mapping had no file-level app assignment (e.g.
   * a wide-layout or app-column file, where the app is not file-level).
   */
  readonly suggestedFileAppAssignment?: AppAssignment;
}

/**
 * Persist a confirmed column mapping for reuse (Req 7.6).
 *
 * The mapping is stored through the repository keyed by a hash of the sorted,
 * normalized set of its own `headers`, so the persisted key is always
 * consistent with what {@link lookupMapping} derives from a later file's
 * headers. Any `headerSetHash` already on the incoming mapping is overwritten
 * with the freshly derived key so callers cannot persist a mapping under a key
 * that its headers would not resolve to.
 *
 * @param repository the persistence adapter (task 4.2).
 * @param mapping the confirmed mapping to persist.
 * @returns the `headerSetHash` the mapping was stored under.
 */
export async function persistMapping(
  repository: KPIDataRepository,
  mapping: ColumnMapping,
): Promise<string> {
  const headerSetHash = computeHeaderSetHash(mapping.headers);
  await repository.saveColumnMapping({ ...mapping, headerSetHash });
  return headerSetHash;
}

/**
 * Look up a previously confirmed mapping for a file's header set (Req 7.7).
 *
 * Derives the reuse key from the sorted, normalized header set and queries the
 * repository. On a hit, the mapping is shaped for reuse: the `fileAppAssignment`
 * is lifted off the mapping into `suggestedFileAppAssignment` so the modal
 * re-prompts for it rather than silently reapplying it. On a miss, returns
 * `null` and the modal falls back to fresh fuzzy matching.
 *
 * @param repository the persistence adapter (task 4.2).
 * @param headers the parsed file's source headers, in any order.
 * @returns the reuse-shaped mapping, or `null` when no cached mapping matches.
 */
export async function lookupMapping(
  repository: KPIDataRepository,
  headers: readonly string[],
): Promise<ReusedMapping | null> {
  const headerSetHash = computeHeaderSetHash(headers);
  const cached = await repository.getColumnMapping(headerSetHash);
  if (cached === undefined) {
    return null;
  }
  return toReusedMapping(cached);
}

/**
 * Shape a cached mapping for modal reuse: strip the `fileAppAssignment` from the
 * mapping and surface it separately as a pre-selected, still-to-be-confirmed
 * default (Req 7.7).
 */
function toReusedMapping(cached: ColumnMapping): ReusedMapping {
  const { fileAppAssignment, ...rest } = cached;
  return {
    mapping: rest,
    ...(fileAppAssignment !== undefined ? { suggestedFileAppAssignment: fileAppAssignment } : {}),
  };
}
