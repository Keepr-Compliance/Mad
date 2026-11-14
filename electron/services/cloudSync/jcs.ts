/**
 * Keepr Cloud content hash — BACKLOG-4243.
 *
 * `content_hash = lowercase hex SHA-256 of the UTF-8 bytes of JCS(dto)`
 * (RFC 8785 for the values a DTO can hold: objects, arrays, strings, finite
 * numbers, booleans, null). Keys sort by UTF-16 code units (the default JS
 * sort); strings use JSON.stringify escaping; numbers use Number#toString.
 * Vectors: scratchpad/4236/prebuild.md §(b), asserted in jcs-4243.test.ts.
 */
import { createHash } from "crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function jcs(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => jcs(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function contentHash(dto: JsonValue): string {
  return sha256Hex(jcs(dto));
}
