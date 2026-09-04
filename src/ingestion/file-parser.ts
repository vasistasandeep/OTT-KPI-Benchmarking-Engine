/**
 * FileParser — the entry point of the ingestion pipeline.
 *
 * Routes an uploaded file by extension to the appropriate reader
 * (Papaparse for CSV, SheetJS for XLSX/XLS, `JSON.parse` for JSON) and
 * returns a uniform {@link ParsedFile}: the ordered header set, the parsed
 * rows as header→cell string maps, and a small per-column sample of parsed
 * values for the mapping preview (Req 6.2).
 *
 * On any failure — unreadable file, unsupported extension, malformed content,
 * or a schema that yields no rows/columns — it throws a {@link ParseError}
 * carrying the offending file name and a human-readable reason so the UI can
 * show a banner that names both (Req 6.3).
 *
 * This module is pure with respect to storage and the DOM: it reads the given
 * `File`/`Blob` and returns data. It does not persist anything.
 *
 * Requirements: 6.1, 6.2, 6.3.
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";

/** A single parsed row: header name → raw cell value as a string. */
export type ParsedRow = Record<string, string>;

/**
 * Uniform result of parsing any supported file type.
 *
 * - `headers` preserves source column order.
 * - `rows` holds every data row keyed by header; every cell is stringified so
 *   downstream unit/type inference sees one representation regardless of source.
 * - `sampleValues` maps each header to up to {@link SAMPLE_SIZE} non-empty
 *   example values, for the mapping-modal preview (Req 6.2).
 */
export interface ParsedFile {
  headers: string[];
  rows: ParsedRow[];
  sampleValues: Record<string, string[]>;
}

/**
 * Thrown when a file cannot be parsed into records. Carries the file name and
 * the parsing-failure reason so the ingestion UI can name both (Req 6.3).
 */
export class ParseError extends Error {
  readonly fileName: string;
  readonly reason: string;

  constructor(fileName: string, reason: string) {
    super(`Could not parse "${fileName}": ${reason}`);
    this.name = "ParseError";
    this.fileName = fileName;
    this.reason = reason;
  }
}

/** How many example values per column to collect for the preview. */
export const SAMPLE_SIZE = 5;

type SupportedExtension = "csv" | "xlsx" | "xls" | "json";

/** Extract the lowercased extension, or `undefined` when there is none. */
function extensionOf(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return undefined;
  return fileName.slice(dot + 1).toLowerCase();
}

/** Normalize any cell into the string representation used downstream. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Assemble a {@link ParsedFile} from an ordered header list and a set of rows
 * expressed as header→value maps. Every cell is stringified, headers are taken
 * in source order, and per-column samples are collected from the first
 * non-empty values seen.
 */
function toParsedFile(
  fileName: string,
  headers: string[],
  rawRows: Record<string, unknown>[],
): ParsedFile {
  const trimmedHeaders = headers.map((h) => String(h).trim());
  if (trimmedHeaders.length === 0) {
    throw new ParseError(fileName, "the file contains no columns");
  }
  if (rawRows.length === 0) {
    throw new ParseError(fileName, "the file contains no data rows");
  }

  const rows: ParsedRow[] = rawRows.map((raw) => {
    const row: ParsedRow = {};
    for (const header of trimmedHeaders) {
      row[header] = cellToString(raw[header]);
    }
    return row;
  });

  const sampleValues: Record<string, string[]> = {};
  for (const header of trimmedHeaders) {
    const samples: string[] = [];
    for (const row of rows) {
      if (samples.length >= SAMPLE_SIZE) break;
      const value = row[header];
      if (value !== "") samples.push(value);
    }
    sampleValues[header] = samples;
  }

  return { headers: trimmedHeaders, rows, sampleValues };
}

/** Read a Blob via the FileReader API, for environments lacking Blob.text/arrayBuffer. */
function readWithFileReader(
  file: Blob,
  as: "text" | "arrayBuffer",
): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    if (as === "text") reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

/** Read a File/Blob as text, surfacing read failures as a ParseError. */
async function readAsText(file: Blob, fileName: string): Promise<string> {
  try {
    if (typeof file.text === "function") return await file.text();
    return (await readWithFileReader(file, "text")) as string;
  } catch (err) {
    throw new ParseError(
      fileName,
      `the file could not be read (${(err as Error).message})`,
    );
  }
}

