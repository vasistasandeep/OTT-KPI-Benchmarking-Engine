import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DIMENSION_IDS,
  DIMENSION_REGISTRY,
  UNKNOWN_MEMBER,
  getDimensionDefinition,
  type DimensionDefinition,
  type DimensionId,
} from "./dimensions";

describe("dimension registry", () => {
  it("UNKNOWN_MEMBER is the defined 'Unknown' member (Req 16.2)", () => {
    expect(UNKNOWN_MEMBER).toBe("Unknown");
  });

  it("defines exactly the five slicing dimensions (Req 2.1-2.5)", () => {
    expect(DIMENSION_IDS).toEqual([
      "platform",
      "network",
      "cdn",
      "geography",
      "streamType",
    ]);
  });

  it("marks every dimension extensible so unknown values can be appended (Req 2.6, 2.7)", () => {
    for (const d of DIMENSION_REGISTRY) {
      expect(d.extensible).toBe(true);
    }
  });

  it("seeds the Platform dimension with all required form factors (Req 2.1)", () => {
    const platform = getDimensionDefinition("platform");
    expect(platform.members).toEqual(
      expect.arrayContaining([
        "Tizen",
        "WebOS",
        "Android TV",
        "Apple TV",
        "FireTV",
        "iOS",
        "Android",
        "Desktop Web",
      ]),
    );
  });

  it("seeds the Network dimension with connection types and named ISPs (Req 2.2)", () => {
    const network = getDimensionDefinition("network");
    expect(network.members).toEqual(
      expect.arrayContaining(["Wi-Fi", "Cellular 5G", "Cellular 4G", "Broadband"]),
    );
    // At least one named ISP is seeded to demonstrate ISP support (Req 2.2).
    const connectionTypes = new Set([
      "Wi-Fi",
      "Cellular 5G",
      "Cellular 4G",
      "Broadband",
    ]);
    const namedIsps = network.members.filter((m) => !connectionTypes.has(m));
    expect(namedIsps.length).toBeGreaterThan(0);
  });

  it("seeds the CDN dimension with the required providers (Req 2.3)", () => {
    const cdn = getDimensionDefinition("cdn");
    expect(cdn.members).toEqual(
      expect.arrayContaining(["Akamai", "Cloudflare", "Fastly", "AWS CloudFront"]),
    );
  });

  it("seeds the Geography dimension with Country/Region/Metro levels (Req 2.4)", () => {
    const geography = getDimensionDefinition("geography");
    expect(geography.members).toEqual(
      expect.arrayContaining(["Country", "Region", "Metro"]),
    );
  });

  it("seeds the Stream Type dimension with the required stream types (Req 2.5)", () => {
    const streamType = getDimensionDefinition("streamType");
    expect(streamType.members).toEqual(
      expect.arrayContaining([
        "Live Sports/Events",
        "VOD Movies",
        "VOD Series",
        "FAST linear",
      ]),
    );
  });

  it("getDimensionDefinition returns the matching definition for every id", () => {
    for (const id of DIMENSION_IDS) {
      const def = getDimensionDefinition(id);
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(0);
    }
  });

  // Property: every registered dimension is well-formed and its members are a
  // non-empty set of unique, non-empty strings, so it is safe to filter/group
  // and aggregate a KPI across it (Req 2.6).
  it("every dimension has unique, non-empty seed members (Req 2.6)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DimensionDefinition>(...DIMENSION_REGISTRY),
        (dim) => {
          expect(dim.members.length).toBeGreaterThan(0);
          for (const m of dim.members) {
            expect(typeof m).toBe("string");
            expect(m.length).toBeGreaterThan(0);
          }
          const unique = new Set(dim.members);
          return unique.size === dim.members.length;
        },
      ),
      { numRuns: 50 },
    );
  });

  // Property: an ingested value never present in any seed set can be appended
  // as a new member without collision, modeling the extensibility contract
  // (Req 2.7). We simulate the append and assert the value becomes a member.
  it("unknown ingested values can be appended as new members (Req 2.7)", () => {
    const allSeeds = new Set(
      DIMENSION_REGISTRY.flatMap((d) => d.members),
    );
    fc.assert(
      fc.property(
        fc.constantFrom<DimensionId>(...DIMENSION_IDS),
        fc.string({ minLength: 1 }).filter((s) => !allSeeds.has(s)),
        (id, value) => {
          const def = getDimensionDefinition(id);
          const extended = def.extensible
            ? [...def.members, value]
            : def.members;
          return extended.includes(value);
        },
      ),
      { numRuns: 100 },
    );
  });
});
