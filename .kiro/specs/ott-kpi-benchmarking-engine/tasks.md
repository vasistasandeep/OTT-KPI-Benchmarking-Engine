# Implementation Plan: OTT KPI Benchmarking Engine

## Overview

This plan builds the OTT KPI Benchmarking Engine bottom-up so the numeric core is proven before any UI depends on it. It starts with project scaffolding (Vite + React 18 + TypeScript + Tailwind + Shadcn, with Vitest and fast-check wired in), then defines data models and the KPI/dimension registries, then the persistence layer behind `KPIDataRepository`, then the pure aggregation engine (bucketing, grouping, percentiles, weighted averages, distinct counts, derived KPIs, aggregability guard, delta/RAG, confidence gate), then the Web Worker offload, then the ingestion pipeline (parser, layout detector, fuzzy matcher, unit/timestamp normalizers, mapping modal, caches), then manual entry and the mock seeder, then the Zustand stores, then the dashboard modules, and finally accessibility, privacy hardening, and performance validation.

Each of the 24 correctness properties from the design is implemented as a single `fast-check` property-based test running at least 100 cases (`{ numRuns: 100 }`), tagged with the comment `// Feature: ott-kpi-benchmarking-engine, Property {number}: {property_text}`, and sequenced immediately after the code it validates. Property, unit, integration, accessibility, snapshot, and performance test tasks are marked optional with `*`; the core implementation path is required.

The stack is fixed by the design: React 18 + TypeScript (Vite SPA), Tailwind CSS + Shadcn UI + Lucide, Apache ECharts, TanStack Table/Virtual, Papaparse + SheetJS, Dexie.js over IndexedDB, Zustand, and a Comlink Web Worker.

## Tasks

- [x] 1. Scaffold the project and test tooling
  - [x] 1.1 Initialize the Vite + React 18 + TypeScript SPA
    - Create the Vite React-TS project, configure `tsconfig` with `strict` mode and path aliases (`@/`)
    - Add Tailwind CSS and configure a dark-theme base layer; install and initialize Shadcn UI and Lucide icons
    - Add ECharts, TanStack Table + TanStack Virtual, Papaparse, SheetJS (`xlsx`), Dexie.js, Zustand, and Comlink as dependencies (pinned versions)
    - Create the source directory layout: `src/models`, `src/registry`, `src/repository`, `src/engine`, `src/worker`, `src/ingestion`, `src/stores`, `src/components`, `src/lib`, `src/test`
    - _Requirements: 3.1, 3.4, 15.1_

  - [x] 1.2 Configure Vitest, fast-check, and the accessibility/DB test harness
    - Add Vitest with a jsdom environment and a `test` script using `vitest run` (single-run, not watch)
    - Add `fast-check`, `@testing-library/react`, `jest-axe` (axe), and `fake-indexeddb`
    - Create a shared test setup file registering jsdom matchers and `fake-indexeddb/auto`
    - Add a `test/arbitraries.ts` placeholder module that will export the custom fast-check arbitraries
    - _Requirements: 3.2, 17.1_

- [x] 2. Define core data models and shared types
  - [x] 2.1 Implement the core record, dataset, and sentinel type definitions
    - Define `IngestionMode`, `AppAssignment`, `SourceType`, `NO_DATA`, `NOT_AGGREGABLE`, `Sentinel`, `Numeric`
    - Define `KPIRecord`, `TimeBucket`, `DataQualityAdvisory`, `RawSessionFields`, `DatasetMeta`, `Dataset`
    - Define `RejectedRecord`, `AggregatedKPIValue`, `AggregatedResultSet`, `RAGStatus`, `SuppressionReason`, `ComparisonResult`, `ComparisonResultSet`, `FilterSlice`
    - Define `SLAConfig`, `Aggregability`, `QuotaEstimate`, `RetentionPolicy`, `ColumnMapping`, `MappingTarget`, `SourceLayout`
    - _Requirements: 1.1, 3.1, 5.5, 5.8, 11.3, 16.1, 23.4, 25.1, 26.7_

