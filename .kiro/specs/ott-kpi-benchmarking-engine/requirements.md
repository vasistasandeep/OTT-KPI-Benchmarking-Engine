# Requirements Document

## Introduction

The OTT KPI Benchmarking Engine is a production-grade, high-performance web application for deep multi-dimensional Key Performance Indicator (KPI) benchmarking and comparative intelligence between two Over-The-Top (OTT) streaming applications. The two comparison targets are referred to as App A (typically the Current Build) and App B (typically a New Release, Experimental variant, or Competitor).

The application ingests OTT performance data through file upload, manual entry, or a mock data seeder, processes both pre-aggregated summary metrics and raw session-level event logs, and presents comparative analytics across four KPI pillars (Playback Quality & QoE, User Engagement & Audience Retention, Monetization & AdTech, Infrastructure & Delivery). All metrics can be sliced across platform, network, CDN, geography, and stream-type dimensions. The application runs client-first with browser-based persistence and a storage-adapter abstraction that permits a future migration to a server backend.

This document defines the functional and quality requirements for the application. Implementation-specific technology choices (React, TypeScript, Tailwind, IndexedDB, and so on) are recorded here only where they constitute an explicit constraint from the stakeholder; detailed technical design belongs in the design phase.

## Glossary

- **OTT_Benchmarking_Engine**: The complete web application that ingests, processes, compares, and visualizes OTT KPI data. Referred to as "THE System" throughout unless a more specific component is named.
- **App_A**: The first comparison subject, typically the current production build.
- **App_B**: The second comparison subject, typically a new release, experimental variant, or competitor.
- **KPI**: Key Performance Indicator; a named, measurable metric belonging to one of the four pillars.
- **Pillar**: A top-level category grouping related KPIs. The four pillars are Playback Quality & QoE, User Engagement & Audience Retention, Monetization & AdTech, and Infrastructure & Delivery.
- **Directionality**: A property of each KPI indicating whether a higher value is better (`higher_is_better`) or a lower value is better (`lower_is_better`).
- **SLA_Threshold**: A configurable target value for a KPI used to classify performance.
- **RAG_Status**: A Red / Amber / Green classification. Red indicates degraded performance, Amber indicates neutral or within-variance-band performance, Green indicates improved performance, all evaluated with respect to directionality.
- **Variance_Band**: A neutral tolerance range around zero delta (default ±1.5%) within which a comparison is classified Amber/Neutral.
- **Delta**: The difference between an App_A KPI value and the corresponding App_B KPI value, expressed as both an absolute difference and a percentage change.
- **Dimension**: A categorical attribute used to filter, group, or aggregate KPIs. The dimensions are Platform/Form Factor, Network & ISP, CDN Provider, Geography, and Stream Type.
- **Slice**: A subset of data resulting from applying one or more dimension filters.
- **Pre_Aggregated_Mode**: Ingestion mode where each input record already contains aggregated daily or hourly metric values with dimension tags.
- **Raw_Session_Mode**: Ingestion mode where each input record is a raw playback session event that THE System must aggregate client-side into KPIs.
- **Aggregation_Engine**: The component that computes derived KPIs and percentiles from raw session-level event logs.
- **Column_Mapping**: The process of associating ingested source columns with canonical KPIs and Dimensions.
- **Canonical_KPI**: A KPI as defined in the internal taxonomy, independent of source column naming.
- **KPIDataRepository**: The storage-adapter interface abstracting all persistence operations, enabling the underlying store to be swapped without changing consuming code.
- **Mock_Data_Seeder**: The component that generates a realistic 30-day comparative demo dataset.
- **Scorecard**: A UI card presenting a single KPI's App_A value, App_B value, Delta, RAG_Status, and trend sparkline.
- **Heatmap**: A matrix visualization showing which app wins per dimension segment for each KPI.
- **VST**: Video Start Time (also Time To First Frame, TTFF); latency from playback intent to first rendered frame.
- **VSF**: Video Start Failure; a fatal error preventing video initialization.
- **EBVS**: Exit Before Video Start; abandonment during playback preparation.
- **CHR**: CDN Cache Hit Ratio; edge cache efficiency.
- **TTFB**: Time To First Byte; CDN edge response latency.
- **Percentile_Value**: A value at a given percentile rank (for example P50, P90, P95) of a distribution.
- **Weighted_Average**: An average of percentage or rate KPIs computed by weighting each contributing row by its Volume_Weight field, such as session count or total watch time.
- **Volume_Weight**: The numeric field on a pre-aggregated record representing the sample size used to weight that record in aggregation.
- **Dataset**: A named, stored collection of ingested records with its own App_A and App_B labels and source type.
- **Executive_Report**: A print-optimized rendering of the active dashboard for stakeholder distribution.
- **Source_Layout**: The arrangement by which a source file expresses the App_A / App_B distinction. Long layout uses one column identifying the app per row; wide layout encodes the app in the KPI column name; file-level assignment applies a single app to every record in the file.
- **Canonical_Unit**: The single unit of measure in which all persisted values, SLA thresholds, and valid ranges for a KPI are expressed.
- **Accepted_Unit**: A source unit recognized at ingestion for a KPI, paired with a multiplicative factor converting it to that KPI's Canonical_Unit.
- **Aggregability**: A property of an aggregated KPI value indicating whether combining its contributing records across time buckets or dimension segments is statistically valid.
- **Not_Aggregable_Indicator**: The defined indicator used when contributing records exist but combining them for the active Slice would be statistically invalid, distinct from the no-data indicator.
- **Distinct_Count_KPI**: A KPI whose value is a count of distinct users, specifically Daily Active Users, Weekly Active Users, and Monthly Active Users.
- **Derived_KPI**: A KPI computed from other aggregated KPI values rather than directly from records, such as Stickiness computed from aggregated Daily Active Users and Monthly Active Users.
- **Min_Sample_Size**: The configurable minimum contributing volume per app below which THE System declines to declare a winner for a KPI comparison.
- **Low_Confidence_Status**: A RAG_Status value indicating that values and Deltas are reported but no improvement or degradation verdict is issued because contributing volume is below Min_Sample_Size.
- **Time_Bucket**: The normalized UTC hour and UTC calendar day to which a record is assigned at ingestion.
- **Data_Quality_Advisory**: A non-fatal notice attached to a record or aggregated value indicating a suspect but retained condition, such as an assumed unit or non-monotonic completion quartiles.

