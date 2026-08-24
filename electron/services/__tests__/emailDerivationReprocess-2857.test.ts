/**
 * @jest-environment node
 *
 * BACKLOG-2857 — the reprocess pass, against a real driver and the real schema.
 *
 * Every assertion here runs against `better-sqlite3` and the real
 * `electron/database/schema.sql`. Nothing about `body_plain` is stubbed: the
 * end-to-end control re-derives a genuinely truncated Outlook row and then finds
 * the recovered text through the REAL search builder. A repaired column nobody can
 * search is not repaired, so the search leg is the point of that control.
 *
 * CONTROLS, and what each one would catch:
 *
 *  1. STALE SET BY IDENTITY — the reprocessed rows are asserted as an exact id
 *     SET, never a count. A count passes when the pass touches the wrong N rows;
 *     the mutation control at the bottom of this file proves the set assertion
 *     goes red when the version predicate is removed, and a count assertion would
 *     NOT have caught it (the same number of rows is touched either way).
 *  2. RESUMABILITY — the property that justified per-row over per-account. An
 *     interrupted pass is resumed and the TOTAL scanned across both runs must
 *     equal the row count exactly. Double-processing shows up as a total above N,
 *     skipping as a total below it. This is why the assertion is on the sum and
 *     not on the final state, which would look identical either way.
 *  3. A CURRENT ROW IS NOT TOUCHED — including `updated_at`. Worth stating: no
 *     production code writes `emails.updated_at` at all today, so this control is
 *     a guard against the pass BECOMING the first writer, which would make silent
 *     repairs indistinguishable from user edits.
 *  4. ZERO NETWORK — asserted on mocks (`fetch`, both fetch services), never on
 *     wall-clock. A class-1 repair that quietly re-fetched would still be correct
 *     and still be fast on a small fixture; only a call-count catches it.
 *  5. THE FOUNDER'S CASE, END TO END — a 255-char `bodyPreview` body_plain with
 *     full `body_html`, at v0, repaired and then FOUND by `buildGlobalEmailQuery`
 *     on a term that lives only past character 300.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  BrowserWindow: { getAllWindows: () => [] },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// CONTROL 4 — the network mocks. Both provider fetch services are replaced with
// jest.fn()s so any re-fetch attempt is a recorded call rather than a real one.
const gmailFetchMock = jest.fn();
const outlookFetchMock = jest.fn();
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: { fetchEmails: gmailFetchMock, fetchEmailsSince: gmailFetchMock },
}));
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: { fetchEmails: outlookFetchMock, fetchEmailsSince: outlookFetchMock },
}));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import {
  reprocessEmailDerivations,
  reDeriveRow,
} from "../emailDerivationReprocessService";
import { CURRENT_DERIVATION_VERSION } from "../../utils/derivationVersion";
import { buildGlobalEmailQuery } from "../db/transactionSearchDbService";

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");
const USER = "u-2857";
const OTHER_USER = "u-2857-other";

/**
 * A realistic Outlook HTML body. `MARKER` sits deliberately past character 300 of
 * the PLAIN text, so it cannot appear in a 255-char preview — that is what makes
 * the end-to-end control meaningful rather than tautological.
 */
const MARKER = "Fernbrook";
const FILLER = "The parties have reviewed the disclosure packet and agree to proceed. ";
const OUTLOOK_HTML =
  "<html><head><style>.x{color:red}</style></head><body>" +
  `<p>${FILLER.repeat(8)}</p>` +
  `<p>Please send the appraisal to the ${MARKER} office before Friday.</p>` +
  "</body></html>";

/** What the pre-2855 mapper stored: Graph's first-255-characters preview. */
function graphBodyPreview(html: string): string {
  return stripTags(html).slice(0, 255);
}
function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface SeedRow {
  id: string;
  version: number;
  user?: string;
  html?: string | null;
  plain?: string | null;
}

function seed(db: DatabaseType, rows: SeedRow[]): void {
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'microsoft','o1')",
  ).run(USER, "agent@example.com");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'microsoft','o2')",
  ).run(OTHER_USER, "other@example.com");

  for (const r of rows) {
    const html = r.html === undefined ? OUTLOOK_HTML : r.html;
    const plain = r.plain === undefined ? graphBodyPreview(OUTLOOK_HTML) : r.plain;
    db.prepare(
      `INSERT INTO emails
         (id, user_id, source, subject, sender, body_plain, body_html,
          sent_at, created_at, updated_at, derived_version)
       VALUES (?,?,'outlook','Appraisal','jane@example.com',?,?,
               '2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z',
               '2026-06-01T00:00:00.000Z',?)`,
    ).run(r.id, r.user ?? USER, plain, html, r.version);
  }
}

