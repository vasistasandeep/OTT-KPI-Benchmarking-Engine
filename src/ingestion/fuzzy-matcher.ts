/**
 * FuzzyMatcher — normalized header-to-target similarity for column mapping
 * (Req 7.2, 7.3, 7.4, 22.3; design "Fuzzy matching detail").
 *
 * Source headers rarely match a canonical KPI name character-for-character, so
 * the mapper proposes an initial target by scoring each header against every
 * candidate (KPI names, dimension names, and every alias) on a normalized
 * 0.00–1.00 scale. The score is the Sørensen–Dice coefficient over character
 * bigrams of the normalized strings.
 *
 * Two things make qualified headers like `vst_app_a_ms` resolve as well as a
 * bare `vst`:
 *
 *   1. Exact alias hits short-circuit to 1.00 (Req 7.4).
 *   2. Scoring runs in two passes (Req 7.2): the header as-is, and the header
 *      with a recognized trailing app-suffix and/or unit token stripped. The
 *      higher of the two wins, and the stripped tokens become the column's
 *      proposed app qualifier and source unit. A unit token is only recognized
 *      when it is one of the matched KPI's `acceptedUnits` (Req 22.3); an app
 *      token is only recognized as one half of a known pair (Req 21.2), so a
 *      lone `_a` never silently becomes an app qualifier.
 *
 * The best candidate scoring >= 0.80 is auto-selected; below that the column is
 * left unmapped for the user to resolve (Req 7.3).
 */

import type { CanonicalKPIId, DimensionId } from "@/models/ids";
import { KPI_REGISTRY } from "@/registry/kpi-registry";
import { DIMENSION_REGISTRY } from "@/registry/dimensions";
import type { KPIDefinition } from "@/registry/kpi-types";

/** Minimum similarity for a candidate to be auto-selected (Req 7.2, 7.3). */
export const AUTO_MAP_THRESHOLD = 0.8;

/**
 * Recognized app-suffix token pairs (Req 21.2). Each pair maps its first token
 * to App_A and its second to App_B. A token is only treated as an app suffix
 * when it belongs to one of these pairs, and matching is symmetric — either
 * member of a pair identifies the pair.
 */
export const APP_SUFFIX_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["app_a", "app_b"],
  ["appa", "appb"],
  ["a", "b"],
];

/** Which app a stripped app-suffix token resolves to. */
export type AppAssignment = "App_A" | "App_B";

/** A candidate mapping target: a KPI or a dimension. */
export type MatchTargetKind = "kpi" | "dimension";

/**
 * A single scoring candidate derived from the registries: a canonical name or
 * an alias, tagged with the target it resolves to.
 */
interface Candidate {
  /** The normalized text that gets scored against the normalized header. */
  normalizedText: string;
  /** Whether this candidate was contributed as an exact alias (Req 7.4). */
  isAlias: boolean;
  kind: MatchTargetKind;
  kpiId?: CanonicalKPIId;
  dimensionId?: DimensionId;
}

/** The proposed target for a header. */
export interface MatchTarget {
  kind: MatchTargetKind;
  kpiId?: CanonicalKPIId;
  dimensionId?: DimensionId;
}

/** The result of matching a single header. */
export interface FuzzyMatchResult {
  /** Best score found across both passes, in [0, 1]. */
  score: number;
  /**
   * The auto-selected target, or `null` when no candidate reached
   * `AUTO_MAP_THRESHOLD` (Req 7.3).
   */
  target: MatchTarget | null;
  /**
   * App qualifier stripped in the second pass, when the winning score came
   * from stripping a recognized app-suffix token (Req 21.2).
   */
  appAssignment?: AppAssignment;
  /**
   * Source unit token stripped in the second pass, recognized only within the
   * matched KPI's `acceptedUnits` (Req 22.3).
   */
  unitToken?: string;
}

// ---------------------------------------------------------------------------
// Normalization (design: lowercased, non-alphanumeric stripped, camelCase and
// snake_case split)
// ---------------------------------------------------------------------------

/**
 * Split a raw header into lowercase alphanumeric tokens, breaking on
 * punctuation, whitespace, snake_case underscores, and camelCase / letter–digit
 * boundaries.
 */
export function tokenizeHeader(header: string): string[] {
  return (
    header
      // camelCase -> camel Case
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      // letter/digit boundaries: vst95 -> vst 95, p95x -> stays split at digit run
      .replace(/([A-Za-z])(\d)/g, "$1 $2")
      .replace(/(\d)([A-Za-z])/g, "$1 $2")
      .toLowerCase()
      // any run of non-alphanumeric characters is a separator
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0)
  );
}

