import Table from "cli-table3";
import { stringify as yamlStringify } from "yaml";

export type OutputFormat = "json" | "yaml" | "table";

export interface FormatOptions {
  /**
   * Columns to project when formatting as a table. If omitted, the table
   * inspects the first row to derive headers automatically.
   */
  columns?: string[];
}

/** Render a value for CLI output in the requested format. */
export function formatOutput(
  data: unknown,
  format: OutputFormat,
  options: FormatOptions = {}
): string {
  switch (format) {
    case "json":
      return JSON.stringify(data, null, 2);
    case "yaml":
      return yamlStringify(data).trimEnd();
    case "table":
      return formatTable(data, options);
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown output format: ${_exhaustive}`);
    }
  }
}

/**
 * Render an array of objects as an ASCII table. Scalars and non-array values
 * fall back to JSON so the caller never gets an unreadable result.
 */
function formatTable(data: unknown, options: FormatOptions): string {
  if (!Array.isArray(data)) {
    // Emby paginated results come wrapped in { Items, TotalRecordCount } —
    // unwrap for a nicer table.
    if (data && typeof data === "object" && Array.isArray((data as any).Items)) {
      return formatTable((data as any).Items, options);
    }
    return JSON.stringify(data, null, 2);
  }
  if (data.length === 0) return "(no results)";

  const headers = options.columns ?? deriveColumns(data);
  const table = new Table({ head: headers });
  for (const row of data) {
    table.push(headers.map((h) => stringifyCell((row as any)?.[h])));
  }
  return table.toString();
}

function deriveColumns(rows: unknown[]): string[] {
  const first = rows[0];
  if (!first || typeof first !== "object") return ["value"];
  // Prefer a stable subset of common Emby fields when present; otherwise all keys.
  const preferred = ["Id", "Name", "Type", "UserName", "ServerName", "Version"];
  const keys = Object.keys(first);
  const picks = preferred.filter((p) => keys.includes(p));
  return picks.length > 0 ? picks : keys.slice(0, 6);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
