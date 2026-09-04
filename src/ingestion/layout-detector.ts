/**
 * LayoutDetector — classifies a parsed file's `SourceLayout` from the set of
 * fuzzy-match results the `FuzzyMatcher` (task 10.2) produces for its headers.
 *
 * The engine supports three source layouts (Req 21.1):
 *
 * - **long** — the app is encoded in a dedicated column (`{ kind: "app" }`),
 *   one row per app-period.
 * - **wide** — the app is encoded in the column *name*: two or more columns
 *   fuzzy-match the **same** canonical KPI and their headers differ only by a
 *   recognized app-suffix token pair (Req 21.2). One source row then fans out
 *   into one record per app downstream.
 * - **file-level** — neither an app column nor app-qualified columns are
 *   present; the user assigns the whole file to an app (Req 21.5). That branch
 *   is handled by the `IngestionModePrompt`, not here — this detector simply
 *   reports "no app columns and no wide grouping" as a `long` default with no
 *   wide grouping, and the mode prompt takes over.
 *
 * Detection is a **default, not a decision** (Req 21.3): the verdict is handed
 * to the mapping modal as an overridable default, together with any per-column
 * app qualifiers it inferred and any ambiguity it found.
 *
 * When a file carries *both* an app column and app-qualified columns, the app
 * column wins and the layout is `long`; the detector reports the ambiguity
 * rather than resolving it silently (Req 21.4).
 *
 * This module is pure: it reads its inputs and returns a verdict. It never
 * mutates inputs, touches the DOM, or reads storage.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4.
 */

import type { CanonicalKPIId } from "@/models/ids";
import type { AppAssignment } from "@/models/records";
import type { SourceLayout } from "@/models/config";

/**
 * A recognized app-suffix token pair. The `a` token maps to `App_A` and the
 * `b` token maps to `App_B` (Req 21.2). Tokens are the trailing segment of a
 * normalized (lowercased, underscore-joined) header.
 */
export interface AppSuffixPair {
  /** Token that identifies App_A, e.g. "a", "app_a", "current". */
  readonly a: string;
  /** Token that identifies App_B, e.g. "b", "app_b", "new". */
  readonly b: string;
}

/**
 * The recognized app-suffix pairs, in the order the design lists them
 * (Req 21.2). The first token of each pair is App_A, the second App_B.
 *
 * Longer, more specific tokens (`app_a`) are matched before shorter ones (`a`)
 * so that a header ending in `_app_a` is attributed to the `app_a`/`app_b`
 * pair rather than being mis-split on the bare `a`/`b` pair.
 */
export const RECOGNIZED_APP_SUFFIX_PAIRS: readonly AppSuffixPair[] = [
  { a: "app_a", b: "app_b" },
  { a: "control", b: "variant" },
  { a: "baseline", b: "candidate" },
  { a: "current", b: "new" },
  { a: "a", b: "b" },
];

/**
 * One column's fuzzy-match result, as far as layout detection is concerned.
 *
 * This is the minimal slice of the `FuzzyMatcher` output the detector needs; a
 * column mapped to something other than a KPI or the app column contributes
 * nothing to layout detection and can be passed with `kpiId: null` and
 * `isAppColumn: false`.
 */
export interface ColumnMatch {
  /** The source header exactly as it appeared in the file. */
  readonly header: string;
  /**
   * The canonical KPI this column fuzzy-matched, or `null` when the column did
   * not map to a KPI (e.g. a dimension, timestamp, or unmapped column).
   */
  readonly kpiId: CanonicalKPIId | null;
  /** True when the column was mapped as the app column (`{ kind: "app" }`). */
  readonly isAppColumn: boolean;
}

/** A single header assigned to an app by its recognized suffix token (Req 21.2). */
export interface AppQualifiedColumn {
  /** The source header. */
  readonly header: string;
  /** The canonical KPI the header matched. */
  readonly kpiId: CanonicalKPIId;
  /** The app the header's suffix token resolves to. */
  readonly app: AppAssignment;
  /** The suffix pair that produced the assignment. */
  readonly pair: AppSuffixPair;
}

/** A KPI matched by two or more columns that differ only by an app suffix. */
export interface WideGroup {
  readonly kpiId: CanonicalKPIId;
  /** The app-qualified columns for this KPI, one per app. */
  readonly columns: readonly AppQualifiedColumn[];
}

/**
 * The detector's verdict, handed to the mapping modal as an overridable default
 * (Req 21.3).
 */
export interface LayoutDetection {
  /** The detected layout default. */
  readonly layout: SourceLayout;
  /**
   * KPI groups that look wide: 2+ columns for the same KPI split by a
   * recognized suffix pair. Non-empty regardless of the final `layout` verdict
   * so the modal can offer the per-column app qualifiers even when the app
   * column wins (Req 21.3, 21.4).
   */
  readonly wideGroups: readonly WideGroup[];
  /**
   * Set when both an app column and app-qualified columns are present. The app
   * column wins (`layout` is `long`) but the ambiguity is reported for the
   * modal to surface (Req 21.4).
   */
  readonly ambiguity?: LayoutAmbiguity;
}