## Requirements

### Requirement 1: KPI Taxonomy Definition

**User Story:** As an OTT performance analyst, I want a complete, well-defined KPI taxonomy organized by pillar, so that I can benchmark all relevant streaming metrics with correct directionality and default targets.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL define the KPI taxonomy across four Pillars: Playback Quality & QoE, User Engagement & Audience Retention, Monetization & AdTech, and Infrastructure & Delivery.
2. THE OTT_Benchmarking_Engine SHALL define each KPI with a name, an owning Pillar, a Directionality value of `higher_is_better` or `lower_is_better`, a unit of measure, and a default SLA_Threshold where a target is specified.
3. THE OTT_Benchmarking_Engine SHALL define the Playback Quality & QoE Pillar with the following KPIs: Video Start Time as P50 and P95 in seconds with Directionality `lower_is_better` and default SLA_Threshold of 1.5 seconds; Rebuffer Ratio as a percentage with Directionality `lower_is_better` and default SLA_Threshold of 0.4 percent; Rebuffer Rate as events per viewing hour with Directionality `lower_is_better` and default SLA_Threshold of 0.2 per hour; Video Start Failures as a percentage with Directionality `lower_is_better` and default SLA_Threshold of 0.5 percent; Exit Before Video Start as a percentage with Directionality `lower_is_better` and default SLA_Threshold of 1.8 percent; Average Rendered Bitrate in megabits per second with Directionality `higher_is_better`; and Downshift Frequency as drops per session with Directionality `lower_is_better`.
4. THE OTT_Benchmarking_Engine SHALL define the User Engagement & Audience Retention Pillar with the following KPIs: Total Watch Time in hours; Average Session Duration in minutes with Directionality `higher_is_better`; Daily Active Users, Weekly Active Users, Monthly Active Users, and Stickiness as the Daily-Active-Users-to-Monthly-Active-Users ratio with Directionality `higher_is_better`; Content Completion Rate across the 25 percent, 50 percent, 75 percent, and 100 percent quartiles with Directionality `higher_is_better`; and Browse-to-Play Conversion as a percentage with Directionality `higher_is_better`.
5. THE OTT_Benchmarking_Engine SHALL define the Monetization & AdTech Pillar with the following KPIs: Ad Fill Rate as a percentage with Directionality `higher_is_better`; Ad Start Failure as a percentage with Directionality `lower_is_better` and default SLA_Threshold of 0.8 percent; Video Completion Rate for Ads as a percentage with Directionality `higher_is_better`; Ad Pod Drop-off Rate as a percentage with Directionality `lower_is_better`; Churn Rate as a monthly percentage with Directionality `lower_is_better`; and Average Revenue Per User as a currency value with Directionality `higher_is_better`.
6. THE OTT_Benchmarking_Engine SHALL define the Infrastructure & Delivery Pillar with the following KPIs: CDN Cache Hit Ratio as a percentage with Directionality `higher_is_better` and default SLA_Threshold of 95 percent; Manifest Fetch Latency as median milliseconds with Directionality `lower_is_better`; and Time To First Byte in milliseconds with Directionality `lower_is_better`.

### Requirement 2: Slicing Dimension Definition

**User Story:** As an OTT performance analyst, I want a complete set of slicing dimensions with defined member values, so that I can filter, group, and aggregate any KPI across meaningful segments.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL define the Platform/Form Factor Dimension with member values covering Connected TV form factors including Tizen, WebOS, Android TV, Apple TV, and FireTV; Mobile form factors including iOS and Android; and Desktop Web.
2. THE OTT_Benchmarking_Engine SHALL define the Network & ISP Dimension with member values including Wi-Fi, Cellular 5G, Cellular 4G, and Broadband, and SHALL support named telecom ISP member values.
3. THE OTT_Benchmarking_Engine SHALL define the CDN Provider Dimension with member values including Akamai, Cloudflare, Fastly, and AWS CloudFront.
4. THE OTT_Benchmarking_Engine SHALL define the Geography Dimension with member value levels for Country, Region or State, and Metropolitan Market.
5. THE OTT_Benchmarking_Engine SHALL define the Stream Type Dimension with member values including Live Sports or Events, VOD Movies, VOD Series, and FAST linear channels.
6. WHERE a KPI is displayed, THE OTT_Benchmarking_Engine SHALL support filtering, grouping, and aggregation of that KPI across every defined Dimension.
7. IF an ingested record contains a dimension value not present in the defined member values, THEN THE OTT_Benchmarking_Engine SHALL retain the record and add the value as a new member of the corresponding Dimension.

### Requirement 3: Storage Layer and Persistence

**User Story:** As a user, I want my ingested data and configuration to persist locally across sessions, so that I can work offline and return to large session logs without re-uploading.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL expose all persistence operations behind a single KPIDataRepository interface so that the underlying storage implementation can be replaced without modifying consuming code.
2. THE OTT_Benchmarking_Engine SHALL persist ingested datasets, SLA_Threshold configurations, and Column_Mapping definitions in browser-based storage capable of holding large session logs.
3. WHEN a user reopens the application after a prior session, THE OTT_Benchmarking_Engine SHALL restore the most recently persisted datasets and configurations.
4. WHILE the browser has no network connection, THE OTT_Benchmarking_Engine SHALL provide full ingestion, processing, and visualization capability using locally persisted data.
5. IF a persistence write operation fails, THEN THE OTT_Benchmarking_Engine SHALL display an error notification identifying the failed operation and SHALL preserve the current in-memory dataset.
6. WHEN a user requests deletion of a stored dataset, THE OTT_Benchmarking_Engine SHALL remove that dataset from persistent storage and SHALL confirm completion of the removal.

### Requirement 4: Pre-Aggregated Summary Metrics Ingestion