- [x] 3. Build the KPI taxonomy and dimension registries
  - [x] 3.1 Implement the KPI taxonomy registry
    - Define `Pillar`, `Directionality`, `AggregationKind`, `UnitSpec`, `KPIDerivation`, `KPIDefinition`, `CanonicalKPIId`
    - Seed all KPIs across the four pillars with name, pillar, directionality, `unit`/`canonicalUnit`, `acceptedUnits` (with conversion factors), `defaultSLA`, `validRange`, `aggregation` kind, `derived` (Stickiness = DAU ÷ MAU × 100), `aliases`, `percentileRanks`, and `rawModeComputable`
    - Encode the units table (VST→s, latency→ms, bitrate→Mbps, watch time→hours, session duration→min, percentages→%, rebuffer rate→events/hour, ARPU→USD, distinct counts identity)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 22.1, 22.2, 24.1_

  - [x] 3.2 Write the KPI registry shape snapshot test
    - Assert every KPI declares a `canonicalUnit`, a non-empty `acceptedUnits` that includes its canonical unit at factor 1, an `aggregation` kind, and a `rawModeComputable` flag; conditional KPIs name their required session fields
    - _Requirements: 1.1, 1.2, 22.1_

  - [x] 3.3 Implement the dimension registry
    - Define `DimensionId`, `DimensionDefinition`, `UNKNOWN_MEMBER`; seed members for platform, network (+ named ISPs), CDN, geography (country/region/metro), and stream type; mark all dimensions extensible
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 4. Implement the persistence layer behind KPIDataRepository
  - [x] 4.1 Define the KPIDataRepository interface
    - Declare all dataset, record, quota/retention, and configuration methods exactly as specified in the design
    - _Requirements: 3.1_

  - [x] 4.2 Implement DexieKPIRepository over IndexedDB
    - Define the Dexie schema (`datasets`, `records`, `slaConfig`, `mappings`, `retention`, `appState`); index `records` by `datasetId`; read records in chunks
    - Implement dataset CRUD (with duplicate-name rejection on create/rename), chunked `appendRecords`, `getRecords`, `updateRecord`, `deleteRecord`, active-dataset get/set, SLA config get/save, and column-mapping get/save keyed by header-set hash
    - Wrap every write so a failure surfaces a notification while the in-memory dataset is preserved
    - Implement graceful incognito/private-browsing fallback: catch IndexedDB open/quota exceptions on boot and degrade to an in-memory `Map` storage adapter that still implements the full `KPIDataRepository` interface, with a visual UI advisory banner that data will not persist across sessions
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 7.6, 14.2, 19.7_

  - [x] 4.3 Implement the quota and retention guard
    - Pre-flight `estimateQuota()` via `navigator.storage.estimate()` and refuse writes projected to exceed remaining quota (naming dataset + shortfall)
    - Request persistent storage once on first save via `requestPersistentStorage()`; record a `false` result as an advisory
    - Roll back a chunked append inside one transaction on `QuotaExceededError`, preserving persisted and in-memory data
    - Implement `getRetentionPolicy`/`saveRetentionPolicy`; return a `RetentionLimitReached` outcome (never prune silently) when a ceiling is reached
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7_

  - [x] 4.4 Write the persistence round-trip property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 16: For any dataset, SLA configuration, or column mapping, saving it through the repository and then loading it back yields a deeply equal object.`
    - Run against `fake-indexeddb` with `{ numRuns: 100 }`
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 4.5 Write example tests for persistence error and lifecycle paths
    - Persistence-write-failure notification with a mocked failing repository (3.5); duplicate dataset name rejection (19.7); dataset deletion promotion and demo fallback (3.6, 19.8, 19.9)
    - _Requirements: 3.5, 3.6, 19.7, 19.8, 19.9_

  - [x] 4.6 Write the private-browsing fallback test
    - Assert the in-memory `Map` adapter transparently handles dataset, record, and config CRUD when IndexedDB throws on initialization, and that the advisory-banner state is set
    - _Requirements: 3.5_

- [x] 5. Implement the pure aggregation engine — bucketing and grouping
  - [x] 5.1 Implement `bucketTimestamp` (total UTC bucketing)
    - Assign each record exactly one `hourUtc` and one `dayUtc` (day = UTC calendar day containing the hour); never zero or two buckets
    - _Requirements: 26.5_

  - [x] 5.2 Write the bucketing-and-rollup property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 21: For any record with a parseable timestamp and any source offset, bucketing assigns it exactly one UTC hour bucket and exactly one UTC day bucket, the day bucket is the UTC calendar day containing the hour bucket, and no record is assigned to zero or to two buckets; and for any set of hourly records, rolling them into their UTC day and then aggregating equals aggregating the day's records directly using the KPI's own aggregation kind.`
    - Use `arbTimestamp` (offsets, naive values, DST-sensitive local times, year boundaries); `{ numRuns: 100 }`
    - _Requirements: 26.5, 26.6, 26.7_

  - [x] 5.3 Implement `groupRecords` with Unknown-member handling
    - Partition valid records by `(app, timePeriod, dimension tags)`; place records missing a sliced dimension under `"Unknown"`
    - _Requirements: 5.6, 16.2_

  - [x] 5.4 Write the grouping-partition property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 7: For any set of records, grouping by (app, timePeriod, dimension tags) produces disjoint groups whose union is exactly the set of valid records — no record is lost or duplicated — and any record missing a sliced dimension is placed in that dimension's "Unknown" group.`
    - `{ numRuns: 100 }`
    - _Requirements: 5.6, 16.2_

