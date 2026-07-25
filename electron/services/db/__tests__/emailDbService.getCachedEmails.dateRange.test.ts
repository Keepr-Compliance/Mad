/**
 * @jest-environment node
 *
 * BACKLOG-2247 — Attach Emails date-range end boundary is inclusive-of-the-end-day.
 *
 * Reproduces the founder-reported bug end-to-end against a REAL in-memory
 * better-sqlite3 driver: filtering the Attach Emails list by an end date of
 * 7/25 must include emails that occurred at any clock time on 7/25 (local),
 * not stop at 7/24.
 *
 * The chain mirrored here is the production one:
 *   AttachEmailsModal  → startOfLocalDayISO / endOfLocalDayISO  (renderer)
 *   emailLinkingHandlers → new Date(options.after|before)       (main/IPC)
 *   getCachedEmails     → `sent_at >= after` AND `sent_at <= before` (SQL)
 *
 * The test is TIMEZONE-AGNOSTIC: every email timestamp is positioned RELATIVE
 * to the boundary instants the helpers produce, so inclusion/exclusion holds on
 * any CI runner regardless of its timezone. (jest does not reliably honor a
 * per-file `process.env.TZ`.)
 *
 * Uses the same absolute-path `require` shim as emailDbService.createEmail.test
 * to bypass the jest moduleNameMapper mock of better-sqlite3-multiple-ciphers.
 */
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

import { setDb } from "../core/dbConnection";
import { getCachedEmails } from "../emailDbService";
import { startOfLocalDayISO, endOfLocalDayISO } from "../../../../src/utils/dateRangeUtils";

const USER_ID = "user-date-range-test";
const HOUR_MS = 60 * 60 * 1000;

// Boundary instants for the range 7/20 (start) → 7/25 (end), computed exactly
// as the modal + IPC handler compute them in production.
const AFTER = new Date(startOfLocalDayISO("2026-07-20")!);
const BEFORE = new Date(endOfLocalDayISO("2026-07-25")!);
const afterMs = AFTER.getTime();
const beforeMs = BEFORE.getTime();

/**
 * Emails positioned at precise offsets around the [AFTER, BEFORE] boundaries.
 * `sent_at` is stored as a UTC "...Z" ISO string, exactly as production writes
 * it. Inclusion is decided by the SQL `sent_at >= after AND sent_at <= before`.
 */
const EMAILS: Array<{ id: string; ms: number; included: boolean }> = [
  // Exactly the start boundary (local midnight 7/20). Inclusive (>=) → INCLUDED.
  { id: "start-inclusive", ms: afterMs, included: true },
  // 1ms before the start boundary → EXCLUDED.
  { id: "just-before-start", ms: afterMs - 1, included: false },
  // Middle of the end day (~6h before end-of-day, i.e. ~18:00 local on 7/25).
  // This is the founder's "2026-07-25T14:30Z" case — genuinely on 7/25, which
  // the OLD code dropped. → INCLUDED.
  { id: "mid-end-day", ms: beforeMs - 6 * HOUR_MS, included: true },
  // Late local evening on 7/25 (~30min before midnight) → INCLUDED.
  { id: "end-day-late-evening", ms: beforeMs - 30 * 60 * 1000, included: true },
  // Exactly the end boundary (last ms of 7/25 local). Inclusive (<=) → INCLUDED.
  { id: "end-inclusive", ms: beforeMs, included: true },
  // 1ms later == 00:00 local on 7/26 → EXCLUDED.
  { id: "just-after-end", ms: beforeMs + 1, included: false },
];

describe("getCachedEmails date-range boundaries (BACKLOG-2247)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:") as DatabaseType;
    db.exec(`
      CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        external_id TEXT,
        source TEXT,
        account_id TEXT,
        direction TEXT,
        subject TEXT,
        body_plain TEXT,
        body_html TEXT,
        sender TEXT,
        recipients TEXT,
        cc TEXT,
        bcc TEXT,
        thread_id TEXT,
        in_reply_to TEXT,
        references_header TEXT,
        sent_at DATETIME,
        received_at DATETIME,
        has_attachments INTEGER DEFAULT 0,
        attachment_count INTEGER DEFAULT 0,
        message_id_header TEXT,
        content_hash TEXT,
        labels TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const insert = db.prepare(
      "INSERT INTO emails (id, user_id, sent_at, subject, sender, recipients) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const e of EMAILS) {
      insert.run(e.id, USER_ID, new Date(e.ms).toISOString(), `subj ${e.id}`, "sender@x.com", "to@x.com");
    }
    setDb(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    setDb(null as unknown as DatabaseType);
  });

  it("includes the ENTIRE selected end day and honors both boundaries (exact ID set)", async () => {
    const rows = await getCachedEmails(USER_ID, { after: AFTER, before: BEFORE, maxResults: 100 });
    const ids = rows.map((r) => r.id).sort();

    const expected = EMAILS.filter((e) => e.included).map((e) => e.id).sort();
    // Exact identity assertion (not a count): every in-range/boundary email is
    // present, and both out-of-range emails are absent.
    expect(ids).toEqual(expected);

    const idSet = new Set(ids);
    expect(idSet.has("mid-end-day")).toBe(true); // the bug's signature: now present
    expect(idSet.has("just-after-end")).toBe(false); // no spill past midnight
    expect(idSet.has("just-before-start")).toBe(false);
  });

  it("regression guard: the OLD naive boundary would have dropped the end-day email", async () => {
    // Pre-fix, the modal sent `new Date("2026-07-25").toISOString()` ===
    // 2026-07-25T00:00:00.000Z as the (inclusive) end cutoff, so any email later
    // that day was excluded. `mid-end-day` is hours into 7/25 local, which in
    // UTC terms is strictly after 2026-07-25T00:00:00Z in every timezone.
    const buggyBefore = new Date("2026-07-25"); // UTC midnight
    const buggyRows = await getCachedEmails(USER_ID, { after: AFTER, before: buggyBefore, maxResults: 100 });
    expect(new Set(buggyRows.map((r) => r.id)).has("mid-end-day")).toBe(false);

    // The fixed boundary (end-of-day) includes it — direct contrast.
    const fixedRows = await getCachedEmails(USER_ID, { after: AFTER, before: BEFORE, maxResults: 100 });
    expect(new Set(fixedRows.map((r) => r.id)).has("mid-end-day")).toBe(true);
  });
});
