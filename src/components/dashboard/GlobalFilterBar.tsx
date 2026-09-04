import * as React from "react";
import { CalendarRange, Globe, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AppAssignment, DimensionId } from "@/models";
import {
  DIMENSION_REGISTRY,
  UNKNOWN_MEMBER,
} from "@/registry/dimensions";
import {
  defaultFilterSlice,
  useDatasetStore,
  useFilterStore,
} from "@/stores";

/**
 * GlobalFilterBar — the persistent, sticky top filter bar that constrains the
 * whole dashboard to one slice (Req 10.1–10.4; design "Global Filter bar").
 *
 * It is the single UI surface for the {@link FilterSlice}: a date-range control
 * (Last 7 Days / Last 30 Days / custom), five multi-select dimension chip
 * groups (platform, network, cdn, geography, streamType), an App_A/App_B
 * toggle, a display-timezone selector (UTC default, active zone labelled), and
 * a slot for the Export menu that later tasks (18.x) fill in.
 *
 * Every control writes straight to {@link useFilterStore}. The store bumps its
 * `revision` on each change, which the recompute pipeline (`recompute.ts`)
 * subscribes to and debounces into a re-aggregation, so changing a filter here
 * re-computes and re-renders every module (Req 10.5) without this component
 * knowing anything about the engine.
 *
 * The bar is `sticky top-0` so it stays visible while the content area scrolls
 * (Req 10.1). Its RAG/accent colors resolve against the dark-theme token layer
 * in `index.css` (Req 15.1); nothing here hard-codes a color.
 */

/** The three date-range presets the control offers (Req 10.2). */
const DATE_PRESETS: { value: "7d" | "30d" | "custom"; label: string }[] = [
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "custom", label: "Custom" },
];

/** The App_A/App_B toggle options, paired with the active dataset's labels. */
const APP_OPTIONS: AppAssignment[] = ["App_A", "App_B"];

/**
 * A curated set of display timezones offered in the selector. The value is an
 * IANA zone (or "UTC"); it is a rendering-only concern and never changes which
 * records are in the slice (Req 26.8). UTC is the default so a date range is
 * never ambiguous (Req 26.9).
 */
