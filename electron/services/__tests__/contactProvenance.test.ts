/**
 * @jest-environment node
 *
 * BACKLOG-2410 part 2 — contact provenance, and an unlink that actually sticks.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THAT MATTERS
 * ---------------------------------------------------------------------------
 * Deleting a crosswalk row is NOT enough. With the link gone, the linker falls
 * through to the content fallback, matches the same email that produced the
 * wrong merge, and puts it straight back. The user's correction would survive
 * until the next sync and then silently revert.
 *
 * `unlink survives a re-run` is therefore not a nice-to-have test — it is the
 * test that distinguishes a working undo from one that looks like it worked.
 */

import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let mockDb: DatabaseType | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { getContactProvenance, unlinkContactSource } from "../contactProvenance";
import { linkExternalContactsForUser } from "../contactSourceLinker";
import { createLink, getLinksForContact } from "../db/contactSourceLinkDbService";
import { hasCannotLink, listVerdicts } from "../db/contactLinkReviewDbService";

const USER = "user-prov-2410";
const OTHER_USER = "user-other-prov";

function addContact(id: string, displayName: string, opts: { emails?: string[] } = {}): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, displayName);
  (opts.emails ?? []).forEach((e, i) => {
    mockDb!
      .prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, ?)")
      .run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0);
  });
}

function addExternal(recordId: string, name: string, source: string, emails: string[] = []): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, emails_json, external_record_id, source, synced_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?, '2026-08-02T00:00:00.000Z')`,
    )
    .run(`ext-${source}-${recordId}`, USER, name, JSON.stringify(emails), recordId, source);
}

function linkSet(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type}|${l.source_record_id}`)
    .sort();
}