- [x] 6. Implement the pure aggregation engine — numeric formulas
  - [x] 6.1 Implement `percentile` (linear interpolation between nearest ranks)
    - Empty input → `NO_DATA`; otherwise fractional-rank interpolation yielding exact values at ranks and monotonic non-decreasing values as `p` increases
    - _Requirements: 5.4, 5.8_

  - [x] 6.2 Write the percentile monotonicity-and-bounds property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 1: For any non-empty list of non-negative latency values, the computed percentiles satisfy min(values) <= P50 <= P90 <= P95 <= max(values), and for an empty list every percentile is the NO_DATA sentinel.`
    - `{ numRuns: 100 }`
    - _Requirements: 5.4, 5.8_

  - [x] 6.3 Write the percentile interpolation-exactness property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 2: For any non-empty sorted list, the linear-interpolation percentile at a rank that lands exactly on an element index equals that element, and the interpolated value never falls outside the two nearest neighboring values.`
    - `{ numRuns: 100 }`
    - _Requirements: 5.4_

  - [x] 6.4 Implement `rebufferRatio` and `vsfRate`
    - `rebufferRatio = 100 * sum(bufferingMs) / (sum(playTimeMs) + sum(bufferingMs))`, rounded to 2 decimals; zero denominator → `NO_DATA`
    - `vsfRate = 100 * sum(startFailure) / sum(playbackAttempt)`, rounded to 2 decimals; zero denominator → `NO_DATA`
    - _Requirements: 5.2, 5.3, 5.5, 16.1_

  - [x] 6.5 Write the rebuffer-ratio property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 3: For any group of raw sessions with non-negative buffering and play-time milliseconds, the Rebuffer Ratio equals 100 * sum(buffering) / (sum(playTime) + sum(buffering)) rounded to 2 decimals and lies in [0, 100]; when sum(playTime) + sum(buffering) == 0 the result is exactly NO_DATA.`
    - Use `arbSession`; `{ numRuns: 100 }`
    - _Requirements: 5.2, 5.5_

  - [x] 6.6 Write the VSF-rate property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 4: For any group of raw sessions where each startFailure <= playbackAttempt and both are non-negative, the VSF rate equals 100 * sum(startFailure) / sum(playbackAttempt) rounded to 2 decimals and lies in [0, 100]; when sum(playbackAttempt) == 0 the result is exactly NO_DATA.`
    - Use `arbSession`; `{ numRuns: 100 }`
    - _Requirements: 5.3, 5.5_

  - [x] 6.7 Write the zero-divisor sentinel property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 5: For any aggregation input whose divisor evaluates to zero, the affected KPI value is exactly the defined NO_DATA sentinel and is never NaN, Infinity, or a thrown error, and the same sentinel is used consistently across all affected KPIs.`
    - `{ numRuns: 100 }`
    - _Requirements: 5.5, 16.1_

  - [x] 6.8 Implement `weightedAverage` with arithmetic fallback
    - Weighted mean when all weights present and `sum(w) > 0` (`weighted = true`); unweighted mean otherwise (`weighted = false`, raise unweighted advisory); empty input → `NO_DATA`
    - _Requirements: 20.1, 20.2, 20.3, 20.4_

  - [x] 6.9 Write the weighted-average convex-combination property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 6: For any non-empty list of values with non-negative weights whose sum is positive, the weighted average lies within [min(values), max(values)] and equals sum(vi·wi) / sum(wi); when weights are absent it equals the unweighted arithmetic mean sum(vi)/n, is still within [min, max], and the result is flagged weighted = false.`
    - Use `arbAggRow`; `{ numRuns: 100 }`
    - _Requirements: 20.1, 20.2, 20.3, 20.4_

  - [x] 6.10 Implement per-KPI raw-mode compute functions and record rejection
    - Implement the raw-mode coverage-matrix formulas (rebuffer rate ratio, EBVS, avg rendered bitrate watch-time-weighted, downshift frequency, total watch time, avg session duration, completion quartiles, browse-to-play, ad metrics, CDN cache hit ratio) plus `sum` and `ratio` kinds
    - Implement record rejection: reject raw records with missing required, non-numeric, or negative fields (with reason); exclude non-numeric pre-aggregated field values and report them
    - Emit `NO_DATA` with a specific reason for KPIs not derivable from the mapped session fields
    - _Requirements: 4.3, 5.1, 5.7, 16.1_

  - [x] 6.11 Write the rejected-records property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 8: For any mix of valid and invalid raw records (invalid = missing required field, non-numeric, or negative), the KPI computed over the full set equals the KPI computed over the valid subset alone, and the count of rejected records equals the count of invalid records.`
    - Use `arbSession` with tunable validity; `{ numRuns: 100 }`
    - _Requirements: 5.7, 4.3_

  - [x] 6.12 Implement completion-quartile rates and monotonicity handling
    - Compute `rate(q) = count(quartileReached >= q) / count(sessions started)` per quartile; empty sessions → `NO_DATA` for all four; retain (never drop) pre-aggregated rows that violate ordering and raise a `NON_MONOTONIC_QUARTILES` advisory
    - _Requirements: 1.4, 22.8, 22.9_

  - [x] 6.13 Write the completion-quartile monotonicity property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 24: For any set of valid raw sessions, the computed Content Completion Rates satisfy rate(25%) >= rate(50%) >= rate(75%) >= rate(100%), and each rate lies in [0, 100]; an empty set of sessions yields NO_DATA for all four quartiles rather than a violating result.`
    - Use arbitrary `quartileReached` distributions; `{ numRuns: 100 }`
    - _Requirements: 22.9, 1.4_

