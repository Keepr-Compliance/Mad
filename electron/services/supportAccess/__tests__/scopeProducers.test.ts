/** @jest-environment node */
/**
 * Every advertised scope has a producer (BACKLOG-2393)
 *
 * The grant screen offered five scopes, four of them on by default, and three
 * of them — message import, email sync, transaction auto-linking — were never
 * written to by anything. A user could tick them, wait a week, and send a
 * report containing nothing from those subsystems. Worse, support would read
 * the empty section as "nothing happened" rather than "nothing was recorded",
 * which is the exact confusion this feature exists to remove.
 *
 * That was a gap between two lists nobody was comparing: the scope catalogue,
 * and the set of call sites. So this compares them.
 *
 * ## Why this scans source rather than running the producers
 *
 * The claim is "a producer exists for this scope". The producers live inside
 * message import, email sync and auto-linking — driving them for real needs a
 * seeded SQLite database, a Messages chat.db, and a mail provider, which is
 * what those subsystems' own suites are for. What is being asserted here is
 * narrower and is genuinely a property of the source: no scope is offered to a
 * user without something, somewhere, able to write it.
 *
 * It is a set comparison, not a count. Adding a sixth scope to the catalogue
 * without wiring it up fails here, and so does deleting the last call site for
 * an existing one.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { SUPPORT_LOG_SCOPES, type SupportLogScopeId } from "../scopes";

/** The support-access module itself defines the seam; producers are outside it. */
const MODULE_DIR = path.join(__dirname, "..");
const ELECTRON_DIR = path.join(__dirname, "..", "..", "..");

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      yield* walk(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

/** Scopes that at least one call site outside the module writes to. */
async function producedScopes(): Promise<Map<SupportLogScopeId, string[]>> {
  const found = new Map<SupportLogScopeId, string[]>();
  const pattern = /supportTrace\(\s*"([a-z-]+)"/g;
  for await (const file of walk(ELECTRON_DIR)) {
    if (file.startsWith(MODULE_DIR + path.sep)) continue;
    const source = await fs.readFile(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const scope = match[1] as SupportLogScopeId;
      const at = path.relative(ELECTRON_DIR, file);
      found.set(scope, [...(found.get(scope) ?? []), at]);
    }
  }
  return found;
}

describe("support log scopes", () => {
  it("offers no scope that nothing produces", async () => {
    const produced = await producedScopes();
    const advertised = [...SUPPORT_LOG_SCOPES].sort();
    const withProducers = [...produced.keys()].sort();

    // Set identity, both directions: an advertised scope with no producer is
    // the bug being fixed, and a producer writing a scope that is not in the
    // catalogue would be data collected under no consent checkbox at all.
    expect(withProducers).toEqual(advertised);
  });

  it("names where each scope is produced, so a deletion is visible here", async () => {
    const produced = await producedScopes();
    const summary = Object.fromEntries(
      [...SUPPORT_LOG_SCOPES].map((scope) => [
        scope,
        (produced.get(scope) ?? []).length,
      ]),
    );

    // Every scope has at least one, and the three that had none before this
    // change have real producers rather than a token call added to pass a test.
    expect(summary["message-import"]).toBeGreaterThanOrEqual(2);
    expect(summary["email-sync"]).toBeGreaterThanOrEqual(3);
    expect(summary["transaction-linking"]).toBeGreaterThanOrEqual(3);
    expect(summary["contact-resolution"]).toBeGreaterThanOrEqual(1);
    expect(summary["contact-trace"]).toBeGreaterThanOrEqual(1);
  });

  it("wires the on-error capture path to something", async () => {
    // `notifySupportAccessError` shipped with a documented 5-minute debounce
    // and zero callers, so the on-error half of the batched-upload design was
    // dead code describing behaviour that could not occur.
    let callers = 0;
    for await (const file of walk(ELECTRON_DIR)) {
      if (file.startsWith(MODULE_DIR + path.sep)) continue;
      const source = await fs.readFile(file, "utf8");
      callers += [...source.matchAll(/notifySupportError\(\)/g)].length;
    }
    expect(callers).toBeGreaterThanOrEqual(1);
  });
});