**User Story:** As an OTT performance analyst, I want to ingest pre-aggregated daily or hourly metrics with dimension tags, so that I can benchmark data that has already been summarized upstream.

#### Acceptance Criteria

1. WHEN a user ingests data in Pre_Aggregated_Mode, THE OTT_Benchmarking_Engine SHALL interpret each record as a set of aggregated KPI values associated with a date or hour and dimension tags.
2. WHEN a Pre_Aggregated_Mode record is ingested, THE OTT_Benchmarking_Engine SHALL associate each mapped KPI value with its App_A or App_B assignment, its time period, and its dimension tags.
3. IF a Pre_Aggregated_Mode record contains a non-numeric value in a field mapped to a numeric KPI, THEN THE OTT_Benchmarking_Engine SHALL exclude that value from aggregation and SHALL report the excluded field and record to the user.

### Requirement 5: Raw Session-Level Event Log Ingestion and Aggregation

**User Story:** As an OTT performance analyst, I want to ingest raw session-level event logs and have the application compute KPIs on the fly, so that I can benchmark from primary data without pre-processing it externally.

#### Acceptance Criteria

1. WHEN a user ingests data in Raw_Session_Mode, THE Aggregation_Engine SHALL interpret each record as a raw playback session and SHALL compute derived KPIs from the mapped session fields.
2. WHEN computing Rebuffer Ratio in Raw_Session_Mode, THE Aggregation_Engine SHALL compute the sum of buffering milliseconds divided by the sum of play-time milliseconds plus buffering milliseconds, expressed as a percentage rounded to 2 decimal places.
3. WHEN computing Video Start Failure rate in Raw_Session_Mode, THE Aggregation_Engine SHALL compute the sum of session start failures divided by the sum of playback attempts, expressed as a percentage rounded to 2 decimal places.
4. WHEN computing latency percentile KPIs in Raw_Session_Mode, THE Aggregation_Engine SHALL compute the P50, P90, and P95 Percentile_Value for Video Start Time and for Time To First Byte using linear interpolation between the two nearest ranks.
5. IF a divisor computed during Raw_Session_Mode aggregation equals zero, THEN THE Aggregation_Engine SHALL set the affected KPI value to the defined no-data indicator rather than producing a division error, and SHALL apply the same no-data indicator consistently across all affected KPIs.
6. WHEN Raw_Session_Mode aggregation is applied, THE Aggregation_Engine SHALL group session records by their App assignment, time period, and dimension tags before computing each KPI.
7. IF a session record is missing a required mapped field or contains a non-numeric or negative value in a numeric mapped field, THEN THE Aggregation_Engine SHALL exclude that record from KPI computation and SHALL record it as a rejected record with an indication of the reason.
8. IF the set of valid session records for a given group is empty, THEN THE Aggregation_Engine SHALL set each Percentile_Value for that group to the defined no-data indicator rather than producing a computation error.

### Requirement 6: File Upload Ingestion

**User Story:** As a user, I want to upload CSV, XLSX, or JSON files by drag-and-drop, so that I can bring existing data into the application quickly.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL accept file ingestion of CSV, XLSX, and JSON files through a drag-and-drop target and through a file-picker control.
2. WHEN a file is uploaded, THE OTT_Benchmarking_Engine SHALL parse the file into records and SHALL present a sample of parsed values to the user.
3. IF an uploaded file cannot be parsed into records, THEN THE OTT_Benchmarking_Engine SHALL display an error banner identifying the file and the parsing failure reason.
4. IF an uploaded file's schema contains no columns that can be mapped to any Canonical_KPI or Dimension, THEN THE OTT_Benchmarking_Engine SHALL display an invalid-schema error banner and SHALL NOT persist the file's records.
5. WHEN a file is uploaded, THE OTT_Benchmarking_Engine SHALL prompt the user to select the Ingestion Mode of Pre_Aggregated_Mode or Raw_Session_Mode before the Column_Mapping is confirmed.

### Requirement 7: Interactive Visual Column-Mapping

**User Story:** As a user, I want a guided column-mapping screen with fuzzy auto-matching, so that I can align arbitrary source headers to the canonical KPIs and dimensions without manual guesswork.

#### Acceptance Criteria

1. WHEN a file is parsed, THE OTT_Benchmarking_Engine SHALL display a Column_Mapping modal presenting, for each source column, up to the first 5 non-empty ingested sample values alongside a searchable selector listing all Canonical_KPIs and Dimensions.
2. WHEN the Column_Mapping modal opens, THE OTT_Benchmarking_Engine SHALL propose an initial mapping for each source column by fuzzy-matching the source header name against Canonical_KPI names, Dimension names, and known aliases, and SHALL select the candidate with the highest match score of 0.80 or greater on a normalized 0.00 to 1.00 similarity scale.
3. IF no candidate for a source column reaches a match score of 0.80, THEN THE OTT_Benchmarking_Engine SHALL leave that source column unmapped and SHALL indicate it as requiring user selection.
4. WHEN a source header exactly matches a known KPI alias, THE OTT_Benchmarking_Engine SHALL propose the corresponding Canonical_KPI, including mapping header aliases such as `ttff`, `startup_time`, and `vst_ms` to Video Start Time.
5. WHEN a user changes a proposed mapping, THE OTT_Benchmarking_Engine SHALL update the mapping for that source column to the user's selection.
6. WHEN a user confirms the Column_Mapping, THE OTT_Benchmarking_Engine SHALL ingest the file's records using the confirmed mapping and SHALL persist the confirmed mapping keyed by the source header set for reuse.
7. WHEN a subsequent file is parsed whose source header set matches a previously persisted mapping, THE OTT_Benchmarking_Engine SHALL pre-populate the Column_Mapping modal with the persisted mapping.
8. IF a user confirms a Column_Mapping in which no source column is mapped to any KPI, THEN THE OTT_Benchmarking_Engine SHALL display a message indicating that at least one KPI mapping is required and SHALL NOT complete ingestion.
9. IF a user confirms a Column_Mapping in which two or more source columns are mapped to the same Canonical_KPI for the same App assignment, THEN THE OTT_Benchmarking_Engine SHALL display a message naming the Canonical_KPI, the App assignment, and the conflicting source columns, and SHALL NOT complete ingestion.