/**
 * Normalize a header to a single comparison string: tokenized, then joined
 * without separators so bigrams flow across the original token boundaries. This
 * makes `video_start_time` and `videoStartTime` normalize identically.
 */
export function normalizeHeader(header: string): string {
  return tokenizeHeader(header).join("");
}

// ---------------------------------------------------------------------------
// Sørensen–Dice bigram similarity
// ---------------------------------------------------------------------------

/** Build the multiset of adjacent character bigrams of a string. */
function bigrams(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  return counts;
}

/**
 * Sørensen–Dice coefficient over character bigrams, in [0, 1] and symmetric.
 *
 * Two identical strings score 1; strings sharing no bigram score 0. Degenerate
 * inputs shorter than two characters have no bigrams: identical single
 * characters (or two empty strings) score 1, otherwise 0.
 */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);

  let intersection = 0;
  for (const [bg, aCount] of aBigrams) {
    const bCount = bBigrams.get(bg);
    if (bCount !== undefined) {
      intersection += Math.min(aCount, bCount);
    }
  }

  const total = a.length - 1 + (b.length - 1);
  return (2 * intersection) / total;
}

// ---------------------------------------------------------------------------
// Candidate set (KPI names, dimension names, and aliases)
// ---------------------------------------------------------------------------

/**
 * Build every scoring candidate from the registries once. Aliases are tagged
 * so an exact alias hit can short-circuit to 1.00 (Req 7.4).
 */
function buildCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  for (const kpi of KPI_REGISTRY) {
    candidates.push({
      normalizedText: normalizeHeader(kpi.name),
      isAlias: false,
      kind: "kpi",
      kpiId: kpi.id,
    });
    for (const alias of kpi.aliases) {
      candidates.push({
        normalizedText: normalizeHeader(alias),
        isAlias: true,
        kind: "kpi",
        kpiId: kpi.id,
      });
    }
  }

  for (const dim of DIMENSION_REGISTRY) {
    candidates.push({
      normalizedText: normalizeHeader(dim.name),
      isAlias: false,
      kind: "dimension",
      dimensionId: dim.id,
    });
  }

  return candidates;
}

/** Cached candidate set; the registries are static for the app's lifetime. */
const CANDIDATES = buildCandidates();

/** Alias index: normalized alias text -> KPI id, for exact-hit short-circuit. */
const ALIAS_INDEX: ReadonlyMap<string, CanonicalKPIId> = (() => {
  const m = new Map<string, CanonicalKPIId>();
  for (const kpi of KPI_REGISTRY) {
    for (const alias of kpi.aliases) {
      m.set(normalizeHeader(alias), kpi.id);
    }
  }
  return m;
})();

// ---------------------------------------------------------------------------
// Suffix stripping (second pass)
// ---------------------------------------------------------------------------

/**
 * Resolve a token to an app assignment if it is a member of a recognized pair
 * (Req 21.2). Returns `undefined` for anything else so a lone `_a` is not an
 * app qualifier.
 */
function appAssignmentForToken(token: string): AppAssignment | undefined {
  for (const [a, b] of APP_SUFFIX_PAIRS) {
    if (token === a) return "App_A";
    if (token === b) return "App_B";
  }
  return undefined;
}

/** The set of all accepted-unit tokens across every KPI, normalized for lookup. */
const KNOWN_UNIT_TOKENS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const kpi of KPI_REGISTRY) {
    for (const u of kpi.acceptedUnits) {
      s.add(normalizeHeader(u.token));
    }
  }
  return s;
})();

/** Whether a normalized token is a recognized unit for the given KPI (Req 22.3). */
function unitTokenForKPI(token: string, kpi: KPIDefinition): string | undefined {
  const match = kpi.acceptedUnits.find((u) => normalizeHeader(u.token) === token);
  return match?.token;
}

/**
 * The result of the suffix-stripping pass: the reduced token list plus whatever
 * app and unit tokens were peeled off the tail.
 */
interface StrippedHeader {
  /** Tokens remaining after recognized app/unit tail tokens were removed. */
  coreTokens: string[];
  appToken?: string;
  unitToken?: string;
}

/**
 * Peel recognized app-suffix and unit tokens off the tail of a tokenized
 * header, from right to left. Handles multi-word app tokens like `app a`
 * (from `app_a`) by also collapsing a trailing `app` marker.
 *
 * Recognition here is deliberately permissive about what *could* be an app or
 * unit token; the caller re-validates the unit against the matched KPI's
 * `acceptedUnits` (Req 22.3) and the app token against known pairs (Req 21.2)
 * before surfacing them, so this never over-claims.
 */