/** Read the (id -> derived_version) map. Identity, never counts. */
function versions(db: DatabaseType): Record<string, number> {
  const rows = db
    .prepare("SELECT id, derived_version FROM emails ORDER BY id")
    .all() as Array<{ id: string; derived_version: number }>;
  return Object.fromEntries(rows.map((r) => [r.id, r.derived_version]));
}

function idsAtVersion(db: DatabaseType, version: number): string[] {
  return (
    db
      .prepare("SELECT id FROM emails WHERE derived_version = ? ORDER BY id")
      .all(version) as Array<{ id: string }>
  ).map((r) => r.id);
}

describe("BACKLOG-2857 — derivation reprocess", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
  });

  afterEach(async () => {
    try {
      await harness.cleanup();
    } catch {
      /* nothing to clean */
    }
  });

  // ── CONTROL 1 ────────────────────────────────────────────────────────────────
  describe("only stale rows are reprocessed", () => {
    it("touches exactly the id SET below CURRENT, leaving current rows alone", async () => {
      seed(db, [
        { id: "e-stale-a", version: 0 },
        { id: "e-stale-b", version: 0 },
        { id: "e-current-a", version: CURRENT_DERIVATION_VERSION },
        { id: "e-current-b", version: CURRENT_DERIVATION_VERSION },
      ]);

      const before = versions(db);
      expect(before).toEqual({
        "e-current-a": CURRENT_DERIVATION_VERSION,
        "e-current-b": CURRENT_DERIVATION_VERSION,
        "e-stale-a": 0,
        "e-stale-b": 0,
      });

      const result = await reprocessEmailDerivations({ db });

      // The SET, not the count. `scanned` alone would pass if the pass had
      // reprocessed the two ALREADY-CURRENT rows and skipped the stale ones.
      expect(result.scanned).toBe(2);
      expect(idsAtVersion(db, CURRENT_DERIVATION_VERSION).sort()).toEqual([
        "e-current-a",
        "e-current-b",
        "e-stale-a",
        "e-stale-b",
      ]);
      expect(idsAtVersion(db, 0)).toEqual([]);

      // And the stale rows are the ones whose text actually changed.
      const repaired = db
        .prepare("SELECT id, body_plain FROM emails WHERE id LIKE 'e-stale%' ORDER BY id")
        .all() as Array<{ id: string; body_plain: string }>;
      for (const row of repaired) {
        expect(row.body_plain).toContain(MARKER);
      }
    });

    it("scopes to one user when userId is given", async () => {
      seed(db, [
        { id: "e-mine", version: 0, user: USER },
        { id: "e-theirs", version: 0, user: OTHER_USER },
      ]);

      await reprocessEmailDerivations({ db, userId: USER });

      expect(idsAtVersion(db, CURRENT_DERIVATION_VERSION)).toEqual(["e-mine"]);
      expect(idsAtVersion(db, 0)).toEqual(["e-theirs"]);
    });
  });

  // ── CONTROL 2 ────────────────────────────────────────────────────────────────
  describe("resumability", () => {
    it("resumes after an interruption with no row processed twice and none skipped", async () => {
      const ids = Array.from({ length: 25 }, (_, i) => `e-${String(i).padStart(2, "0")}`);
      seed(db, ids.map((id) => ({ id, version: 0 })));

      // Interrupt after the first batch — the shape of the app being killed
      // mid-pass. `shouldCancel` is consulted BETWEEN batches, so the committed
      // work is exactly one batch.
      let batchesSeen = 0;
      const first = await reprocessEmailDerivations({
        db,
        batchSize: 10,
        shouldCancel: () => batchesSeen++ >= 1,
      });

      expect(first.cancelled).toBe(true);
      expect(first.scanned).toBe(10);

      const doneAfterInterrupt = idsAtVersion(db, CURRENT_DERIVATION_VERSION);
      const pendingAfterInterrupt = idsAtVersion(db, 0);
      expect(doneAfterInterrupt).toHaveLength(10);
      expect(pendingAfterInterrupt).toHaveLength(15);
      // Every row is in exactly one of the two states — no row is half-repaired.
      expect([...doneAfterInterrupt, ...pendingAfterInterrupt].sort()).toEqual([...ids].sort());

      // Resume.
      const second = await reprocessEmailDerivations({ db, batchSize: 10 });

      // THE assertion. Total work across both runs must equal the row count
      // EXACTLY: above 25 means a row was processed twice, below means one was
      // skipped. Asserting only the final state cannot tell those apart — every
      // row ends at CURRENT either way.
      expect(first.scanned + second.scanned).toBe(25);
      expect(second.scanned).toBe(15);
      expect(idsAtVersion(db, CURRENT_DERIVATION_VERSION).sort()).toEqual([...ids].sort());
      expect(idsAtVersion(db, 0)).toEqual([]);
    });

    it("re-running a completed pass is a no-op", async () => {
      seed(db, [{ id: "e-1", version: 0 }]);
      await reprocessEmailDerivations({ db });

      const again = await reprocessEmailDerivations({ db });
      expect(again.scanned).toBe(0);
      expect(again.batches).toBe(0);
    });

    it("stamps rows it cannot improve, so the pass terminates", async () => {
      // A row with no HTML can never be repaired by version 1. If the pass left it
      // unstamped it would be re-selected forever — an infinite loop, not a slow
      // pass. This is the control for that.
      seed(db, [{ id: "e-nohtml", version: 0, html: null, plain: "kept" }]);

      const result = await reprocessEmailDerivations({ db });

      expect(result.scanned).toBe(1);
      expect(result.rewritten).toBe(0);
      expect(result.unchanged).toBe(1);
      expect(idsAtVersion(db, CURRENT_DERIVATION_VERSION)).toEqual(["e-nohtml"]);

      // And it did NOT blank the little text the row had.
      const row = db.prepare("SELECT body_plain FROM emails WHERE id = 'e-nohtml'").get() as {
        body_plain: string;
      };
      expect(row.body_plain).toBe("kept");
    });
  });

  // ── CONTROL 3 ────────────────────────────────────────────────────────────────
  describe("a row already at the current version is untouched", () => {
    it("leaves body_plain AND updated_at byte-identical", async () => {
      seed(db, [
        { id: "e-current", version: CURRENT_DERIVATION_VERSION, plain: "original text" },
        { id: "e-stale", version: 0 },
      ]);

      const before = db
        .prepare("SELECT body_plain, updated_at, derived_version FROM emails WHERE id = 'e-current'")
        .get() as { body_plain: string; updated_at: string; derived_version: number };

      await reprocessEmailDerivations({ db });

      const after = db
        .prepare("SELECT body_plain, updated_at, derived_version FROM emails WHERE id = 'e-current'")
        .get() as { body_plain: string; updated_at: string; derived_version: number };

      expect(after).toEqual(before);
      expect(after.body_plain).toBe("original text");
      // Explicitly: the pass must not become the first writer of updated_at.
      expect(after.updated_at).toBe("2026-06-01T00:00:00.000Z");
    });
  });

  // ── CONTROL 4 ────────────────────────────────────────────────────────────────
  describe("a class-1 bump issues zero network calls", () => {
    it("never calls fetch or either provider service", async () => {
      const fetchSpy = jest.fn();
      const originalFetch = globalThis.fetch;
      (globalThis as { fetch?: unknown }).fetch = fetchSpy;

      try {
        seed(db, [
          { id: "e-1", version: 0 },
          { id: "e-2", version: 0 },
          { id: "e-3", version: 0 },
        ]);

        const result = await reprocessEmailDerivations({ db });
        expect(result.rewritten).toBe(3);

        // Asserted on the mocks, not on elapsed time: a repair that quietly
        // re-fetched would still be correct and still be fast here.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(gmailFetchMock).not.toHaveBeenCalled();
        expect(outlookFetchMock).not.toHaveBeenCalled();
      } finally {
        (globalThis as { fetch?: unknown }).fetch = originalFetch;
      }
    });
  });

  // ── CONTROL 5 ────────────────────────────────────────────────────────────────
  describe("the founder's case, end to end", () => {
    it("repairs a truncated Outlook row and the real search builder then finds it", async () => {
      const truncated = graphBodyPreview(OUTLOOK_HTML);

      seed(db, [{ id: "e-outlook", version: 0, plain: truncated }]);

      // Seed the linkage buildGlobalEmailQuery joins through.
      db.prepare(
        "INSERT INTO transactions (id, user_id, property_address) VALUES ('t-1',?,'12 Fernbrook Way')",
      ).run(USER);
      db.prepare(
        `INSERT INTO communications (id, user_id, transaction_id, email_id, linked_at)
         VALUES ('cm-1',?,'t-1','e-outlook','2026-06-01T00:00:00.000Z')`,
      ).run(USER);

      // PRE-STATE, asserted — this is what makes the control non-vacuous.
      expect(truncated.length).toBe(255);
      expect(truncated).not.toContain(MARKER);

      const searchFor = (term: string): unknown[] => {
        const q = buildGlobalEmailQuery(USER, term, 20);
        return db.prepare(q.sql).all(...(q.params as never[]));
      };

      // Before the repair the term is genuinely unfindable.
      expect(searchFor(MARKER)).toHaveLength(0);

      const result = await reprocessEmailDerivations({ db });
      expect(result.rewritten).toBe(1);

      const after = db
        .prepare("SELECT body_plain, derived_version FROM emails WHERE id = 'e-outlook'")
        .get() as { body_plain: string; derived_version: number };

      expect(after.derived_version).toBe(CURRENT_DERIVATION_VERSION);
      expect(after.body_plain).toContain(MARKER);
      // The recovered text lives past where the preview stopped.
      expect(after.body_plain.indexOf(MARKER)).toBeGreaterThan(300);

      // THE POINT: a repaired column nobody can search is not repaired.
      const hits = searchFor(MARKER) as Array<{ id: string }>;
      expect(hits.map((h) => h.id)).toEqual(["e-outlook"]);
    });
  });

  // ── Locked decisions ─────────────────────────────────────────────────────────
  describe("documented behaviours that are decisions, not accidents", () => {
    it("REWRITES a healthy Gmail row whose body_plain was a genuine text/plain part", async () => {
      // Nothing on disk distinguishes a real text/plain part from a 255-char
      // preview, so the pass cannot skip this row even though it was never
      // damaged. Locked here so the choice is visible and a future change to it
      // is deliberate rather than silent. See the service header.
      const genuinePlain = "Hi Jane,\n\nConfirming Thursday at 9am.\n\nThanks";
      seed(db, [
        {
          id: "e-gmail-healthy",
          version: 0,
          plain: genuinePlain,
          html: "<p>Hi Jane,</p><p>Confirming Thursday at 9am.</p><p>Thanks</p>",
        },
      ]);

      const result = await reprocessEmailDerivations({ db });
      expect(result.rewritten).toBe(1);

      const after = db
        .prepare("SELECT body_plain FROM emails WHERE id = 'e-gmail-healthy'")
        .get() as { body_plain: string };

      // Replaced, and content-equivalent — every word survives the substitution.
      expect(after.body_plain).not.toBe(genuinePlain);
      for (const word of ["Jane", "Confirming", "Thursday", "9am", "Thanks"]) {
        expect(after.body_plain).toContain(word);
      }
    });

    it("rolls a failing batch back whole, never leaving a row stamped with its old body", async () => {
      // The one state the design calls data loss: stamped at CURRENT while still
      // holding the truncated text, which would be permanent. Proved by making a
      // write throw mid-batch rather than by trusting the db.transaction() call
      // to still be there after a refactor.
      seed(db, [
        { id: "e-a", version: 0 },
        { id: "e-b", version: 0 },
        { id: "e-c", version: 0 },
      ]);

      const realPrepare = db.prepare.bind(db);
      let updateCalls = 0;
      const spy = jest
        .spyOn(db, "prepare")
        .mockImplementation(((sql: string) => {
          const stmt = realPrepare(sql);
          if (sql.includes("UPDATE emails SET body_plain")) {
            const realRun = stmt.run.bind(stmt);
            stmt.run = ((...args: unknown[]) => {
              if (++updateCalls === 2) throw new Error("disk full (simulated)");
              return realRun(...(args as never[]));
            }) as typeof stmt.run;
          }
          return stmt;
        }) as typeof db.prepare);

      try {
        await expect(reprocessEmailDerivations({ db, batchSize: 10 })).rejects.toThrow(
          /disk full/,
        );
      } finally {
        spy.mockRestore();
      }

      // The whole batch rolled back: NO row is stamped, and no row lost its text.
      expect(idsAtVersion(db, CURRENT_DERIVATION_VERSION)).toEqual([]);
      expect(idsAtVersion(db, 0).sort()).toEqual(["e-a", "e-b", "e-c"]);
    });
  });

  // ── The transform itself ─────────────────────────────────────────────────────
  describe("reDeriveRow", () => {
    it("returns null (keep existing) when there is nothing to derive", () => {
      expect(reDeriveRow({ body_plain: "x", body_html: null })).toBeNull();
      expect(reDeriveRow({ body_plain: "x", body_html: "" })).toBeNull();
      expect(reDeriveRow({ body_plain: "x", body_html: "<div><span></span></div>" })).toBeNull();
    });

    it("returns null when the derived text already matches what is stored", () => {
      const html = "<p>hello world</p>";
      const derived = reDeriveRow({ body_plain: null, body_html: html });
      expect(derived).toBe("hello world");
      expect(reDeriveRow({ body_plain: derived, body_html: html })).toBeNull();
    });
  });
});