### Requirement 8: Manual Data Entry

**User Story:** As a user, I want a dual-entry table to type App A and App B values directly, so that I can benchmark small or ad hoc datasets without preparing a file.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL provide a manual entry table for entering KPI values for App_A and App_B across selected Dimensions and dates.
2. WHEN a user submits manual entries, THE OTT_Benchmarking_Engine SHALL ingest the entered values as records associated with their App assignment, date, and dimension selections.
3. IF a user enters a non-numeric value in a numeric KPI field, THEN THE OTT_Benchmarking_Engine SHALL flag that field as invalid and SHALL NOT submit the invalid field.

### Requirement 9: Mock Data Seeder

**User Story:** As a first-time user, I want to load a realistic demo dataset with one action, so that I can explore the full application immediately without providing my own data.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL provide a "Load OTT Demo Dataset" control in the navigation header.
2. WHEN a user activates the "Load OTT Demo Dataset" control, THE Mock_Data_Seeder SHALL populate a 30-day comparative dataset for App_A designated Current and App_B designated Experimental or Competitor.
3. WHEN the Mock_Data_Seeder populates data, THE Mock_Data_Seeder SHALL generate values across the Mobile, Connected TV, and Desktop Web platforms and across live streaming and VOD stream types for every defined KPI.
4. WHEN the application is opened with no persisted dataset present, THE OTT_Benchmarking_Engine SHALL present the demo dataset as the default active state.

### Requirement 10: Global Filter and Slice Bar

**User Story:** As an analyst, I want a persistent top filter bar, so that I can constrain the entire dashboard to a date range, dimension selections, and app variants at once.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL display a Global Filter bar fixed at the top of the dashboard that remains visible while the dashboard content scrolls.
2. THE Global Filter bar SHALL provide a date-range control offering Last 7 Days, Last 30 Days, and a custom range selection.
3. THE Global Filter bar SHALL provide multi-select dimension chips for the Platform, CDN Provider, Network & ISP, Geography, and Stream Type Dimensions.
4. THE Global Filter bar SHALL provide an app selector or variant toggle for App_A and App_B.
5. WHEN a user changes any Global Filter selection, THE OTT_Benchmarking_Engine SHALL re-compute and re-render all dashboard modules to reflect the active Slice.
6. IF the active Slice contains no matching records, THEN THE OTT_Benchmarking_Engine SHALL display a no-data state in each affected module rather than an empty or error rendering.

### Requirement 11: KPI Scorecards with Delta and RAG Badging

**User Story:** As an analyst, I want side-by-side scorecards with deltas and RAG badges, so that I can immediately see which app wins each KPI and by how much.

#### Acceptance Criteria

1. WHEN the active Slice is selected, THE OTT_Benchmarking_Engine SHALL display KPI Scorecards organized under one tab per Pillar within 2 seconds.
2. THE Scorecard SHALL display the App_A value and the App_B value for its KPI within the active Slice.
3. THE Scorecard SHALL display the absolute Delta as (App_B value minus App_A value) and the percentage Delta as the absolute Delta divided by the App_A value, expressed as a percentage rounded to 2 decimal places.
4. IF the App_A value is 0, THEN THE OTT_Benchmarking_Engine SHALL display the absolute Delta and display a not-applicable indicator in place of the percentage Delta and classify RAG_Status using the absolute Delta sign with respect to the KPI's Directionality.
5. WHEN computing RAG_Status, THE OTT_Benchmarking_Engine SHALL classify the comparison as Amber when the absolute value of the percentage Delta is less than or equal to the Variance_Band, as Green when the percentage Delta exceeds the Variance_Band in the direction that indicates improvement per the KPI's Directionality, and as Red when the percentage Delta exceeds the Variance_Band in the direction that indicates degradation per the KPI's Directionality.
6. THE OTT_Benchmarking_Engine SHALL use a default Variance_Band of 1.5 percent for Amber classification.
7. THE Scorecard SHALL display a 7-day trend sparkline for its KPI.
8. IF the active Slice contains fewer than 7 days of data for a Scorecard's KPI, THEN THE OTT_Benchmarking_Engine SHALL render the sparkline using the available days and display a partial-data indicator on that Scorecard.
9. IF a Scorecard's KPI has no data in the active Slice, THEN THE OTT_Benchmarking_Engine SHALL display a no-data indicator on that Scorecard in place of values, Delta, and RAG_Status.

### Requirement 12: Dimension Breakdown and Winner Heatmap

**User Story:** As an analyst, I want a matrix heatmap of KPIs across dimension segments, so that I can spot which app wins in each segment at a glance.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL display a Heatmap matrix with dimension segments on one axis and core KPIs on the other axis.
2. WHEN rendering a Heatmap cell, THE OTT_Benchmarking_Engine SHALL determine the winning app for that KPI-segment intersection by comparing App_A and App_B values with respect to the KPI's Directionality.
3. THE OTT_Benchmarking_Engine SHALL color-code each Heatmap cell to indicate the winning app.
4. WHEN a user selects a different Dimension for the Heatmap segment axis, THE OTT_Benchmarking_Engine SHALL re-render the Heatmap using the selected Dimension's member values as segments.
5. IF a Heatmap cell has no data for one or both apps in the active Slice, THEN THE OTT_Benchmarking_Engine SHALL render that cell with a no-data indicator.

### Requirement 13: Time-Series Trend Overlay

**User Story:** As an analyst, I want an interactive time-series chart overlaying App A and App B, so that I can compare how a metric evolves over the selected period.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL display a time-series line chart plotting App_A and App_B values over the active date range for a selected KPI.
2. THE OTT_Benchmarking_Engine SHALL provide a metric-switcher control that changes the KPI plotted in the time-series chart.
3. WHERE two selected KPIs use disparate units, THE OTT_Benchmarking_Engine SHALL render the time-series chart with a dual Y-axis so that each unit is scaled independently.
4. WHEN a user changes the Global Filter Slice, THE OTT_Benchmarking_Engine SHALL re-render the time-series chart to reflect the active Slice.
5. IF the selected KPI has no time-series data in the active Slice, THEN THE OTT_Benchmarking_Engine SHALL display a no-data state in the chart area.
6. THE OTT_Benchmarking_Engine SHALL provide a Percentile Distribution view presenting a side-by-side comparison of the P50, P90, and P95 latency Percentile_Values between App_A and App_B for Video Start Time, Manifest Fetch Latency, and Time To First Byte.