function stripTailTokens(tokens: string[]): StrippedHeader {
  const core = [...tokens];
  let appToken: string | undefined;
  let unitToken: string | undefined;

  // Peel a trailing unit token, e.g. ["vst","ms"] -> unit "ms".
  if (core.length > 1 && KNOWN_UNIT_TOKENS.has(core[core.length - 1])) {
    unitToken = core.pop();
  }

  // Peel a trailing app token. Recognized forms:
  //   ["app","a"]  -> "app_a"  (collapse the "app" marker + suffix letter)
  //   ["appa"]     -> "appa"
  //   ["a"]        -> "a"
  if (core.length > 1) {
    const last = core[core.length - 1];
    const prev = core[core.length - 2];
    if (prev === "app" && appAssignmentForToken(`app_${last}`)) {
      // "app a" tail collapses to the canonical "app_a" pair token.
      appToken = `app_${last}`;
      core.pop();
      core.pop();
    } else if (appAssignmentForToken(last)) {
      appToken = last;
      core.pop();
    }
  }

  return { coreTokens: core, appToken, unitToken };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Score a normalized string against every candidate; return the best. */
function bestCandidate(normalized: string): { candidate: Candidate; score: number } | null {
  if (normalized.length === 0) return null;

  let best: { candidate: Candidate; score: number } | null = null;
  for (const candidate of CANDIDATES) {
    const score = diceSimilarity(normalized, candidate.normalizedText);
    if (best === null || score > best.score) {
      best = { candidate, score };
    }
  }
  return best;
}

/** Turn a winning candidate into the public `MatchTarget` shape. */
function toTarget(candidate: Candidate): MatchTarget {
  return candidate.kind === "kpi"
    ? { kind: "kpi", kpiId: candidate.kpiId }
    : { kind: "dimension", dimensionId: candidate.dimensionId };
}

/**
 * Match a single source header to its best mapping target.
 *
 * Runs the exact-alias short-circuit first, then the two scoring passes, and
 * returns the higher-scoring pass. When the winning pass stripped app/unit
 * tokens, those are validated (unit against the matched KPI's `acceptedUnits`,
 * app against known pairs) and surfaced on the result.
 */
export function matchHeader(header: string): FuzzyMatchResult {
  const tokens = tokenizeHeader(header);
  const normalized = tokens.join("");

  // Pass 0: exact alias hit on the whole header scores 1.00 (Req 7.4).
  const aliasHit = ALIAS_INDEX.get(normalized);
  if (aliasHit !== undefined) {
    return { score: 1, target: { kind: "kpi", kpiId: aliasHit } };
  }

  // Pass 1: score the header as-is.
  const asIs = bestCandidate(normalized);

  // Pass 2: strip recognized trailing app/unit tokens, then score the core.
  const stripped = stripTailTokens(tokens);
  const strippedNormalized = stripped.coreTokens.join("");
  const strippedBest =
    strippedNormalized.length > 0 && strippedNormalized !== normalized
      ? bestCandidate(strippedNormalized)
      : null;

  // An exact alias hit on the stripped core also scores 1.00 (Req 7.4), so a
  // qualified header like `vst_ms` resolves via its bare alias `vst`.
  const strippedAliasHit = ALIAS_INDEX.get(strippedNormalized);

  // Pick the higher-scoring pass. The stripped pass carries the app/unit tokens.
  let useStripped = false;
  let score: number;
  let candidate: Candidate | null;

  if (strippedAliasHit !== undefined && (asIs === null || asIs.score < 1)) {
    useStripped = true;
    score = 1;
    candidate = {
      normalizedText: strippedNormalized,
      isAlias: true,
      kind: "kpi",
      kpiId: strippedAliasHit,
    };
  } else {
    const asIsScore = asIs?.score ?? -1;
    const strippedScore = strippedBest?.score ?? -1;
    if (strippedScore > asIsScore) {
      useStripped = true;
      score = strippedScore;
      candidate = strippedBest!.candidate;
    } else {
      score = Math.max(asIsScore, 0);
      candidate = asIs?.candidate ?? null;
    }
  }

  if (candidate === null || score < AUTO_MAP_THRESHOLD) {
    return { score: Math.max(score, 0), target: null };
  }

  const target = toTarget(candidate);
  const result: FuzzyMatchResult = { score, target };

  // Surface stripped app/unit tokens only when the stripped pass won and only
  // when they re-validate against the matched target.
  if (useStripped) {
    if (stripped.appToken) {
      const app = appAssignmentForToken(stripped.appToken);
      if (app) result.appAssignment = app;
    }
    if (stripped.unitToken && target.kind === "kpi" && target.kpiId) {
      const kpi = KPI_REGISTRY.find((k) => k.id === target.kpiId);
      if (kpi) {
        const unit = unitTokenForKPI(stripped.unitToken, kpi);
        if (unit) result.unitToken = unit;
      }
    }
  }

  return result;
}