- [x] 7. Implement aggregability guard, distinct counts, and derived KPIs
  - [x] 7.1 Implement `distinctCount` and the aggregability guard
    - Raw mode with mapped `userId`: distinct users per group, computed directly from the slice's sessions, never assembled from smaller groups; `sessions == 0` → `NO_DATA`; no mapped `userId` → `NO_DATA` with the "requires a mapped userId column" reason
    - Pre-aggregated unique counts and percentiles: display only at the ingested granularity; `resolveAggregability` resolves any slice requiring a cross-bucket/segment merge to `NOT_AGGREGABLE`; never sum or average
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7_

  - [x] 7.2 Write the unique-count dedupe / non-combination property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 19: For any group of raw sessions with mapped user identifiers, the distinct-count KPI equals the number of distinct user identifiers in the group, is unchanged by duplicating any session row for a user already present, and never exceeds the number of distinct users in the input; and for any set of pre-aggregated unique-count records spanning more than one bucket or dimension segment, the aggregate for a slice requiring their combination is exactly NOT_AGGREGABLE and never equals their sum or their mean.`
    - Use `arbSession` with repeated user identifiers and multi-segment pre-aggregated unique counts; `{ numRuns: 100 }`
    - _Requirements: 23.1, 23.3, 23.4_

  - [x] 7.3 Write the percentile-never-averaged property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 20: For any set of pre-aggregated percentile values drawn from two or more groups, a slice that requires merging them yields exactly NOT_AGGREGABLE, and the engine produces no numeric result for that slice — in particular never the arithmetic mean, and never the volume-weighted mean, of the group percentile values; in raw-session mode the same slice instead yields a percentile recomputed from the union of the underlying raw values.`
    - Use multi-group percentile sets whose mean is computable so the test asserts the engine does not return it; `{ numRuns: 100 }`
    - _Requirements: 23.4, 23.6, 23.7_

  - [x] 7.4 Implement `resolveDerived` (ratio-of-aggregates)
    - Compute Stickiness = `100 * aggregate(DAU) / aggregate(MAU)` only after both operands are aggregated for the slice; never average per-group ratios; inherit an operand's `NO_DATA`/`NOT_AGGREGABLE` sentinel and name the responsible operand; zero denominator → `NO_DATA`
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 16.1_

  - [x] 7.5 Write the derived-ratio property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 22: For any set of operand groups, a derived ratio KPI for a slice equals the ratio of its operands' aggregates over that slice; whenever those groups are unequally weighted and their per-group ratios differ, the computed value differs from the arithmetic mean of the per-group ratios, confirming the engine takes the ratio-of-aggregates path and not the mean-of-ratios path; and if either operand aggregate is NO_DATA or NOT_AGGREGABLE, the derived value is exactly that same sentinel.`
    - Use operand groups with deliberately unequal weights; `{ numRuns: 100 }`
    - _Requirements: 24.2, 24.3, 24.4_