### Requirement 14: SLA and Threshold Configuration

**User Story:** As an analyst, I want to customize RAG thresholds, so that benchmarking reflects my organization's own performance targets.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL provide an SLA & Threshold configuration panel for customizing the SLA_Threshold and Variance_Band used in RAG_Status classification.
2. WHEN a user saves a customized SLA_Threshold for a KPI, THE OTT_Benchmarking_Engine SHALL persist the customized SLA_Threshold and SHALL apply it in subsequent RAG_Status classification for that KPI.
3. WHEN a user resets a KPI's SLA_Threshold, THE OTT_Benchmarking_Engine SHALL restore that KPI's default SLA_Threshold.
4. IF a user enters an SLA_Threshold value that is non-numeric or outside the KPI's valid range, THEN THE OTT_Benchmarking_Engine SHALL reject the entry and SHALL display the valid range for that KPI.

### Requirement 15: High-Density Comparative UI and Theme

**User Story:** As an analyst working with dense telemetry, I want a compact dark broadcast-style interface, so that I can read large amounts of comparative data without scrolling fatigue.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL render in a dark theme by default using low-luminance surface colors and high-contrast accent colors for RAG_Status badges.
2. THE OTT_Benchmarking_Engine SHALL present tabular and scorecard content in a high-density layout with aligned columns.
3. WHEN a dataset contains 10000 or more rows, THE OTT_Benchmarking_Engine SHALL render tabular views using virtualization so that only visible rows are materialized.

### Requirement 16: Edge Case and Error Handling

**User Story:** As a user, I want the application to handle imperfect data gracefully, so that malformed or mismatched inputs produce clear feedback instead of failures.

#### Acceptance Criteria

1. IF a metric computation would divide by zero, THEN THE OTT_Benchmarking_Engine SHALL produce a defined no-data indicator for that metric instead of a division error.
2. IF a record is missing a value for a Dimension used in the active Slice, THEN THE OTT_Benchmarking_Engine SHALL group that record under a defined "Unknown" member value for that Dimension.
3. IF App_A and App_B have unequal record counts for a comparison, THEN THE OTT_Benchmarking_Engine SHALL compute each app's aggregate independently and SHALL display the comparison using each app's available data.
4. IF an uploaded file fails schema validation, THEN THE OTT_Benchmarking_Engine SHALL display a parsing error banner identifying the validation failure and SHALL leave previously persisted data unchanged.
5. WHEN a no-data indicator is shown for a KPI, THE OTT_Benchmarking_Engine SHALL exclude that KPI value from Delta and RAG_Status computation for the affected comparison.

### Requirement 17: Performance and Responsiveness

**User Story:** As an analyst, I want the dashboard to remain responsive with large datasets, so that filtering and comparison feel immediate.

#### Acceptance Criteria

1. WHEN a user changes a Global Filter selection on a dataset of up to 10000 aggregated rows, THE OTT_Benchmarking_Engine SHALL re-render all affected modules within 1 second.
2. WHEN Raw_Session_Mode aggregation is performed on the active Slice, THE OTT_Benchmarking_Engine SHALL perform the aggregation without blocking user interaction with the Global Filter bar.
3. WHILE a long-running ingestion or aggregation operation is in progress, THE OTT_Benchmarking_Engine SHALL display a progress indicator identifying the operation in progress.
4. WHEN aggregating a Raw_Session_Mode dataset exceeding 25000 records, THE Aggregation_Engine SHALL execute its calculation and grouping routines in a dedicated Web Worker so that the main thread remains responsive.

### Requirement 18: Data Export and Executive Reporting

**User Story:** As an OTT analyst, I want to export comparative analysis and generate executive summaries, so that I can share findings with engineering and executive stakeholders.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL provide an Export control on the Global Filter bar offering the actions "Export Delta CSV", "Download Aggregated Summary CSV", and "Print Executive Report".
2. WHEN "Export Delta CSV" is selected, THE OTT_Benchmarking_Engine SHALL generate a CSV file for the active Slice containing all active KPIs, App_A values, App_B values, absolute Deltas, percentage Deltas, and RAG_Status.
3. WHEN "Export Delta CSV" is selected, THE OTT_Benchmarking_Engine SHALL trigger a browser download of the generated CSV file.
4. WHEN "Download Aggregated Summary CSV" is selected, THE OTT_Benchmarking_Engine SHALL generate and trigger a browser download of a CSV file containing the aggregated KPI values for the active Slice.
5. WHEN "Print Executive Report" is selected, THE OTT_Benchmarking_Engine SHALL render the active dashboard as an Executive_Report using print-optimized CSS that hides navigation, filtering controls, and background shadows.
6. WHEN the Executive_Report rendering is complete, THE OTT_Benchmarking_Engine SHALL trigger the browser print dialog.
7. IF an export or report action is invoked WHILE the active Slice contains no matching records, THEN THE OTT_Benchmarking_Engine SHALL display a message indicating that there is no active data to export and SHALL NOT generate a file or open the print dialog.

### Requirement 19: Dataset Lifecycle and Multi-Benchmark Management