/** Read a File/Blob as an ArrayBuffer, surfacing read failures. */
async function readAsArrayBuffer(
  file: Blob,
  fileName: string,
): Promise<ArrayBuffer> {
  try {
    if (typeof file.arrayBuffer === "function") return await file.arrayBuffer();
    return (await readWithFileReader(file, "arrayBuffer")) as ArrayBuffer;
  } catch (err) {
    throw new ParseError(
      fileName,
      `the file could not be read (${(err as Error).message})`,
    );
  }
}

/** Parse CSV text via Papaparse into header-keyed rows. */
function parseCsv(fileName: string, text: string): ParsedFile {
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  // `UndetectableDelimiter` is a non-fatal warning Papaparse emits for
  // single-column files; parsing still succeeds, so it is not a ParseError.
  const fatal = result.errors.filter((e) => e.code !== "UndetectableDelimiter");
  if (fatal.length > 0) {
    const first = fatal[0];
    throw new ParseError(
      fileName,
      `CSV parse error on row ${first.row ?? "?"}: ${first.message}`,
    );
  }

  const headers = result.meta.fields ?? [];
  return toParsedFile(fileName, headers, result.data);
}

/** Parse an XLSX/XLS workbook via SheetJS, using the first worksheet. */
function parseXlsx(fileName: string, buffer: ArrayBuffer): ParsedFile {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch (err) {
    throw new ParseError(
      fileName,
      `the workbook could not be read (${(err as Error).message})`,
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new ParseError(fileName, "the workbook contains no worksheets");
  }
  const sheet = workbook.Sheets[sheetName];

  // Read as a matrix so we can capture headers even when some columns are blank.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    raw: true,
  });

  if (matrix.length === 0) {
    throw new ParseError(fileName, "the first worksheet is empty");
  }

  const headerRow = matrix[0].map((h) => cellToString(h));
  const dataRows = matrix.slice(1).map((cells) => {
    const raw: Record<string, unknown> = {};
    headerRow.forEach((header, i) => {
      raw[header] = cells[i];
    });
    return raw;
  });

  return toParsedFile(fileName, headerRow, dataRows);
}

/**
 * Parse JSON text. Accepts either an array of row objects or an object with a
 * `records`/`rows`/`data` array property; the union of all row keys becomes the
 * header set so sparse rows do not lose columns.
 */
function parseJson(fileName: string, text: string): ParsedFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ParseError(
      fileName,
      `invalid JSON (${(err as Error).message})`,
    );
  }

  let rows: unknown;
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    rows = obj.records ?? obj.rows ?? obj.data;
  }

  if (!Array.isArray(rows)) {
    throw new ParseError(
      fileName,
      "expected a JSON array of records (or an object with a records/rows/data array)",
    );
  }

  const objectRows = rows.filter(
    (r): r is Record<string, unknown> =>
      r !== null && typeof r === "object" && !Array.isArray(r),
  );
  if (objectRows.length === 0) {
    throw new ParseError(fileName, "the JSON contains no record objects");
  }

  const headerOrder: string[] = [];
  const seen = new Set<string>();
  for (const row of objectRows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headerOrder.push(key);
      }
    }
  }

  return toParsedFile(fileName, headerOrder, objectRows);
}

/**
 * Parse an uploaded file into a {@link ParsedFile}, routing by extension.
 *
 * @throws {ParseError} when the extension is unsupported or the content cannot
 *   be parsed into at least one column and one row.
 */
export async function parseFile(file: File): Promise<ParsedFile> {
  const fileName = file.name || "unnamed file";
  const ext = extensionOf(fileName) as SupportedExtension | undefined;

  switch (ext) {
    case "csv":
      return parseCsv(fileName, await readAsText(file, fileName));
    case "xlsx":
    case "xls":
      return parseXlsx(fileName, await readAsArrayBuffer(file, fileName));
    case "json":
      return parseJson(fileName, await readAsText(file, fileName));
    default:
      throw new ParseError(
        fileName,
        ext
          ? `unsupported file type ".${ext}" (expected .csv, .xlsx, or .json)`
          : "the file has no recognizable extension (expected .csv, .xlsx, or .json)",
      );
  }
}