/** A contact assembled from three sources by three different methods. */
function seedMultiSource(): void {
  addContact("c-jane", "Jane Doe", { emails: ["jane@example.com"] });
  addExternal("mac-jane", "Jane Doe", "macos");
  addExternal("out-jane", "Jane R Doe", "outlook");
  addExternal("iph-jane", "Jane", "iphone");
  createLink({
    userId: USER,
    contactId: "c-jane",
    sourceType: "macos",
    sourceRecordId: "mac-jane",
    matchMethod: "source_id",
  });
  createLink({
    userId: USER,
    contactId: "c-jane",
    sourceType: "outlook",
    sourceRecordId: "out-jane",
    matchMethod: "email",
  });
  createLink({
    userId: USER,
    contactId: "c-jane",
    sourceType: "iphone",
    sourceRecordId: "iph-jane",
    matchMethod: "unique_name",
  });
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
// 1. WHAT THE PANEL SHOWS
// ===========================================================================
describe("getContactProvenance", () => {
  it("reports every source, in words, never a score", () => {
    seedMultiSource();

    const sources = getContactProvenance(USER, "c-jane");
    expect(sources.map((s) => `${s.sourceType}|${s.matchMethod}`)).toEqual([
      "iphone|unique_name",
      "macos|source_id",
      "outlook|email",
    ]);

    const byType = Object.fromEntries(sources.map((s) => [s.sourceType, s]));
    expect(byType.macos.sourceLabel).toBe("Mac address book");
    expect(byType.macos.matchDescription).toBe(
      "Recognised by its own entry in your Mac address book",
    );
    expect(byType.outlook.matchDescription).toBe(
      "Matched by an email address you already had for this person",
    );
    expect(byType.iphone.matchDescription).toContain("full name that appears exactly once");
    // No score anywhere in the payload. Asserted STRUCTURALLY rather than by
    // grepping the serialised JSON: a `0.\d` regex also matches the millisecond
    // field of an ISO timestamp, so the string test passes or fails on
    // punctuation rather than on the thing it claims to check.
    for (const source of sources) {
      expect(Object.keys(source)).toEqual([
        "linkId",
        "sourceType",
        "sourceLabel",
        "matchMethod",
        "matchDescription",
        "sourceName",
        "sourceRecordPresent",
        "matchedAt",
        "lastSyncedAt",
      ]);
      for (const value of Object.values(source)) {
        expect(typeof value).not.toBe("number");
      }
    }
  });

  it("carries the name each source calls this person", () => {
    seedMultiSource();
    const sources = getContactProvenance(USER, "c-jane");
    expect(sources.map((s) => s.sourceName)).toEqual(["Jane", "Jane Doe", "Jane R Doe"]);
  });

  /**
   * A link whose source record has gone is still part of how the contact came to
   * be. Hiding it would make a two-source contact look single-source, which is
   * exactly the invisibility this panel exists to end.
   *
   * NEGATIVE CONTROL RUN: changed the LEFT JOIN to an inner JOIN. Observed: this
   * test fails — the outlook row disappears entirely instead of being reported
   * as absent.
   */
  it("keeps a link whose source record has gone, and says so", () => {
    seedMultiSource();
    mockDb!.prepare("DELETE FROM external_contacts WHERE external_record_id = 'out-jane'").run();

    const sources = getContactProvenance(USER, "c-jane");
    expect(sources.map((s) => `${s.sourceType}|${s.sourceRecordPresent}`)).toEqual([
      "iphone|true",
      "macos|true",
      "outlook|false",
    ]);
  });

  it("returns nothing for a contact with no links, and for another user", () => {
    seedMultiSource();
    addContact("c-solo", "Solo Person");
    expect(getContactProvenance(USER, "c-solo")).toEqual([]);
    expect(getContactProvenance(OTHER_USER, "c-jane")).toEqual([]);
  });

  /**
   * The single-source case is reported honestly (one entry) — the "show
   * nothing" rule is the RENDERER's, asserted in ContactPreview's suite. A
   * service that lied by returning [] here would break the review queue and the
   * already-imported filter, which read the same rows.
   */
  it("reports a single source as one entry, not as none", () => {
    addContact("c-solo", "Solo Person");
    addExternal("mac-solo", "Solo Person", "macos");
    createLink({
      userId: USER,
      contactId: "c-solo",
      sourceType: "macos",
      sourceRecordId: "mac-solo",
      matchMethod: "source_id",
    });
    expect(getContactProvenance(USER, "c-solo").map((s) => s.sourceType)).toEqual(["macos"]);
  });
});

// ===========================================================================
// 2. UNLINKING ONE SOURCE
// ===========================================================================
describe("unlinkContactSource", () => {
  it("removes exactly one link and keeps the contact and the others", () => {
    seedMultiSource();
    const outlook = getContactProvenance(USER, "c-jane").find((s) => s.sourceType === "outlook")!;

    const outcome = unlinkContactSource(USER, "c-jane", outlook.linkId);
    // BACKLOG-2427: the outcome now also reports what the unlink TOOK BACK.
    // Zero here because this fixture seeds no contact_emails / contact_phones —
    // the removal itself is proven in contactSourceValues.test.ts. Asserted in
    // full rather than loosened to `toMatchObject`, so a future change to the
    // removal cannot pass silently through this suite.
    expect(outcome).toEqual({ ok: true, remaining: 2, removedEmails: 0, removedPhones: 0 });

    expect(linkSet("c-jane")).toEqual(["iphone|iph-jane", "macos|mac-jane"]);
    // The contact survives.
    expect(
      mockDb!.prepare("SELECT id FROM contacts WHERE id = 'c-jane'").get(),
    ).toEqual({ id: "c-jane" });
    // The source record survives.
    expect(
      mockDb!
        .prepare("SELECT external_record_id FROM external_contacts WHERE external_record_id = 'out-jane'")
        .get(),
    ).toEqual({ external_record_id: "out-jane" });
  });

  it("records the unlink as a durable 'different people' verdict", () => {
    seedMultiSource();
    const outlook = getContactProvenance(USER, "c-jane").find((s) => s.sourceType === "outlook")!;
    unlinkContactSource(USER, "c-jane", outlook.linkId);

    expect(hasCannotLink(USER, "c-jane", "outlook", "out-jane")).toBe(true);
    const verdicts = listVerdicts(USER);
    expect(
      verdicts.map((v) => `${v.contact_id}|${v.source_record_id}|${v.identity_verdict}|${v.decided_by}`),
    ).toEqual(["c-jane|out-jane|different_people|provenance_unlink"]);
    expect(verdicts[0].reason).toBe("manual_unlink");
  });

  /**
   * THE TEST THAT MATTERS. Unlink, then run a real linking pass. Without the
   * verdict, the content fallback would re-link on the shared email address.
   *
   * NEGATIVE CONTROL RUN: removed the `recordVerdict(...)` call from
   * `unlinkContactSource`. Observed: this test fails with
   * `outlook|out-jane` back on Jane after the pass, while every other test in
   * this file still passes — i.e. deleting the row alone LOOKS like a working
   * undo and is not one.
   */
  it("the unlink survives a re-run — the next sync does not put it back", () => {
    // Give the outlook record the same email Jane's saved contact carries, so
    // the content fallback has a real reason to re-link it.
    addContact("c-jane", "Jane Doe", { emails: ["jane@example.com"] });
    addExternal("mac-jane", "Jane Doe", "macos");
    addExternal("out-jane", "Jane R Doe", "outlook", ["jane@example.com"]);
    createLink({
      userId: USER,
      contactId: "c-jane",
      sourceType: "macos",
      sourceRecordId: "mac-jane",
      matchMethod: "source_id",
    });
    createLink({
      userId: USER,
      contactId: "c-jane",
      sourceType: "outlook",
      sourceRecordId: "out-jane",
      matchMethod: "email",
    });

    // Sanity: without the unlink, a pass keeps it linked.
    linkExternalContactsForUser(USER);
    expect(linkSet("c-jane")).toEqual(["macos|mac-jane", "outlook|out-jane"]);

    const outlook = getContactProvenance(USER, "c-jane").find((s) => s.sourceType === "outlook")!;
    unlinkContactSource(USER, "c-jane", outlook.linkId);
    expect(linkSet("c-jane")).toEqual(["macos|mac-jane"]);

    linkExternalContactsForUser(USER); // RE-RUN
    expect(linkSet("c-jane")).toEqual(["macos|mac-jane"]);

    // And it is not silently turned into a queue question either.
    const proposals = mockDb!
      .prepare("SELECT contact_id, source_record_id FROM contact_link_proposals")
      .all();
    expect(proposals).toEqual([]);
  });

  it("refuses a link belonging to another user or another contact", () => {
    seedMultiSource();
    addContact("c-bob", "Bob Other");
    const outlook = getContactProvenance(USER, "c-jane").find((s) => s.sourceType === "outlook")!;

    expect(unlinkContactSource(OTHER_USER, "c-jane", outlook.linkId)).toEqual({
      ok: false,
      error: "That source link no longer exists.",
    });
    expect(unlinkContactSource(USER, "c-bob", outlook.linkId)).toEqual({
      ok: false,
      error: "That source link no longer exists.",
    });
    // Nothing was removed, and no verdict was invented.
    expect(linkSet("c-jane")).toEqual(["iphone|iph-jane", "macos|mac-jane", "outlook|out-jane"]);
    expect(listVerdicts(USER)).toEqual([]);
  });

  it("refuses an id that does not exist", () => {
    seedMultiSource();
    expect(unlinkContactSource(USER, "c-jane", "not-a-real-link")).toEqual({
      ok: false,
      error: "That source link no longer exists.",
    });
    expect(linkSet("c-jane")).toEqual(["iphone|iph-jane", "macos|mac-jane", "outlook|out-jane"]);
  });

  it("can be applied to the last remaining source, leaving the contact intact", () => {
    addContact("c-solo", "Solo Person");
    addExternal("mac-solo", "Solo Person", "macos");
    createLink({
      userId: USER,
      contactId: "c-solo",
      sourceType: "macos",
      sourceRecordId: "mac-solo",
      matchMethod: "source_id",
    });
    const only = getContactProvenance(USER, "c-solo")[0];

    expect(unlinkContactSource(USER, "c-solo", only.linkId)).toEqual({
      ok: true,
      remaining: 0,
      removedEmails: 0,
      removedPhones: 0,
    });
    expect(linkSet("c-solo")).toEqual([]);
    expect(mockDb!.prepare("SELECT id FROM contacts WHERE id = 'c-solo'").get()).toEqual({
      id: "c-solo",
    });
  });
});