- [x] 8. Implement the comparator (delta, RAG, confidence gate)
  - [x] 8.1 Implement `computeDelta` and `classifyRAG` with sentinel and confidence gates
    - `absoluteDelta = appB - appA`; `percentDelta = "N/A"` when `appA == 0` else `100*(appB-appA)/appA` rounded to 2 decimals
    - Gate 1 (sentinels): `NO_DATA`/`NOT_AGGREGABLE` → `NoData` RAG with the matching `suppressionReason`, excluded from delta/RAG
    - Gate 2 (min sample size): if either app's contributing volume < `minSampleSize` → `LowConfidence` (values and both deltas still shown, counts + threshold reported); `minSampleSize == 0` disables the gate; use summed `volumeWeight` when present
    - Directionality-aware Amber/Green/Red classification against the variance band, including the `appA == 0` absolute-sign path
    - _Requirements: 11.3, 11.4, 11.5, 11.6, 16.5, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.11_

  - [x] 8.2 Write the delta-identities property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 9: For any finite App_A and App_B values, absoluteDelta == appB - appA; when appA != 0, percentDelta == 100*(appB-appA)/appA rounded to 2 decimals and sign(percentDelta) == sign(absoluteDelta); when appA == 0, percentDelta is "N/A" while absoluteDelta is still computed.`
    - `{ numRuns: 100 }`
    - _Requirements: 11.3, 11.4_

  - [x] 8.3 Write the RAG variance-band/directionality property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 10: For any finite appA > 0, appB, positive variance band, and directionality: if abs(percentDelta) <= band the status is Amber; otherwise the status is Green when the change is an improvement per directionality and Red when it is a degradation. Flipping the directionality (holding values and band fixed) swaps Green <-> Red and leaves Amber unchanged.`
    - `{ numRuns: 100 }`
    - _Requirements: 11.5, 11.6_

  - [x] 8.4 Write the no-data-propagation property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 11: For any comparison in which either App_A or App_B value is NO_DATA, the resulting RAG status is NoData and no finite delta is reported for that comparison.`
    - `{ numRuns: 100 }`
    - _Requirements: 16.5_

  - [x] 8.5 Write the thin-sample confidence-gate property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 23: For any pair of App_A and App_B values, any directionality, any positive variance band, any non-negative minimum sample size, and any contributing record counts: if either app's contributing count is below the minimum sample size, the status is exactly LowConfidence and is never Green or Red, while the values and both deltas are still computed and reported; and if both counts are at or above the minimum, the status is determined solely by the existing variance-band and directionality rules, unchanged by the counts.`
    - Use contributing counts straddling the threshold; `{ numRuns: 100 }`
    - _Requirements: 25.4, 25.6, 25.11_

  - [x] 8.6 Implement heatmap winner determination
    - Directionality-aware winner; equal → neutral; either `NO_DATA` → no-data cell; either `NOT_AGGREGABLE` → not-aggregable cell; either app below `minSampleSize` → low-confidence with no winner
    - _Requirements: 12.2, 12.5, 23.4, 25.8, 25.9_

  - [x] 8.7 Write the winner-determination property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 12: For any pair of finite App_A / App_B values and a directionality, the heatmap winner is the app with the better value per that directionality; equal values yield a neutral (no-winner) result; flipping the directionality on distinct values flips the winner; and if either value is NO_DATA the cell is no-data.`
    - `{ numRuns: 100 }`
    - _Requirements: 12.2, 12.5_

  - [x] 8.8 Assemble the AggregationEngine with fixed execution order
    - Implement `aggregate` (bucket → group → per-group compute → resolveAggregability → resolveDerived) and `compare` (delta → confidence gate → RAG); build `AggregatedResultSet` and `ComparisonResultSet`; aggregate each app independently on unequal counts
    - _Requirements: 5.6, 16.3, 24.2_

- [x] 9. Implement the Web Worker aggregation offload
  - [x] 9.1 Implement the Web Worker and WorkerAggregationEngine
    - Wrap the pure engine in a dedicated worker exposed via Comlink; implement `WorkerAggregationEngine` behind the same `AggregationEngine` interface; emit progress messages
    - Implement an environment-aware execution switch (a `typeof Worker !== 'undefined'` check): automatically fall back to synchronous in-thread processing when running in Vitest/jsdom or any environment lacking Web Worker support, so the engine and its tests run identically with or without a worker
    - Trigger background worker execution when `mode === Raw_Session && records.length > 25000`, preserving 60 FPS main-thread responsiveness; otherwise run synchronously
    - _Requirements: 17.2, 17.3, 17.4_

- [x] 10. Implement ingestion — parsing, layout, fuzzy matching, and normalization
  - [x] 10.1 Implement FileParser
    - Route by extension to Papaparse / SheetJS / `JSON.parse`; return `ParsedFile { headers, rows, sampleValues }`; throw `ParseError` with file name + reason on failure
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 10.2 Implement FuzzyMatcher with app/unit suffix stripping
    - Normalize headers (lowercase, strip punctuation, split camel/snake); score by Sørensen–Dice bigram similarity in `[0,1]`; two-pass scoring (as-is, then app/unit-suffix stripped) taking the higher; exact alias → 1.00; auto-select best `>= 0.80` else leave unmapped; recognize unit tokens only within the KPI's `acceptedUnits` and app tokens only as recognized pairs
    - _Requirements: 7.2, 7.3, 7.4, 22.3_

  - [x] 10.3 Write the fuzzy-similarity property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 14: For any pair of header strings, the similarity score lies in [0.00, 1.00] and is symmetric; an exact alias match scores 1.00 and is always proposed; and an auto-mapping is proposed only when the best candidate score is >= 0.80, otherwise the column is left unmapped.`
    - Use `arbHeader`; `{ numRuns: 100 }`
    - _Requirements: 7.2, 7.3, 7.4_

  - [x] 10.4 Implement LayoutDetector
    - Classify `wide` when 2+ columns fuzzy-match the same KPI differing only by a recognized app-suffix pair (`_a`/`_b`, `_app_a`/`_app_b`, `_current`/`_new`, `_control`/`_variant`, `_baseline`/`_candidate`), first token → App_A, second → App_B; prefer the app column (`long`) and report ambiguity when both present; expose as a user-overridable default
    - _Requirements: 21.1, 21.2, 21.3, 21.4_

  - [x] 10.5 Write example tests for layout detection
    - Table-driven over every recognized and unrecognized app-suffix pattern plus the app-column-wins ambiguity case
    - _Requirements: 21.2, 21.3, 21.4_

  - [x] 10.6 Implement UnitNormalizer with inference and fallback
    - Infer source unit from the header token (restricted to the KPI's `acceptedUnits`); multiply each value by the resolved `UnitSpec.factor` to canonical unit before persistence; when no unit inferable, default to canonical unit and raise an `ASSUMED_UNIT` advisory (ingestion proceeds); apply to file, manual, and mock inputs
    - _Requirements: 22.3, 22.5, 22.6, 22.8_

  - [x] 10.7 Write the unit-normalization property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 18: For any finite numeric value and any accepted unit of a KPI, normalizing a value already expressed in the KPI's canonical unit returns that value unchanged; converting a value into any accepted unit and normalizing it back returns the original value within floating-point tolerance; and every value persisted through ingestion is expressed in its KPI's canonical unit.`
    - Use `arbUnitPair`; `{ numRuns: 100 }`
    - _Requirements: 22.1, 22.2, 22.5_

  - [x] 10.8 Write example tests for unit inference and fallback
    - Per-header-token inference (`vst_ms`, `vst_sec`, `bitrate_kbps`, the `_s`-on-a-bitrate near-miss) plus the unknown-unit fallback and its advisory
    - _Requirements: 22.3, 22.4, 22.6_

  - [x] 10.9 Implement TimestampNormalizer
    - Parse and convert the mapped timestamp to UTC (honor explicit offset/`Z`; naive → UTC with `sourceUtcOffsetMinutes: null` and flag the column; date-only → `00:00:00Z`); reject unparseable timestamps with a reason; assign the record its hour and day buckets
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5_

- [x] 11. Implement ingestion — record building, mapping validation, and reuse
  - [x] 11.1 Implement the record builder with wide-row fan-out and dimension/quartile data-quality checks
    - Build canonical `KPIRecord`s resolving app from column (wide), row (long), or file-level assignment; wide rows fan out to one record per app with only that app's values (a value+blank row yields a single record); append unknown dimension values as new members with an advisory; run the quartile-monotonicity check
    - _Requirements: 2.7, 21.6, 21.7, 21.8, 22.9_

  - [x] 11.2 Write the wide/long-equivalence property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 17: For any set of logical observations expressible in both layouts, ingesting the wide representation (app-qualified columns on one row) and ingesting the equivalent long representation (an app column with one row per app) produce identical per-app aggregates for every KPI and every slice; and every app-qualified column contributes only to its own app's aggregate, so no App_A column value ever appears in an App_B aggregate or vice versa.`
    - Use `arbLayoutPair`; `{ numRuns: 100 }`
    - _Requirements: 21.6, 21.7, 7.9_

  - [x] 11.3 Write the unknown-dimension-retention property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 13: For any set of ingested records containing arbitrary dimension values, every record is retained and every distinct dimension value present in the input appears as a member of the corresponding dimension after ingestion.`
    - `{ numRuns: 100 }`
    - _Requirements: 2.7_

  - [x] 11.4 Implement mapping validation
    - Detect no-mappable-columns (invalid schema, do not persist); block confirmation when no KPI is mapped; block when two columns map to the same `(kpiId, app)` pair (naming KPI, app, both columns)
    - _Requirements: 6.4, 7.8, 7.9, 16.4_

  - [x] 11.5 Write example tests for mapping validation
    - Invalid-schema rejection (6.4); missing-KPI block (7.8); the `(kpiId, app)` duplicate rule in valid, blocked, and long-layout-collapse forms (7.9)
    - _Requirements: 6.4, 7.8, 7.9_

  - [x] 11.6 Implement the MappingCache
    - Persist a confirmed mapping (targets with app qualifiers, layout, per-column units, `fileAppAssignment`) keyed by a hash of the sorted normalized header set; pre-populate the modal on a header-set match; re-prompt file-level app assignment for confirmation
    - _Requirements: 7.6, 7.7_

  - [x] 11.7 Write the mapping-reuse round-trip property test
    - `// Feature: ott-kpi-benchmarking-engine, Property 15: For any confirmed column mapping, saving it and then querying by the same header set (in any order) returns an equivalent mapping, because the reuse key is a hash of the sorted, normalized header set.`
    - Use `arbHeader`; `{ numRuns: 100 }`
    - _Requirements: 7.6, 7.7_

- [x] 12. Implement the ingestion UI modals and wiring
  - [x] 12.1 Implement IngestionModePrompt and the Column Mapping modal
    - Mode prompt (Pre_Aggregated / Raw_Session) shown after parse and before mapping confirmation; require file-level app assignment when the file carries no app signal
    - Mapping modal: per-column samples (up to 5 non-empty values), searchable KPI/dimension selector, proposed mappings, layout toggle, per-column unit selector (inferred preselected), timestamp-column flag for naive timestamps, and the userId hashing toggle
    - Wire confirm to build records, persist the mapping, run the quota pre-flight, write via the repository, and set the active dataset
    - _Requirements: 6.5, 7.1, 7.5, 21.5, 22.4, 26.2, 28.13_

  - [x] 12.2 Write example tests for ingestion-mode prompt and file-level assignment
    - Prompt ordering before mapping confirmation (6.5); required file-level app assignment stamped onto every record (21.5)
    - _Requirements: 6.5, 21.5_

- [x] 13. Implement manual entry and the mock data seeder
  - [x] 13.1 Implement the ManualEntryForm with edit/delete lifecycle
    - Dual-entry table with per-field numeric validation (invalid fields flagged, not submitted); submit ingests records with app/date/dimensions; edit re-normalizes and writes back via `updateRecord` preserving id; delete via `deleteRecord` behind confirmation; only `origin: "manual"` rows editable; both operations trigger a slice recompute
    - _Requirements: 8.1, 8.2, 8.3, 27.8, 27.9, 27.10, 27.11_

  - [x] 13.2 Write example tests for manual-entry lifecycle
    - Numeric flagging (8.3); update-in-place preserving id, delete-behind-confirmation, read-only enforcement for non-manual origins, and the resulting recompute
    - _Requirements: 8.3, 27.8, 27.9, 27.10, 27.11_

  - [x] 13.3 Implement the MockDataSeeder with Scale Profiles
    - Generate a 30-day comparative dataset (App_A Current, App_B Experimental/Competitor) across Mobile/Connected TV/Desktop Web and live+VOD stream types for every KPI, emitting canonical units and UTC
    - Support volume profiles via `scale: 'standard' | 'stress'`: 'standard' emits ~500 daily records for normal demo use; 'stress' seeds 25,000+ hourly/session records to deterministically exercise worker offloading (Task 9.1) and table virtualization (Task 19.1)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 15.3, 17.4_

  - [x] 13.4 Write the mock-seeder shape example test
    - Assert 30 days × all platforms × live+VOD × every KPI
    - _Requirements: 9.2, 9.3_

- [x] 14. Implement the Zustand state stores and recompute pipeline
  - [x] 14.1 Implement the state stores and debounced recompute
    - `useDatasetStore` (active dataset, list, App_A/App_B labels), `useFilterStore` (date range, dimension chips, app toggle, display timezone), `useSLAStore` (thresholds, variance band, min sample size), `useResultStore` (memoized `ComparisonResultSet`, no-data flags, progress)
    - Debounce (150 ms) a filter change to select the active dataset, apply the slice filter (inclusive UTC bucket boundaries, 7d/30d presets resolved to explicit from/to), dispatch to sync engine or worker, and populate the result cache; restore the most recent dataset/config on load, falling back to the demo dataset when none exists
    - _Requirements: 3.3, 9.4, 10.5, 17.2, 26.7, 26.8, 26.9_

- [x] 15. Checkpoint — engine, ingestion, and state
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Implement the dashboard shell and Global Filter Bar
  - [x] 16.1 Implement the app shell, dark theme tokens, and GlobalFilterBar
    - Dark-theme token layer (contrast-tuned RAG/accent tokens as the single source of truth); sticky filter bar with date-range control, five multi-select dimension chip groups, App_A/App_B toggle, display-timezone selector (UTC default, active zone labelled), and the Export menu; changes write to `useFilterStore` and trigger recompute; per-module no-data state when the slice matches nothing
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 15.1, 26.8_

- [x] 17. Implement the comparison dashboard modules
  - [x] 17.1 Implement the ScorecardGrid
    - Pillar-tabbed grid; each card shows App_A/App_B values (custom labels), absolute + percentage delta (2 decimals, N/A when appA=0), RAG badge, 7-day sparkline with partial-data indicator (<7 days), and the no-data / not-aggregable / low-confidence / not-derivable states with reasons; data-quality advisory badges (assumed unit, unweighted, non-monotonic quartiles); render within 2 seconds of slice selection
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.7, 11.8, 11.9, 19.6, 20.4, 22.6, 22.9, 23.2, 23.4, 23.8, 25.5, 25.7_

  - [x] 17.2 Implement the WinnerHeatmap
    - KPI × dimension-segment matrix with a segment-dimension selector; directionality-aware color-coded winner; distinct glyph + label per non-winner state (no-data, not-aggregable, low-confidence, tie); per-cell confidence and aggregability gates
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 23.4, 25.8, 25.9, 28.2_

  - [x] 17.3 Implement the TimeSeriesOverlay
    - ECharts line chart overlaying App_A/App_B for a selected KPI over the active range; metric switcher; dual Y-axis for disparate units; re-render on slice change; no-data state
    - Explicitly configure ECharts with SVG rendering (`renderer: 'svg'`) so charts render as vector elements and do not rasterize to blank canvases when the print/Executive Report view is triggered
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 18.5_

  - [x] 17.4 Implement the PercentileDistribution
    - Side-by-side P50/P90/P95 bars for VST, Manifest Fetch Latency, TTFB in canonical units; raw mode recomputes from raw values each slice; pre-aggregated renders only at ingested granularity and shows not-aggregable otherwise (never averages)
    - _Requirements: 13.6, 23.4, 23.5, 23.6, 23.7, 23.8_

- [x] 18. Implement configuration, dataset management, and export modules
  - [x] 18.1 Implement the SLAConfigPanel
    - Editor for per-KPI SLA thresholds (canonical unit shown beside each field), variance band, and min sample size; save persists and applies to subsequent classification; reset restores defaults; reject non-numeric/out-of-range entries showing the valid range; min-sample-size validated as a non-negative integer, default 100, 0 disables the gate
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 22.7, 25.1, 25.10, 25.11_

  - [x] 18.2 Write example tests for SLA validation
    - Threshold range validation (14.4); min-sample-size non-negative-integer validation and disable-at-0 (25.10, 25.11)
    - _Requirements: 14.4, 25.10, 25.11_

  - [x] 18.3 Implement the DatasetSwitcher
    - Active-dataset selector with rename, create-new, delete, and App_A/App_B label overrides (reflected across scorecards/heatmap/charts); reject duplicate names; deleting the active dataset promotes another, and deleting the last falls back to the demo dataset; surface retention deletion candidates for user confirmation
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 27.6, 27.7_

  - [x] 18.4 Implement the ExportMenu and ExecutiveReport
    - Export Delta CSV (KPIs, App_A/App_B values, absolute + percentage deltas, RAG) and Aggregated Summary CSV, both triggering a browser download; empty-slice guard shows "no active data to export" and produces no file/dialog; exported timestamps in the active display timezone with the zone named; never include a user-identifier column
    - Print Executive Report: apply print-optimized CSS (hides nav, filters, and shadows; preserves SVG vector charts and tabular contrast) then opens the print dialog
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 26.8, 28.12_

  - [x] 18.5 Write example tests for export content and guards
    - Delta and Aggregated-Summary CSV content plus the empty-slice export guard
    - _Requirements: 18.2, 18.4, 18.7_

  - [x] 18.6 Write the print-render test
    - Assert every ECharts instance retains SVG vector elements in the DOM when the print styling is triggered (no blank-canvas rasterization)
    - _Requirements: 18.5_

- [x] 19. Implement table virtualization and accessibility hardening
  - [x] 19.1 Implement virtualized high-density tables
    - Render tabular views with TanStack Table + Virtual so only visible rows materialize at 10,000+ rows; declare total row/column counts and each rendered row's true index; announce scroll changes politely
    - _Requirements: 15.2, 15.3, 28.9_

  - [x] 19.2 Implement color-independent status, contrast, keyboard, and AT semantics
    - Encode every RAG and heatmap outcome as color + glyph + text label; verify theme-token contrast (4.5:1 text, 3:1 large text and non-text indicators); make all controls keyboard-operable with visible focus; trap and restore focus in modals with `Escape` dismissal; expose chart accessible names + tabular alternatives; polite live region for recompute/progress/ingestion outcomes
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8_

  - [x] 19.3 Write accessibility tests
    - `axe` scans across module states (populated, no-data, not-aggregable, low-confidence) and open modals; keyboard-traversal reachability/activation/dismissal/focus-trap/restore/visible-focus; contrast assertions over theme tokens; color-independence icon+label checks; chart alternatives; virtualized-table full-count semantics
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8, 28.9_

- [x] 20. Implement data-residency privacy hardening
  - [x] 20.1 Implement client-residency and userId handling
    - Keep all ingested data client-resident with no external egress; use `userId` only for distinct-count aggregation, omitting it from every display and export; implement the optional per-column salted SHA-256 hashing at ingestion (per-dataset salt stored with the dataset)
    - _Requirements: 28.10, 28.11, 28.12, 28.13_

  - [x] 20.2 Write the network-guard and identifier-omission tests
    - Assert a full ingest → aggregate → export flow issues no `fetch`/`XMLHttpRequest`/WebSocket call; assert no export contains a user-identifier column; verify the hashing toggle preserves distinct counts
    - _Requirements: 28.11, 28.12, 28.13_

- [x] 21. Wire integration flows and validate performance
  - [x] 21.1 Write integration tests
    - Offline ingest → persist → reload → visualize (3.4); filter-change recompute updates every module (10.5, 13.4); worker offload above 25,000 records with an interactive filter bar (17.2, 17.4); storage-quota pre-flight refusal, `QuotaExceededError` rollback, and denied-persistence advisory against `fake-indexeddb` (27.1, 27.2, 27.5, 3.5, 27.3, 27.4); retention deletion-candidate surfacing (27.6, 27.7); wide-format end-to-end equivalence with two single-app files (21.5, 21.6, 21.7)
    - _Requirements: 3.4, 10.5, 13.4, 17.2, 17.4, 21.5, 21.6, 21.7, 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7_

  - [x] 21.2 Write snapshot and performance tests
    - Executive Report print CSS hides nav/filters/shadows (18.5); sticky filter-bar positioning and dark-theme/RAG contrast (10.1, 15.1); recompute over 10,000 aggregated rows within 1 second (17.1); scorecards render within 2 seconds of slice selection (11.1); tables virtualize at 10,000+ rows (15.3)
    - _Requirements: 10.1, 11.1, 15.1, 15.3, 17.1, 18.5_

- [x] 22. Final checkpoint — full suite green
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test/verification sub-tasks and can be skipped for a faster MVP; the unmarked tasks form the required implementation path. Property, unit, integration, accessibility, snapshot, and performance tests are all marked optional per this convention, while every core implementation task remains required.
- Each of the 24 correctness properties is implemented by exactly one `fast-check` property-based test with `{ numRuns: 100 }`, tagged `// Feature: ott-kpi-benchmarking-engine, Property {number}: {property_text}`, and placed immediately after the code it validates.
- Custom arbitraries (`arbSession`, `arbAggRow`, `arbHeader`, `arbKPIRecord`, `arbUnitPair`, `arbTimestamp`, `arbLayoutPair`) live in `test/arbitraries.ts` (task 1.2) and are shared across property tests.
- Each task references specific requirement sub-clauses and, where applicable, the design property number for traceability.
- Checkpoints (tasks 15 and 22) provide incremental validation before and after the UI layer.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["3.1", "3.3", "4.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.1", "5.3", "6.1", "6.4", "6.8"] },
    { "id": 4, "tasks": ["4.3", "5.2", "5.4", "6.2", "6.3", "6.5", "6.6", "6.7", "6.9", "6.10", "6.12"] },
    { "id": 5, "tasks": ["4.4", "4.5", "4.6", "6.11", "6.13", "7.1", "7.4"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.5", "8.1", "8.6"] },
    { "id": 7, "tasks": ["8.2", "8.3", "8.4", "8.5", "8.7", "8.8"] },
    { "id": 8, "tasks": ["9.1", "10.1", "10.2", "10.4", "10.6", "10.9"] },
    { "id": 9, "tasks": ["10.3", "10.5", "10.7", "10.8", "11.1", "11.4", "11.6"] },
    { "id": 10, "tasks": ["11.2", "11.3", "11.5", "11.7", "12.1", "13.1", "13.3"] },
    { "id": 11, "tasks": ["12.2", "13.2", "13.4", "14.1"] },
    { "id": 12, "tasks": ["16.1", "18.1", "18.3", "18.4"] },
    { "id": 13, "tasks": ["17.1", "17.2", "17.3", "17.4", "18.2", "18.5", "18.6", "19.1"] },
    { "id": 14, "tasks": ["19.2", "20.1"] },
    { "id": 15, "tasks": ["19.3", "20.2", "21.1", "21.2"] }
  ]
}
```
