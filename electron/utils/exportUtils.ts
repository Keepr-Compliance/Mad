/**
 * Shared Export Utilities
 *
 * Common formatting functions used by pdfExportService and folderExportService.
 * Extracted from duplicated implementations in both services (TASK-2030).
 */

import { dbAll } from "../services/db/core/dbConnection";
import { normalizePhone as sharedNormalizePhone } from "../services/contactResolutionService";
import logService from "../services/logService";
import { joinAmbiguousNames } from "../services/folderExport/threadContactLabel";

/**
 * Escape HTML entities in text to prevent XSS in generated HTML.
 * Uses a single regex with lookup map for efficiency.
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Format a number as USD currency.
 * Returns "N/A" for null/undefined/zero values.
 */
export function formatCurrency(amount?: number | null): string {
  if (!amount) return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(amount);
}

/**
 * Format a date string or Date object as a human-readable date.
 * Returns "N/A" for null/undefined values.
 * Example: "January 15, 2024"
 *
 * BACKLOG-2182: intended for DATE-ONLY values (audit period started_at/
 * closed_at, closing date) that are stored as UTC midnight. Formatting them
 * in the machine's local timezone (the previous behavior) rendered the
 * PREVIOUS calendar day for anyone west of UTC — `timeZone: "UTC"` matches
 * the reference implementation in TransactionDetailsTab.tsx's
 * `formatAuditDate` and reads back the same calendar day that was stored.
 * Do NOT use this for real event timestamps — see `formatDateTime`, which
 * intentionally stays in local time.
 */
