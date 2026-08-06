/**
 * Address-book discovery — BACKLOG-2394
 *
 * Extracted verbatim from `contactsService.ts` so that the LIVE line in the
 * support-ticket diagnostics block ("address books on disk: 3") and the reader
 * that actually ingests those books answer from **one implementation**.
 *
 * That is the whole reason this file exists. A second, diagnostics-only copy of
 * the directory walk would be a number that drifts away from what the reader
 * does — and a diagnostic that disagrees with the code it describes is worse
 * than no diagnostic, because it is believed. The reporter's investigation was
 * derailed twice by numbers that were true of a different run.
 *
 * ⚠️ THIS MODULE OPENS NOTHING. It is `readdir` + `realpath` + `access` only —
 * no SQLite handle, no `PRAGMA`, no permission prompt. That is what makes it
 * safe to run at ticket-submission time, on the user's main thread, without
 * asking anyone's consent. Keep it that way: the moment discovery opens a
 * database, the diagnostics block can block on a Full Disk Access prompt while
 * a user is trying to file a bug report.
 */

import path from "path";
import fs from "fs/promises";
import { redactAddressBookPath } from "./contactIngestionFunnel";

/** A `.abcddb` we intend to read, plus its redacted name for the log. */
export interface DiscoveredBook {
  fullPath: string;
  redacted: string;
}

/**
 * Recursively find all .abcddb files under a directory.
 * Replaces shell `find` to avoid indirect command-line injection via process.env.HOME.
 */
async function findAbcddbFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await findAbcddbFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".abcddb")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist or be inaccessible; skip
  }
  return results;
}

/**
 * Resolve symlinks so the same physical file discovered under two paths is read
 * once. Falls back to the given path when the file cannot be resolved — a
 * missing file is the caller's problem to report, not this helper's.
 */
async function resolveRealPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Every address book we are going to read, in a deterministic order.
 *
 * BACKLOG-2392 — the verified on-disk layout, which is undocumented and which
 * three prior investigations got wrong:
 *
 *   AddressBook/AddressBook-v22.abcddb              <- local, "On My Mac"
 *   AddressBook/Sources/<UUID>/AddressBook-v22.abcddb  <- one per network account
 *
 * The old code's >10-record gate discarded the top-level store outright (on the
 * machine inspected it held 3 rows), so anyone with a handful of local contacts
 * lost that account entirely. There is no threshold here, and no selection:
 * every book is a candidate.
 *
 * The results are sorted so the funnel log and the tests are deterministic
 * rather than dependent on readdir order — the very thing that made the old
 * behaviour flip between runs.
 */
export async function discoverAddressBooks(
  baseDir: string,
  defaultPath: string,
): Promise<{ books: DiscoveredBook[]; usedFallback: boolean }> {
  // SORTED, and that is load-bearing. readdir order is the mechanism that made
  // the old reader pick a different book between two syncs and move a user from
  // 947 contacts to 716. Nothing downstream may depend on filesystem ordering.
  const discovered = (await findAbcddbFiles(baseDir)).sort();

  const books: DiscoveredBook[] = [];
  const seen = new Set<string>();

  for (const fullPath of discovered) {
    const real = await resolveRealPath(fullPath);
    seen.add(real);
    books.push({ fullPath, redacted: redactAddressBookPath(fullPath, baseDir) });
  }

  // The default path is normally ALSO one of the discovered books; only add it
  // when the walk missed it (e.g. readdir on the base dir was denied but the
  // file itself is readable). That is the only remaining meaning of "fallback".
  let usedFallback = false;
  const realDefault = await resolveRealPath(defaultPath);
  if (!seen.has(realDefault)) {
    try {
      await fs.access(defaultPath);
      books.push({
        fullPath: defaultPath,
        redacted: redactAddressBookPath(defaultPath, baseDir),
      });
      usedFallback = true;
    } catch {
      // Default store does not exist — nothing to add.
    }
  }

  return { books, usedFallback };
}