**User Story:** As an analyst, I want to manage multiple saved comparison runs, so that I can switch between different test cycles without overwriting data.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL support multiple stored Datasets, each defined by an identifier, a human-readable name, a creation timestamp, a custom label for App_A, a custom label for App_B, a record count, and a source type of Raw, Aggregated, or Mock.
2. THE OTT_Benchmarking_Engine SHALL provide a Dataset Switcher in the top navigation for selecting the active Dataset.
3. THE OTT_Benchmarking_Engine SHALL provide a control in the Dataset Switcher for renaming an existing Dataset.
4. THE OTT_Benchmarking_Engine SHALL provide a control in the Dataset Switcher for creating a new benchmark run as a new Dataset.
5. THE OTT_Benchmarking_Engine SHALL allow the user to override the display labels for App_A and App_B per Dataset.
6. WHEN a user overrides the App_A or App_B display label for a Dataset, THE OTT_Benchmarking_Engine SHALL reflect the custom label across all Scorecards, Heatmaps, and Charts.
7. IF a user creates or renames a Dataset with a name that matches an existing Dataset name, THEN THE OTT_Benchmarking_Engine SHALL reject the operation and SHALL display a message indicating that the Dataset name must be unique.
8. IF a user deletes the active Dataset, THEN THE OTT_Benchmarking_Engine SHALL remove that Dataset and SHALL set another remaining Dataset as the active Dataset.
9. IF a user deletes the active Dataset WHILE no other Dataset remains, THEN THE OTT_Benchmarking_Engine SHALL present the demo dataset as the default active state.

### Requirement 20: Mathematical Aggregation Integrity for Pre-Aggregated Data

**User Story:** As an analyst, I want aggregated metrics across multiple slices to use statistically valid weighting, so that high-volume platforms or regions are not skewed by low-volume outliers.

#### Acceptance Criteria

1. WHEN aggregating pre-aggregated percentage or rate KPIs across multiple rows, THE Aggregation_Engine SHALL compute a Weighted_Average using the corresponding Volume_Weight field, such as session count or total watch time.
2. WHEN a Volume_Weight field is present for the rows being aggregated, THE Aggregation_Engine SHALL weight each row by its Volume_Weight value rather than computing an unweighted arithmetic mean.
3. IF a Volume_Weight field is absent for the rows being aggregated, THEN THE Aggregation_Engine SHALL compute an unweighted arithmetic mean.
4. IF a Volume_Weight field is absent for the rows being aggregated, THEN THE Aggregation_Engine SHALL display a data-quality advisory warning that the aggregated percentages are unweighted.

### Requirement 21: Source Layout Detection and App Assignment

**User Story:** As a user with exports that encode the app distinction in different ways, I want THE System to recognize the layout of my file and let me correct it, so that each value is attributed to the right app without reshaping the file first.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL support the long Source_Layout, the wide Source_Layout, and the file-level-assignment Source_Layout for ingested files.
2. WHEN two or more source columns match the same Canonical_KPI and their headers differ only by a recognized app-suffix token pair, THE OTT_Benchmarking_Engine SHALL classify the file's Source_Layout as wide and SHALL assign the first token of the pair to App_A and the second token to App_B.
3. WHEN the Column_Mapping modal opens, THE OTT_Benchmarking_Engine SHALL present the detected Source_Layout as a default selection that the user can override.
4. IF a parsed file contains both a source column mapped as the app column and app-qualified KPI columns, THEN THE OTT_Benchmarking_Engine SHALL classify the Source_Layout as long using the app column and SHALL report the app-qualified columns as an ambiguity in the Column_Mapping modal.
5. IF a parsed file contains neither an app column nor app-qualified KPI columns, THEN THE OTT_Benchmarking_Engine SHALL require the user to select a file-level App assignment of App_A or App_B before the Column_Mapping can be confirmed, and SHALL apply the selected App assignment to every record ingested from that file.
6. WHEN a file with the wide Source_Layout is ingested, THE OTT_Benchmarking_Engine SHALL produce one record per App assignment from each source row, with each produced record carrying that source row's timestamp and dimension values.
7. WHEN a file with the wide Source_Layout is ingested, THE OTT_Benchmarking_Engine SHALL include each app-qualified column's value only in the aggregate for that column's own App assignment.
8. IF a source row in a file with the wide Source_Layout carries a value for one App assignment and an empty value for the other App assignment, THEN THE OTT_Benchmarking_Engine SHALL produce a single record for the App assignment that carries the value.

### Requirement 22: Unit Declaration and Normalization

**User Story:** As an OTT performance analyst, I want every ingested value converted to one declared unit per KPI, so that thresholds, deltas, and comparisons are always evaluated on the same scale regardless of how the source file expressed the value.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL define for each KPI exactly one Canonical_Unit and a set of Accepted_Units, with each Accepted_Unit paired with a multiplicative conversion factor to that KPI's Canonical_Unit.
2. THE OTT_Benchmarking_Engine SHALL express every persisted KPI value, every SLA_Threshold, and every KPI valid range in that KPI's Canonical_Unit.
3. WHEN the Column_Mapping modal proposes a mapping for a source column, THE OTT_Benchmarking_Engine SHALL infer that column's source unit from the source header token, considering only the Accepted_Units of the mapped Canonical_KPI.
4. WHEN the Column_Mapping modal displays a source column mapped to a Canonical_KPI, THE OTT_Benchmarking_Engine SHALL display an editable unit selector listing that KPI's Accepted_Units with the inferred Accepted_Unit preselected.
5. WHEN a value is ingested for a mapped Canonical_KPI, THE OTT_Benchmarking_Engine SHALL multiply the value by the conversion factor of the resolved Accepted_Unit and SHALL persist the converted value in that KPI's Canonical_Unit.
6. IF no source unit can be inferred for a source column mapped to a Canonical_KPI, THEN THE OTT_Benchmarking_Engine SHALL preselect that KPI's Canonical_Unit, SHALL raise a Data_Quality_Advisory naming the source column and the assumed unit, and SHALL complete ingestion.
7. WHERE an SLA_Threshold entry field is displayed, THE OTT_Benchmarking_Engine SHALL display the corresponding KPI's Canonical_Unit beside that field.
8. WHEN a record raises a Data_Quality_Advisory, THE OTT_Benchmarking_Engine SHALL retain that record and SHALL include that record in KPI aggregation.
9. IF an ingested record's Content Completion Rate quartile values violate the ordering in which the 25 percent value is greater than or equal to the 50 percent value, the 50 percent value is greater than or equal to the 75 percent value, and the 75 percent value is greater than or equal to the 100 percent value, THEN THE OTT_Benchmarking_Engine SHALL raise a Data_Quality_Advisory naming the record and the offending pair of quartile values and SHALL include that record in KPI aggregation.

