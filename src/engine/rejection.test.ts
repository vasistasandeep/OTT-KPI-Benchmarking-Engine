/**
 * Sanity unit tests for record rejection. The rejected-records equivalence
 * property (valid subset == full set, rejected count == invalid count) is
 * covered exhaustively by the dedicated property test (task 6.11).
 */

import { describe, it, expect } from "vitest";
import type { KPIRecord, RawSessionFields } from "../models/records";
import {
  validateSessions,
  screenPreAggregatedValue,
  collectPreAggregatedValues,
  type IdentifiedSession,
} from "./rejection";

function session(id: string, s: RawSessionFields): IdentifiedSession {
  return { id, session: s };
}

describe("validateSessions", () => {
  const required: (keyof RawSessionFields)[] = ["bufferingMs", "playTimeMs"];

  it("keeps sessions with all required fields present, numeric, and non-negative", () => {
    const sessions = [
      session("a", { bufferingMs: 0, playTimeMs: 100 }),
      session("b", { bufferingMs: 50, playTimeMs: 0 }),
    ];
    const { valid, rejected } = validateSessions(sessions, required);
    expect(valid).toHaveLength(2);
    expect(rejected).toHaveLength(0);
  });

  it("rejects a session missing a required field, naming the field", () => {
    const { valid, rejected } = validateSessions(
      [session("a", { bufferingMs: 10 })],
      required,
    );
    expect(valid).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].recordId).toBe("a");
    expect(rejected[0].field).toBe("playTimeMs");
    expect(rejected[0].reason).toContain("missing");
  });

  it("rejects a session with a non-numeric required field", () => {
    const bad = { bufferingMs: "oops" as unknown as number, playTimeMs: 100 };
    const { valid, rejected } = validateSessions([session("a", bad)], required);
    expect(valid).toHaveLength(0);
    expect(rejected[0].field).toBe("bufferingMs");
    expect(rejected[0].reason).toContain("non-numeric");
  });

  it("rejects a session with a negative required field", () => {
    const { valid, rejected } = validateSessions(
      [session("a", { bufferingMs: -1, playTimeMs: 100 })],
      required,
    );
    expect(valid).toHaveLength(0);
    expect(rejected[0].field).toBe("bufferingMs");
    expect(rejected[0].reason).toContain("negative");
  });

  it("treats NaN and Infinity as non-numeric", () => {
    const { rejected: nanRej } = validateSessions(
      [session("a", { bufferingMs: NaN, playTimeMs: 1 })],
      required,
    );
    expect(nanRej[0].reason).toContain("non-numeric");

    const { rejected: infRej } = validateSessions(
      [session("b", { bufferingMs: Infinity, playTimeMs: 1 })],
      required,
    );
    expect(infRej[0].reason).toContain("non-numeric");
  });

  it("partitions a mixed batch and rejected count equals invalid count", () => {
    const sessions = [
      session("ok1", { bufferingMs: 1, playTimeMs: 1 }),
      session("bad_missing", { bufferingMs: 1 }),
      session("ok2", { bufferingMs: 2, playTimeMs: 2 }),
      session("bad_neg", { bufferingMs: -5, playTimeMs: 1 }),
    ];
    const { valid, rejected } = validateSessions(sessions, required);
    expect(valid.map((v) => v.id)).toEqual(["ok1", "ok2"]);
    expect(rejected).toHaveLength(2);
  });
});

describe("screenPreAggregatedValue", () => {
  it("passes a finite number through", () => {
    expect(screenPreAggregatedValue("r1", "rebuffer_ratio", 0.42)).toEqual({
      value: 0.42,
    });
  });

  it("treats an absent value as no value without a report", () => {
    expect(screenPreAggregatedValue("r1", "rebuffer_ratio", undefined)).toEqual({
      value: null,
    });
  });

  it("excludes and reports a non-numeric value", () => {
    const result = screenPreAggregatedValue("r1", "rebuffer_ratio", "bad");
    expect(result.value).toBeNull();
    expect(result.rejected?.recordId).toBe("r1");
    expect(result.rejected?.field).toBe("rebuffer_ratio");
    expect(result.rejected?.reason).toContain("non-numeric");
  });

  it("excludes NaN and Infinity", () => {
    expect(screenPreAggregatedValue("r", "vsf", NaN).value).toBeNull();
    expect(screenPreAggregatedValue("r", "vsf", Infinity).rejected).toBeDefined();
  });
});

describe("collectPreAggregatedValues", () => {
  const rec = (id: string, value: unknown): KPIRecord =>
    ({
      id,
      metrics: { rebuffer_ratio: value as number },
    }) as KPIRecord;

  it("collects clean values and reports each excluded cell", () => {
    const records = [rec("a", 1), rec("b", "x"), rec("c", 3), rec("d", undefined)];
    const { values, rejected } = collectPreAggregatedValues(records, "rebuffer_ratio");
    expect(values).toEqual([1, 3]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].recordId).toBe("b");
  });
});