/** An app-column-vs-app-qualified-columns ambiguity (Req 21.4). */
export interface LayoutAmbiguity {
  readonly kind: "app_column_and_qualified_columns";
  /** The header(s) mapped as the app column. */
  readonly appColumns: readonly string[];
  /** The app-qualified headers that were overridden by the app column. */
  readonly qualifiedColumns: readonly string[];
  /** A user-facing description of the conflict. */
  readonly detail: string;
}

/** Normalize a header for suffix matching: lowercase, punctuation → underscore. */
function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * If `normalized` ends with one of the two tokens of a recognized pair, return
 * the app it resolves to, the pair, and the KPI-stem (the header with the token
 * stripped). Returns `null` when no recognized suffix is present.
 *
 * Pairs are tried in {@link RECOGNIZED_APP_SUFFIX_PAIRS} order, longest tokens
 * first, so `_app_a` binds to `app_a`/`app_b` before the bare `a`/`b` pair.
 */
function matchSuffix(
  normalized: string,
): { app: AppAssignment; pair: AppSuffixPair; stem: string } | null {
  for (const pair of RECOGNIZED_APP_SUFFIX_PAIRS) {
    for (const [token, app] of [
      [pair.a, "App_A"],
      [pair.b, "App_B"],
    ] as const) {
      const suffix = `_${token}`;
      if (normalized.endsWith(suffix)) {
        return { app, pair, stem: normalized.slice(0, -suffix.length) };
      }
      // A header that is *exactly* the token (e.g. a column literally named
      // "a") carries no KPI stem and cannot be part of a wide KPI group.
      if (normalized === token) {
        return { app, pair, stem: "" };
      }
    }
  }
  return null;
}

/**
 * Classify a parsed file's source layout from its columns' fuzzy-match results
 * (Req 21.1–21.4).
 *
 * The verdict is a **default** for the mapping modal, not a final decision: the
 * returned `wideGroups` let the modal offer per-column app qualifiers even when
 * the layout is reported as `long`, and any `ambiguity` is surfaced rather than
 * resolved silently (Req 21.3, 21.4).
 *
 * @param columns One `ColumnMatch` per source header.
 * @returns the detected layout, the wide KPI groupings, and any ambiguity.
 */
export function detectLayout(columns: readonly ColumnMatch[]): LayoutDetection {
  const appColumns = columns.filter((c) => c.isAppColumn).map((c) => c.header);

  // Group KPI columns that carry a recognized app suffix by (kpiId, stem).
  // Keying on the stem as well as the KPI guards against two genuinely
  // different columns that happen to match the same KPI without being an
  // app-suffix pair being merged into a spurious wide group.
  const groups = new Map<string, { kpiId: CanonicalKPIId; columns: AppQualifiedColumn[] }>();

  for (const column of columns) {
    if (column.kpiId === null || column.isAppColumn) {
      continue;
    }
    const normalized = normalizeHeader(column.header);
    const suffix = matchSuffix(normalized);
    if (suffix === null || suffix.stem === "") {
      continue;
    }
    const key = `${column.kpiId}\u0000${suffix.stem}`;
    let group = groups.get(key);
    if (!group) {
      group = { kpiId: column.kpiId, columns: [] };
      groups.set(key, group);
    }
    group.columns.push({
      header: column.header,
      kpiId: column.kpiId,
      app: suffix.app,
      pair: suffix.pair,
    });
  }

  // A wide group needs 2+ columns for the same KPI covering both apps.
  const wideGroups: WideGroup[] = [];
  for (const group of groups.values()) {
    const apps = new Set(group.columns.map((c) => c.app));
    if (group.columns.length >= 2 && apps.has("App_A") && apps.has("App_B")) {
      wideGroups.push({ kpiId: group.kpiId, columns: group.columns });
    }
  }

  const hasAppColumn = appColumns.length > 0;
  const hasWide = wideGroups.length > 0;

  // Both present: the app column wins (long), report the ambiguity (Req 21.4).
  if (hasAppColumn && hasWide) {
    const qualifiedColumns = wideGroups.flatMap((g) => g.columns.map((c) => c.header));
    return {
      layout: "long",
      wideGroups,
      ambiguity: {
        kind: "app_column_and_qualified_columns",
        appColumns,
        qualifiedColumns,
        detail:
          `File carries an app column (${appColumns.join(", ")}) and ` +
          `app-qualified columns (${qualifiedColumns.join(", ")}). ` +
          `Using the app column (long layout); review the qualified columns.`,
      },
    };
  }

  // Only wide grouping: classify as wide (Req 21.2).
  if (hasWide) {
    return { layout: "wide", wideGroups };
  }

  // App column present, no wide grouping: plain long layout.
  // Neither present: default to long — the IngestionModePrompt will require a
  // file-level app assignment (Req 21.5). Either way the default is long.
  return { layout: "long", wideGroups: [] };
}
