/**
 * Unit tests for the FileParser: extension routing (CSV / XLSX / JSON) and the
 * ParseError failure path with file name + reason (Req 6.1, 6.2, 6.3).
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseFile, ParseError, SAMPLE_SIZE } from "./file-parser";

/** Build a jsdom File from string content. */
function textFile(name: string, content: string): File {
  return new File([content], name, { type: "text/plain" });
}

/** Build an XLSX File from a 2D array of rows (first row = headers). */
function xlsxFile(name: string, matrix: unknown[][]): File {
  const sheet = XLSX.utils.aoa_to_sheet(matrix);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new File([buffer], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("parseFile — CSV routing (Req 6.1)", () => {
  it("parses CSV into headers, rows, and per-column samples", async () => {
    const csv = "platform,vst_ms\nios,1200\nandroid,900\n";
    const result = await parseFile(textFile("metrics.csv", csv));

    expect(result.headers).toEqual(["platform", "vst_ms"]);
    expect(result.rows).toEqual([
      { platform: "ios", vst_ms: "1200" },
      { platform: "android", vst_ms: "900" },
    ]);
    expect(result.sampleValues.platform).toEqual(["ios", "android"]);
    expect(result.sampleValues.vst_ms).toEqual(["1200", "900"]);
  });

  it("trims header whitespace", async () => {
    const csv = " platform , vst_ms \nios,1200\n";
    const result = await parseFile(textFile("metrics.csv", csv));
    expect(result.headers).toEqual(["platform", "vst_ms"]);
  });

  it("caps samples at SAMPLE_SIZE and skips empty cells", async () => {
    const header = "col\n";
    const body = ["a", "", "b", "c", "d", "e", "f"].join("\n");
    const result = await parseFile(textFile("s.csv", header + body + "\n"));
    expect(result.sampleValues.col).toHaveLength(SAMPLE_SIZE);
    expect(result.sampleValues.col).not.toContain("");
  });
});

describe("parseFile — XLSX routing (Req 6.1)", () => {
  it("parses the first worksheet into headers and stringified rows", async () => {
    const file = xlsxFile("book.xlsx", [
      ["platform", "vst_ms"],
      ["ios", 1200],
      ["android", 900],
    ]);
    const result = await parseFile(file);

    expect(result.headers).toEqual(["platform", "vst_ms"]);
    expect(result.rows).toEqual([
      { platform: "ios", vst_ms: "1200" },
      { platform: "android", vst_ms: "900" },
    ]);
    expect(result.sampleValues.vst_ms).toEqual(["1200", "900"]);
  });

  it("also routes the .xls extension through SheetJS", async () => {
    const file = xlsxFile("legacy.xls", [
      ["k"],
      ["v"],
    ]);
    const result = await parseFile(file);
    expect(result.headers).toEqual(["k"]);
    expect(result.rows).toEqual([{ k: "v" }]);
  });
});

describe("parseFile — JSON routing (Req 6.1)", () => {
  it("parses a JSON array of records", async () => {
    const json = JSON.stringify([
      { platform: "ios", vst_ms: 1200 },
      { platform: "android", vst_ms: 900 },
    ]);
    const result = await parseFile(textFile("data.json", json));

    expect(result.headers).toEqual(["platform", "vst_ms"]);
    expect(result.rows).toEqual([
      { platform: "ios", vst_ms: "1200" },
      { platform: "android", vst_ms: "900" },
    ]);
  });

  it("unions keys across sparse rows so no column is lost", async () => {
    const json = JSON.stringify([
      { a: 1 },
      { b: 2 },
    ]);
    const result = await parseFile(textFile("sparse.json", json));
    expect(result.headers).toEqual(["a", "b"]);
    expect(result.rows).toEqual([
      { a: "1", b: "" },
      { a: "", b: "2" },
    ]);
  });

  it("accepts an object wrapper with a records array", async () => {
    const json = JSON.stringify({ records: [{ a: 1 }] });
    const result = await parseFile(textFile("wrapped.json", json));
    expect(result.headers).toEqual(["a"]);
    expect(result.rows).toEqual([{ a: "1" }]);
  });
});

describe("parseFile — ParseError path (Req 6.3)", () => {
  it("throws ParseError naming the file for an unsupported extension", async () => {
    await expect(parseFile(textFile("notes.txt", "hi"))).rejects.toMatchObject({
      name: "ParseError",
      fileName: "notes.txt",
    });
  });

  it("carries the file name and a reason on invalid JSON", async () => {
    let error: unknown;
    try {
      await parseFile(textFile("broken.json", "{ not json"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ParseError);
    const pe = error as ParseError;
    expect(pe.fileName).toBe("broken.json");
    expect(pe.reason).toContain("JSON");
    expect(pe.message).toContain("broken.json");
  });

  it("rejects a file with no data rows", async () => {
    await expect(
      parseFile(textFile("empty.csv", "platform,vst_ms\n")),
    ).rejects.toBeInstanceOf(ParseError);
  });

  it("rejects a JSON payload that is not an array of records", async () => {
    await expect(
      parseFile(textFile("scalar.json", "42")),
    ).rejects.toBeInstanceOf(ParseError);
  });

  it("rejects a file with no extension", async () => {
    await expect(parseFile(textFile("README", "x"))).rejects.toMatchObject({
      name: "ParseError",
      fileName: "README",
    });
  });
});
