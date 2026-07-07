/**
 * Canonical checklist parser for the QA harness (BACKLOG-1848).
 *
 * Reads the versioned markdown checklist (docs/qa/tx1-canonical-list-v2.20.0.md)
 * and derives the machine-checkable expected sets. The markdown is the SINGLE
 * source of truth for expected membership; this module turns it into
 * `CanonicalEmail[]` keyed by (subject, shiftedDate).
 *
 * Table shape (pipe-delimited):
 *   | # | .eml file | Subject | Shifted date | Matched contact(s) & role | ON-subset | DB |
 *
 * Subjects may contain markdown-escaped pipes (`\|`), so cells are split on
 * unescaped pipes only and then unescaped.
 */
import { readFileSync } from 'fs';
import type { CanonicalEmail, ExpectedSets, ExpectedCounts } from './types';

/** Split a markdown table row into trimmed, unescaped cells. */
function splitRow(row: string): string[] {
  // Drop the leading/trailing pipe, then split on pipes not preceded by `\`.
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** True for a data row of the checklist table (starts with `| <number> |`). */
function isDataRow(line: string): boolean {
  return /^\|\s*\d+\s*\|/.test(line.trim());
}

export interface ParsedCanonicalList {
  emails: CanonicalEmail[];
  /** filter-OFF set = every row. */
  filterOff: CanonicalEmail[];
  /** filter-ON subset = rows with onSubset === true. */
  filterOn: CanonicalEmail[];
  /**
   * Legitimate (subject, shifted-date) collisions — distinct emails that share
   * the same set-identity key (e.g. a reply and its predecessor sent the same
   * day). These are NOT errors: the set-identity rule is a MULTISET, so both
   * rows must be present and matched by multiplicity. Exposed so the H3 DB
   * asserter (BACKLOG-1850) can reason about expected key multiplicity.
   */
  collisions: CanonicalEmail[][];
}

/** Parse canonical-list markdown text into structured rows. */
export function parseCanonicalList(markdown: string): ParsedCanonicalList {
  const emails: CanonicalEmail[] = [];
  const byKey = new Map<string, CanonicalEmail[]>();

  for (const raw of markdown.split(/\r?\n/)) {
    if (!isDataRow(raw)) continue;
    const cells = splitRow(raw);
    if (cells.length < 6) {
      throw new Error(
        `Malformed checklist row (expected >=6 cells, got ${cells.length}): ${raw}`,
      );
    }
    const [idxStr, emlFile, subject, shiftedDate, matchedContacts, onSubsetStr] =
      cells;

    const index = Number.parseInt(idxStr, 10);
    if (Number.isNaN(index)) {
      throw new Error(`Malformed checklist row index: ${raw}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftedDate)) {
      throw new Error(
        `Checklist row ${index} has a non-ISO shifted date: "${shiftedDate}"`,
      );
    }

    const onNormalized = onSubsetStr.toLowerCase();
    if (onNormalized !== 'yes' && onNormalized !== 'no') {
      throw new Error(
        `Checklist row ${index} has an unrecognized ON-subset value: "${onSubsetStr}"`,
      );
    }

    const email: CanonicalEmail = {
      index,
      emlFile,
      subject,
      shiftedDate,
      matchedContacts,
      onSubset: onNormalized === 'yes',
    };

    const key = `${email.subject}␟${email.shiftedDate}`;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(email);
    } else {
      byKey.set(key, [email]);
    }
    emails.push(email);
  }

  if (emails.length === 0) {
    throw new Error('Canonical checklist contained no data rows.');
  }

  const collisions = [...byKey.values()].filter((bucket) => bucket.length > 1);

  return {
    emails,
    filterOff: emails,
    filterOn: emails.filter((e) => e.onSubset),
    collisions,
  };
}

/** Read + parse a canonical-list markdown file from disk. */
export function loadCanonicalList(filePath: string): ParsedCanonicalList {
  const markdown = readFileSync(filePath, 'utf-8');
  return parseCanonicalList(markdown);
}

/**
 * Assemble `ExpectedSets` from parsed rows + the scenario's declared counts,
 * asserting the parsed markdown agrees with the manifest's exact counts.
 * A mismatch here is a documentation bug (the two sources of truth drifted).
 */
export function toExpectedSets(
  parsed: ParsedCanonicalList,
  counts: ExpectedCounts,
): ExpectedSets {
  if (parsed.filterOff.length !== counts.filterOff) {
    throw new Error(
      `Canonical checklist filter-OFF rows (${parsed.filterOff.length}) ` +
        `!= manifest expectedCounts.filterOff (${counts.filterOff}). ` +
        `The checklist and scenario manifest have drifted.`,
    );
  }
  if (parsed.filterOn.length !== counts.filterOn) {
    throw new Error(
      `Canonical checklist filter-ON rows (${parsed.filterOn.length}) ` +
        `!= manifest expectedCounts.filterOn (${counts.filterOn}). ` +
        `The checklist and scenario manifest have drifted.`,
    );
  }
  return {
    counts,
    filterOff: parsed.filterOff,
    filterOn: parsed.filterOn,
  };
}