export function formatDate(dateString?: string | Date | null): string {
  if (!dateString) return "N/A";
  const date =
    typeof dateString === "string" ? new Date(dateString) : dateString;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Format a date/instant in the user's LOCAL timezone (no UTC override).
 * Returns "N/A" for null/undefined values.
 * Example: "January 15, 2024"
 *
 * BACKLOG-2190: use this for REAL instants like the report's "Generated on"
 * timestamp — the moment the user pressed export, which must read as the local
 * calendar day. `formatDate` forces `timeZone: "UTC"` (correct only for the
 * date-only DB fields — audit period, closing date — stored at UTC midnight);
 * applying it to `new Date()` rolled the "Generated on" line forward a day for
 * anyone whose local evening is already the next UTC day (e.g. 20:24 PDT =
 * 04:24 UTC the following day). This local formatter fixes that line only and
 * leaves `formatDate` (UTC) untouched for the date-only fields.
 */
export function formatLocalDate(dateString?: string | Date | null): string {
  if (!dateString) return "N/A";
  const date =
    typeof dateString === "string" ? new Date(dateString) : dateString;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Format a date string or Date object as a human-readable date and time.
 * Returns "N/A" for null/undefined values.
 * Example: "Jan 15, 2024, 02:30 PM"
 */
export function formatDateTime(dateString: string | Date): string {
  if (!dateString) return "N/A";
  const date =
    typeof dateString === "string" ? new Date(dateString) : dateString;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * BACKLOG-2757 — the sync mirror of `contactResolutionService`'s accumulator.
 *
 * Same rule, deliberately duplicated rather than shared: this file is the
 * SYNCHRONOUS resolver (it runs inside HTML generation, which cannot await), and
 * the async one carries transaction/user scoping this path has no access to.
 * What must not differ is the DECISION — a handle naming two contacts reads
 * "A or B" in both, in the same declared order — so the join and the ordering
 * come from the one shared function.
 */
class SyncHandleAccumulator {
  private readonly entries = new Map<
    string,
    { aliases: Set<string>; names: Map<string, string> }
  >();

  add(canonicalKey: string, aliases: string[], contactId: string, name: string): void {
    let entry = this.entries.get(canonicalKey);
    if (!entry) {
      entry = { aliases: new Set(), names: new Map() };
      this.entries.set(canonicalKey, entry);
    }
    for (const alias of aliases) if (alias) entry.aliases.add(alias);
    const trimmed = name.trim();
    if (!trimmed) return;
    // Keyed by NAME: one contact reached through two stored number formats is
    // one name, and two contacts that read the same are not an ambiguity worth
    // printing.
    const existing = entry.names.get(trimmed);
    if (!existing || contactId < existing) entry.names.set(trimmed, contactId);
  }

  drainInto(result: Record<string, string>): void {
    for (const [, entry] of this.entries) {
      const names = Array.from(entry.names.entries())
        .sort((a, b) => {
          const byLabel = a[0].localeCompare(b[0], "en");
          return byLabel !== 0 ? byLabel : a[1].localeCompare(b[1]);
        })
        .map(([name]) => name);
      if (names.length === 0) continue;
      const label = joinAmbiguousNames(names);
      for (const alias of entry.aliases) {
        if (result[alias]) continue;
        result[alias] = label;
      }
    }
  }
}

/**
 * Look up contact names for phone numbers from imported contacts.
 * Synchronous version for use in HTML generation methods.
 *
 * Consolidated from pdfExportService and folderExportService (TASK-2030).
 * Uses the more robust SQL normalization from folderExportService
 * (strips +, -, and spaces before matching).
 */
export function getContactNamesByPhones(phones: string[]): Record<string, string> {
  if (phones.length === 0) return {};

  const result: Record<string, string> = {};

  try {
    // Normalize phones — email-safe (emails kept as-is, phones to last 10 digits)
    const normalizedPhones = phones.map((p) => sharedNormalizePhone(p));

    // Query contact_phones to find names
    const placeholders = normalizedPhones.map(() => "?").join(",");
    // BACKLOG-2757: `ORDER BY` and `contact_id`. This is the SECOND copy of the
    // handle->name resolution (the async one lives in contactResolutionService);
    // it had the same last-row-wins collapse, so it gets the same rule. Leaving
    // one copy deterministic and the other a coin flip is how the two paths would
    // start naming the same thread differently.
    const sql = `
      SELECT
        c.id AS contact_id,
        cp.phone_e164,
        cp.phone_display,
        c.display_name
      FROM contact_phones cp
      JOIN contacts c ON cp.contact_id = c.id
      WHERE substr(replace(replace(replace(cp.phone_e164, '+', ''), '-', ''), ' ', ''), -10) IN (${placeholders})
         OR substr(replace(replace(replace(cp.phone_display, '+', ''), '-', ''), ' ', ''), -10) IN (${placeholders})
      ORDER BY c.display_name COLLATE NOCASE, c.id
    `;

    const rows = dbAll<{
      contact_id: string;
      phone_e164: string;
      phone_display: string;
      display_name: string;
    }>(sql, [...normalizedPhones, ...normalizedPhones]);

    const acc = new SyncHandleAccumulator();
    for (const row of rows) {
      if (!row.display_name) continue;
      for (const stored of [row.phone_e164, row.phone_display]) {
        if (!stored) continue;
        const norm = sharedNormalizePhone(stored);
        if (!norm) continue;
        acc.add(norm, [norm, stored], row.contact_id, row.display_name);
      }
    }
    acc.drainInto(result);
  } catch (error) {
    logService.warn(
      "[Export] Failed to look up contact names from imported contacts",
      "ExportUtils",
      { error }
    );
  }

  return result;
}

/**
 * Look up contact names for email addresses from imported contacts.
 * Synchronous version for use in HTML generation methods.
 *
 * TASK-2288: Added to resolve iMessage email handles (e.g., user@gmail.com)
 * that were showing as "Unknown Contact" in PDF exports.
 */
export function getContactNamesByEmails(emails: string[]): Record<string, string> {
  if (emails.length === 0) return {};

  const result: Record<string, string> = {};

  try {
    const lowerEmails = emails.map((e) => e.toLowerCase());
    const placeholders = lowerEmails.map(() => "?").join(",");
    const sql = `
      SELECT
        c.id AS contact_id,
        LOWER(ce.email) as email,
        c.display_name
      FROM contact_emails ce
      JOIN contacts c ON ce.contact_id = c.id
      WHERE LOWER(ce.email) IN (${placeholders})
      ORDER BY c.display_name COLLATE NOCASE, c.id
    `;

    const rows = dbAll<{ contact_id: string; email: string; display_name: string }>(
      sql,
      lowerEmails
    );

    const acc = new SyncHandleAccumulator();
    for (const row of rows) {
      if (!row.display_name || !row.email) continue;
      // Also store original-case version for direct lookup
      const original = emails.find((e) => e.toLowerCase() === row.email);
      acc.add(
        row.email,
        original ? [row.email, original] : [row.email],
        row.contact_id,
        row.display_name
      );
    }
    acc.drainInto(result);
  } catch (error) {
    logService.warn(
      "[Export] Failed to look up contact names from imported contacts (emails)",
      "ExportUtils",
      { error }
    );
  }

  return result;
}

/**
 * Look up contact names for a mixed set of handles (phones + emails).
 * Partitions handles by type and calls the appropriate sync resolver.
 *
 * TASK-2288: Provides complete contact resolution for export code that
 * needs to resolve all participant types (phone numbers, email handles).
 */
export function getContactNamesByHandles(handles: string[]): Record<string, string> {
  if (handles.length === 0) return {};

  const phones: string[] = [];
  const emails: string[] = [];

  for (const handle of handles) {
    if (!handle || handle.trim() === "") continue;
    if (handle.includes("@")) {
      emails.push(handle);
    } else {
      phones.push(handle);
    }
  }

  const phoneResults = getContactNamesByPhones(phones);
  const emailResults = getContactNamesByEmails(emails);

  return { ...phoneResults, ...emailResults };
}