const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: "UTC", label: "UTC (default)" },
  { value: "America/New_York", label: "US Eastern" },
  { value: "America/Los_Angeles", label: "US Pacific" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Berlin", label: "Central Europe" },
  { value: "Asia/Kolkata", label: "India" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Tokyo", label: "Japan" },
];

export interface GlobalFilterBarProps {
  /**
   * Optional Export menu rendered into the bar's trailing slot. Later tasks
   * (18.x) supply the real menu; until then the slot stays empty.
   */
  exportSlot?: React.ReactNode;
  className?: string;
}

/** A single toggle chip used by the dimension groups and the app toggle. */
function Chip({
  label,
  selected,
  onToggle,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={onToggle}
      className={cn(
        "rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/15 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/** One labelled multi-select chip group for a single dimension (Req 10.3). */
function DimensionChipGroup({
  dimension,
  name,
  members,
  selected,
  onChange,
}: {
  dimension: DimensionId;
  name: string;
  members: readonly string[];
  selected: readonly string[];
  onChange: (dimension: DimensionId, members: string[]) => void;
}) {
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  const toggle = (member: string) => {
    const next = new Set(selectedSet);
    if (next.has(member)) {
      next.delete(member);
    } else {
      next.add(member);
    }
    onChange(dimension, [...next]);
  };

  const groupId = React.useId();

  return (
    <div
      role="group"
      aria-labelledby={groupId}
      className="flex min-w-0 flex-col gap-1"
    >
      <span
        id={groupId}
        className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {name}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {members.map((member) => (
          <Chip
            key={member}
            label={member}
            selected={selectedSet.has(member)}
            onToggle={() => toggle(member)}
          />
        ))}
      </div>
    </div>
  );
}

export function GlobalFilterBar({ exportSlot, className }: GlobalFilterBarProps) {
  const slice = useFilterStore((s) => s.slice);
  const setDateRange = useFilterStore((s) => s.setDateRange);
  const setDimensionSelection = useFilterStore((s) => s.setDimensionSelection);
  const setApps = useFilterStore((s) => s.setApps);
  const setDisplayTimezone = useFilterStore((s) => s.setDisplayTimezone);
  const setSlice = useFilterStore((s) => s.setSlice);

  const appALabel = useDatasetStore((s) => s.appALabel);
  const appBLabel = useDatasetStore((s) => s.appBLabel);

  const appLabelOf = (app: AppAssignment): string =>
    app === "App_A" ? appALabel : appBLabel;

  const appsSet = React.useMemo(() => new Set(slice.apps), [slice.apps]);

  /** Toggle an app on/off. An empty selection means "all apps" downstream, so
   *  we never let the user deselect the final remaining app (Req 10.4). */
  const toggleApp = (app: AppAssignment) => {
    const next = new Set(appsSet);
    if (next.has(app)) {
      if (next.size === 1) return; // keep at least one app selected
      next.delete(app);
    } else {
      next.add(app);
    }
    // Preserve the canonical App_A, App_B order.
    setApps(APP_OPTIONS.filter((a) => next.has(a)));
  };

  const isCustom = slice.dateRange.preset === "custom";

  return (
    <div
      data-testid="global-filter-bar"
      className={cn(
        "sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur",
        "supports-[backdrop-filter]:bg-background/80",
        className,
      )}
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        {/* Row 1: date range, app toggle, timezone, export slot */}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-end gap-6">
            {/* Date-range control (Req 10.2) */}
            <div className="flex flex-col gap-1" role="group" aria-label="Date range">
              <span className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                <CalendarRange className="size-3" aria-hidden="true" />
                Date range
              </span>
              <div className="flex items-center gap-1">
                {DATE_PRESETS.map((preset) => (
                  <Button
                    key={preset.value}
                    size="sm"
                    variant={
                      slice.dateRange.preset === preset.value ? "default" : "outline"
                    }
                    aria-pressed={slice.dateRange.preset === preset.value}
                    onClick={() =>
                      setDateRange(
                        preset.value === "custom"
                          ? {
                              preset: "custom",
                              from: slice.dateRange.from,
                              to: slice.dateRange.to,
                            }
                          : { preset: preset.value },
                      )
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              {isCustom && (
                <div className="mt-1 flex items-center gap-2">
                  <label className="flex items-center gap-1 text-2xs text-muted-foreground">
                    <span>From</span>
                    <input
                      type="date"
                      aria-label="Custom range start"
                      value={slice.dateRange.from ?? ""}
                      onChange={(e) =>
                        setDateRange({
                          preset: "custom",
                          from: e.target.value || undefined,
                          to: slice.dateRange.to,
                        })
                      }
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-2xs text-muted-foreground">
                    <span>To</span>
                    <input
                      type="date"
                      aria-label="Custom range end"
                      value={slice.dateRange.to ?? ""}
                      onChange={(e) =>
                        setDateRange({
                          preset: "custom",
                          from: slice.dateRange.from,
                          to: e.target.value || undefined,
                        })
                      }
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </label>
                </div>
              )}
            </div>

            {/* App_A / App_B toggle (Req 10.4) */}
            <div className="flex flex-col gap-1" role="group" aria-label="Apps">
              <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Apps
              </span>
              <div className="flex items-center gap-1">
                {APP_OPTIONS.map((app) => (
                  <Chip
                    key={app}
                    label={appLabelOf(app)}
                    selected={appsSet.has(app)}
                    onToggle={() => toggleApp(app)}
                  />
                ))}
              </div>
            </div>

            {/* Display-timezone selector (Req 10, 26.8) */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="display-timezone"
                className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                <Globe className="size-3" aria-hidden="true" />
                Display timezone
              </label>
              <div className="flex items-center gap-2">
                <select
                  id="display-timezone"
                  value={slice.displayTimezone}
                  onChange={(e) => setDisplayTimezone(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
                <span
                  data-testid="active-timezone"
                  className="rounded bg-secondary px-1.5 py-0.5 text-2xs font-medium text-secondary-foreground"
                >
                  {slice.displayTimezone}
                </span>
              </div>
            </div>
          </div>

          {/* Trailing: reset + Export menu slot (filled by task 18.x) */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSlice(defaultFilterSlice())}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Reset
            </Button>
            <div data-testid="export-slot">{exportSlot}</div>
          </div>
        </div>

        {/* Row 2: the five dimension chip groups (Req 10.3) */}
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {DIMENSION_REGISTRY.map((dim) => (
            <DimensionChipGroup
              key={dim.id}
              dimension={dim.id}
              name={dim.name}
              // Offer the seed members plus the defined Unknown bucket so an
              // analyst can isolate records missing this dimension (Req 16.2).
              members={[...dim.members, UNKNOWN_MEMBER]}
              selected={slice.dimensionSelections[dim.id] ?? []}
              onChange={setDimensionSelection}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