### Requirement 23: Aggregability of Unique Counts and Percentiles

**User Story:** As an analyst, I want THE System to refuse to recombine unique counts and pre-aggregated percentiles across buckets or segments, so that no displayed number is a statistically invalid merge.

#### Acceptance Criteria

1. WHEN a Distinct_Count_KPI is computed in Raw_Session_Mode WHILE a user identifier field is mapped, THE Aggregation_Engine SHALL compute that KPI as the count of distinct user identifier values within the group.
2. IF a Distinct_Count_KPI is requested in Raw_Session_Mode WHILE no user identifier field is mapped, THEN THE Aggregation_Engine SHALL set that KPI value to the defined no-data indicator and SHALL display the reason that a mapped user identifier column is required.
3. THE Aggregation_Engine SHALL compute each Distinct_Count_KPI directly from the records of the active Slice rather than by summing or averaging Distinct_Count_KPI values across Time_Buckets or across dimension segments.
4. IF the active Slice requires combining Pre_Aggregated_Mode Distinct_Count_KPI values or Percentile_Values across two or more Time_Buckets or across two or more dimension segments, THEN THE Aggregation_Engine SHALL resolve that KPI value to the Not_Aggregable_Indicator.
5. WHILE the active Slice matches the granularity at which a Pre_Aggregated_Mode Distinct_Count_KPI value or Percentile_Value was ingested, THE OTT_Benchmarking_Engine SHALL display that value as ingested.
6. THE Aggregation_Engine SHALL compute each Percentile_Value from an underlying distribution of raw values rather than as an arithmetic mean or a Weighted_Average of Percentile_Values.
7. WHEN the active Slice or a time rollup is computed in Raw_Session_Mode, THE Aggregation_Engine SHALL recompute each Percentile_Value from the union of the underlying raw values contained in that Slice or rollup.
8. WHEN a KPI value resolves to the Not_Aggregable_Indicator, THE OTT_Benchmarking_Engine SHALL exclude that value from Delta and RAG_Status computation and SHALL display a reason distinct from the reason displayed for the no-data indicator.

### Requirement 24: Derived KPI Computation Order

**User Story:** As an analyst, I want ratio KPIs computed from aggregated operands, so that a ratio reported for a slice equals the ratio of that slice's totals rather than an average of segment ratios.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL define Stickiness as a Derived_KPI computed from the aggregated Daily Active Users value divided by the aggregated Monthly Active Users value.
2. WHEN a Derived_KPI is computed for the active Slice, THE Aggregation_Engine SHALL compute that Derived_KPI only after every one of its operand KPIs has been aggregated for that same active Slice.
3. THE Aggregation_Engine SHALL compute each Derived_KPI from its aggregated operand values rather than as an arithmetic or weighted average of per-segment Derived_KPI values.
4. IF an operand of a Derived_KPI resolves to the no-data indicator or to the Not_Aggregable_Indicator, THEN THE Aggregation_Engine SHALL set that Derived_KPI to the same indicator and SHALL name the operand KPI responsible.
5. IF the denominator operand of a Derived_KPI aggregates to 0 for the active Slice, THEN THE Aggregation_Engine SHALL set that Derived_KPI to the defined no-data indicator.

### Requirement 25: Minimum Sample Size and Confidence Gating

**User Story:** As an analyst, I want THE System to withhold a winner verdict when the underlying sample is thin, so that noise from low-volume segments is not presented as a performance improvement or regression.

#### Acceptance Criteria

1. THE OTT_Benchmarking_Engine SHALL provide a configurable Min_Sample_Size setting in the SLA & Threshold configuration panel with a default value of 100 contributing records per app.
2. WHEN a KPI comparison is evaluated, THE OTT_Benchmarking_Engine SHALL evaluate Min_Sample_Size separately for each KPI and each app over the active Slice against that app's count of contributing records.
3. WHERE a Volume_Weight field is present on the contributing records, THE OTT_Benchmarking_Engine SHALL evaluate Min_Sample_Size against the sum of the Volume_Weight values instead of the contributing record count.
4. IF either App_A's or App_B's contributing volume for a KPI in the active Slice is below Min_Sample_Size, THEN THE OTT_Benchmarking_Engine SHALL assign Low_Confidence_Status to that KPI comparison.
5. WHILE a KPI comparison carries Low_Confidence_Status, THE OTT_Benchmarking_Engine SHALL display the App_A value, the App_B value, the absolute Delta, and the percentage Delta.
6. WHILE a KPI comparison carries Low_Confidence_Status, THE OTT_Benchmarking_Engine SHALL restrict the RAG_Status for that comparison to Low_Confidence_Status rather than Green or Red.
7. WHILE a KPI comparison carries Low_Confidence_Status, THE OTT_Benchmarking_Engine SHALL display App_A's contributing volume, App_B's contributing volume, and the active Min_Sample_Size value.
8. THE OTT_Benchmarking_Engine SHALL apply the Min_Sample_Size evaluation to every Scorecard and to every Heatmap cell.
9. IF a Heatmap cell carries Low_Confidence_Status, THEN THE OTT_Benchmarking_Engine SHALL render that cell with the Low_Confidence_Status indicator and SHALL determine no winning app for that cell.
10. IF a user enters a Min_Sample_Size value that is not a non-negative integer, THEN THE OTT_Benchmarking_Engine SHALL reject the entry and SHALL display that Min_Sample_Size must be a non-negative integer.
11. WHILE Min_Sample_Size is set to 0, THE OTT_Benchmarking_Engine SHALL classify every KPI comparison by Delta and Directionality without applying Low_Confidence_Status.

### Requirement 26: Timezone Normalization and Time Bucketing

**User Story:** As an analyst comparing exports produced in different timezones, I want every timestamp normalized to a single timezone before bucketing, so that a date range always selects the same records and produces the same numbers.

#### Acceptance Criteria

1. WHEN a record is ingested, THE OTT_Benchmarking_Engine SHALL convert the record's mapped timestamp to UTC and SHALL retain the source timestamp's original UTC offset on that record.
2. IF a mapped timestamp carries no UTC offset, THEN THE OTT_Benchmarking_Engine SHALL interpret that timestamp as UTC, SHALL record that the source offset was absent, and SHALL flag that timestamp column in the Column_Mapping modal.
3. WHEN a mapped timestamp carries a calendar date without a time of day, THE OTT_Benchmarking_Engine SHALL anchor the record at 00:00:00 UTC of that calendar date.
4. IF a mapped timestamp cannot be parsed, THEN THE OTT_Benchmarking_Engine SHALL reject that record and SHALL record the rejection reason.
5. WHEN a record with a valid mapped timestamp is ingested, THE OTT_Benchmarking_Engine SHALL assign that record exactly one UTC hour Time_Bucket and exactly one UTC calendar day Time_Bucket.
6. WHEN hourly records are rolled up to their UTC calendar day, THE Aggregation_Engine SHALL combine the hourly values using that KPI's defined aggregation semantics rather than an unweighted arithmetic mean.
7. WHEN a custom date range is applied, THE OTT_Benchmarking_Engine SHALL include each record whose Time_Bucket falls on or after the range start and on or before the range end.
8. THE OTT_Benchmarking_Engine SHALL provide a display-timezone selection that changes rendered timestamp labels and exported timestamp labels only.
9. WHEN a user changes the display-timezone selection, THE OTT_Benchmarking_Engine SHALL retain the existing Time_Bucket boundaries and the existing computed KPI values.

### Requirement 27: Storage Capacity, Retention, and Manual Record Lifecycle

**User Story:** As a user working with large session logs, I want THE System to handle storage limits predictably and let me correct my own manual entries, so that a full storage quota or a typo never costs me a dataset.

#### Acceptance Criteria

1. WHEN a write of ingested records is initiated, THE OTT_Benchmarking_Engine SHALL estimate the remaining browser storage capacity before writing.
2. IF the projected payload of a write exceeds the estimated remaining storage capacity, THEN THE OTT_Benchmarking_Engine SHALL decline the write, SHALL display the affected Dataset name and the storage shortfall, and SHALL persist none of that write's records.
3. WHEN THE OTT_Benchmarking_Engine persists a Dataset for the first time, THE OTT_Benchmarking_Engine SHALL request persistent browser storage one time.
4. IF the persistent storage request is denied or is unsupported by the browser, THEN THE OTT_Benchmarking_Engine SHALL display an advisory that stored Datasets may be evicted under storage pressure and SHALL complete ingestion.
5. IF a write fails because the browser storage quota is exceeded, THEN THE OTT_Benchmarking_Engine SHALL roll back that entire write, SHALL preserve every previously persisted Dataset, and SHALL preserve the in-memory active Dataset.
6. THE OTT_Benchmarking_Engine SHALL provide a configurable maximum stored Dataset count and a configurable maximum record count per Dataset.
7. WHEN a configured retention ceiling is reached, THE OTT_Benchmarking_Engine SHALL present the oldest stored Datasets as deletion candidates and SHALL remove a Dataset only after the user confirms that removal.
8. THE OTT_Benchmarking_Engine SHALL allow a user to edit and to delete records whose origin is manual entry.
9. IF a user requests an edit or a deletion of a record whose origin is file ingestion or the Mock_Data_Seeder, THEN THE OTT_Benchmarking_Engine SHALL reject the request and SHALL display that only manually entered records can be modified.
10. WHEN a user requests deletion of a manually entered record, THE OTT_Benchmarking_Engine SHALL require user confirmation before removing that record.
11. WHEN a manually entered record is edited or deleted, THE OTT_Benchmarking_Engine SHALL re-compute the active Slice and SHALL re-render all affected dashboard modules.

### Requirement 28: Accessibility and Data Residency

**User Story:** As a user who may not distinguish colors or use a pointer, and whose data may contain personal identifiers, I want every status readable without color and all ingested data kept on my own device, so that the dashboard is usable and my data stays private.

#### Acceptance Criteria

1. WHEN a RAG_Status is displayed, THE OTT_Benchmarking_Engine SHALL convey that status through a color, a distinct icon or glyph, and a text label.
2. WHEN a Heatmap cell outcome is displayed, THE OTT_Benchmarking_Engine SHALL convey that outcome through a text label and a distinguishing glyph or fill pattern in addition to the cell's fill color.
3. THE OTT_Benchmarking_Engine SHALL render text at a contrast ratio of at least 4.5 to 1 against its background for normal text and at least 3 to 1 against its background for large text.
4. THE OTT_Benchmarking_Engine SHALL render every non-text indicator that carries meaning at a contrast ratio of at least 3 to 1 against adjacent colors.
5. THE OTT_Benchmarking_Engine SHALL make every interactive control operable by keyboard alone and SHALL display a visible focus indicator on the control that holds keyboard focus.
6. WHILE a modal dialog is open, THE OTT_Benchmarking_Engine SHALL confine keyboard focus to the controls within that dialog.
7. WHEN a modal dialog is dismissed, THE OTT_Benchmarking_Engine SHALL return keyboard focus to the control that invoked that dialog.
8. THE OTT_Benchmarking_Engine SHALL expose for every chart an accessible name and a textual or tabular alternative presenting the same series values.
9. WHILE a tabular view is rendered with virtualization, THE OTT_Benchmarking_Engine SHALL declare the total row count, the total column count, and each rendered row's index within the full row set.
10. THE OTT_Benchmarking_Engine SHALL retain all ingested data on the client device.
11. THE OTT_Benchmarking_Engine SHALL confine ingested record content, telemetry, and usage metrics to the client device so that each is transmitted to no external endpoint.
12. THE OTT_Benchmarking_Engine SHALL use mapped user identifier values only for Distinct_Count_KPI computation and SHALL omit user identifier values from every display and every export.
13. THE OTT_Benchmarking_Engine SHALL provide an option to replace each mapped user identifier value with a salted hash at ingestion.
