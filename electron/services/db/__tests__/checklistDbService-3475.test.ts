/**
 * @jest-environment node
 *
 * BACKLOG-3475 — THE CHECKLIST DB SERVICE, ON THE REAL DRIVER OVER THE REAL
 * SCHEMA.
 *
 * ===========================================================================
 * THE WRONG IMPLEMENTATIONS THIS SUITE EXISTS TO CATCH
 * ===========================================================================
 *   evidence expanded through `emails.thread_id`
 *       The obvious way to store "an email thread" — and wrong twice. Gmail
 *       writes `threadId || ""` (`gmailFetchService.ts:793`), which
 *       `emailDbService.ts:160` stores as `thread_id || null` -> NULL, so a
 *       thread-keyed link matches NOTHING for those rows; and where a thread_id
 *       IS set, expanding through it pulls in emails the user never picked.
 *       The fixture below is transcribed from that producer chain, not invented:
 *       two NULL-thread emails plus a third that shares a non-null thread_id
 *       with a linked one and must NOT appear.
 *   a second template appended instead of replacing
 *       The user picks a different template and ends up with two checklists.
 *   remove-then-instantiate as two database transactions
 *       A failure between them leaves the transaction with NO checklist — the
 *       user's plan destroyed and not replaced. The replace test forces a
 *       failure mid-copy and asserts the OLD checklist is still whole.
 *   trusting renderer-supplied evidence ids
 *       Evidence from another transaction, or evidence that was unlinked,
 *       silently attached to this one.
 *   state kept in a service cache
 *       Ticks and notes that vanish on restart. The last test closes the
 *       database and reopens it.
 */
import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
/**
 * Set by the one test that needs a database ON DISK, and removed in teardown
 * AFTER the handle is closed. Removing it inside the test body would be skipped
 * by any earlier assertion failure, and would run while the handle is still
 * open.
 */
let tempDir: string | null = null;
jest.mock("../core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));

import {
  addChecklistLink,
  getChecklistForTransaction,
  removeChecklist,
  removeChecklistLink,
  selectChecklistTemplate,
  setChecklistItemChecked,
  setChecklistItemNote,
} from "../checklistDbService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-3475-svc";

const rows = (q: string) => db.prepare(q).all() as Array<Record<string, unknown>>;
const ids = (table: string) => rows(`SELECT id FROM ${table} ORDER BY id`).map((r) => r.id as string);
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

const TEMPLATE_ITEMS = [
  { title: "Signed purchase agreement", isRequired: true, sortOrder: 0 },
  { title: "Inspection report", isRequired: true, sortOrder: 1 },
  { title: "Seller disclosure", isRequired: false, sortOrder: 2 },
];

function openSchema(file: string): DatabaseType {
  const handle = new Database(file) as unknown as DatabaseType;
  handle.pragma("foreign_keys = OFF");
  handle.exec(fs.readFileSync(SCHEMA, "utf8"));
  handle.pragma("foreign_keys = ON");
  return handle;
}

/**
 * The seed is transcribed from the real producers:
 *   e-solo-1 / e-solo-2  Gmail emails with NO threadId. `threadId || ""` at the
 *                        provider becomes `thread_id || null` at the writer, so
 *                        these land with thread_id NULL.
 *   e-thread-mate        shares thread 'thr-shared' with e-thread-linked, is
 *                        linked to the SAME transaction, and is deliberately
 *                        NOT selected. A thread-keyed link would sweep it in.
 *   e-other              linked to a DIFFERENT transaction.
 *   e-unlinked           exists, but has no communications row at all.
 */
function seed(): void {
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 's@example.test', 'google', 'oa-s')`, USER);
  run(`INSERT INTO transactions (id, user_id, property_address) VALUES ('txn-1', ?, '1 Main St'), ('txn-2', ?, '2 Side St')`, USER, USER);

  const email = (id: string, threadId: string | null, subject: string | null, sentAt: string) =>
    run(
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, thread_id, sent_at)
       VALUES (?, ?, ?, 'gmail', 'acct', ?, 's@example.com', 'me@example.com', ?, ?)`,
      id,
      USER,
      `ext-${id}`,
      subject,
      threadId,
      sentAt,
    );
  email("e-solo-1", null, "Offer for 1 Main St", "2026-03-01T10:00:00Z");
  email("e-solo-2", null, "Re: Offer for 1 Main St", "2026-03-02T10:00:00Z");
  email("e-thread-linked", "thr-shared", "Inspection booked", "2026-03-03T10:00:00Z");
  email("e-thread-mate", "thr-shared", "Re: Inspection booked", "2026-03-04T10:00:00Z");
  email("e-no-subject", null, "", "2026-03-05T10:00:00Z");
  email("e-other", null, "Another deal", "2026-03-06T10:00:00Z");
  email("e-unlinked", null, "Never linked", "2026-03-07T10:00:00Z");

  // A communications row linking an email that HAS a thread_id must carry that
  // thread_id, or the BACKLOG-1768 trigger aborts the insert. Transcribed from
  // that trigger (schema.sql: "communications.thread_id required"), which is
  // also what makes the thread-mate case below realistic: in production both
  // thread emails really are linked with the thread on the link row.
  const link = (id: string, txn: string, emailId: string, threadId: string | null = null) =>
    run(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source) VALUES (?, ?, ?, ?, ?, 'manual')`,
      id,
      USER,
      txn,
      emailId,
      threadId,
    );
  link("cm-1", "txn-1", "e-solo-1");
  link("cm-2", "txn-1", "e-solo-2");
  link("cm-3", "txn-1", "e-thread-linked", "thr-shared");
  link("cm-4", "txn-1", "e-thread-mate", "thr-shared");
  link("cm-5", "txn-1", "e-no-subject");
  link("cm-6", "txn-2", "e-other");

  run(`INSERT INTO attachments (id, email_id, filename) VALUES ('att-1', 'e-solo-1', 'offer.pdf'), ('att-other', 'e-other', 'other.pdf')`);
}

beforeEach(() => {
  db = openSchema(":memory:");
  seed();
});

afterEach(() => {
  try {
    db.close();
    /**
     * THE CONTROL, and the reason the directory is removed here rather than in
     * the test body.
     *
     * A database handle that is still open when its file is deleted is
     * INVISIBLE on macOS and Linux, which permit unlinking an open file.
     * Windows refuses and raises `EBUSY: resource busy or locked, unlink`;
     * `force: true` suppresses ENOENT, never EBUSY. Asserting the handle is
     * shut makes the leak fail LOUDLY on a developer's machine instead of only
     * on a Windows runner: delete the `db.close()` above and this goes red
     * locally on macOS, which is how it was verified. Same shape as the leaked
     * worker connection in `contactQueryWorker.backfillPlan-2669.test.ts`.
     */
    expect(db.open).toBe(false);
  } finally {
    // Cleanup runs even when the assertion above fails, so one leaked handle
    // cannot strand a temp directory for every later run.
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  }
});

describe("BACKLOG-3475 — picking a template copies it onto the transaction", () => {
  it("copies every item, and the copy is independent of the template", async () => {
    const result = await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });

    expect(result.status).toBe("selected");
    const detail = await getChecklistForTransaction("txn-1");
    expect(detail?.items.map((i) => i.title)).toEqual([
      "Signed purchase agreement",
      "Inspection report",
      "Seller disclosure",
    ]);
    expect(detail?.requiredTotal).toBe(2);
    expect(detail?.requiredDone).toBe(0);
    // `template_id` is provenance: it is stored, and nothing reads through it.
    expect(detail?.checklist.templateId).toBe("tpl-1");
  });

  it("a second pick is REFUSED and changes nothing, unless replaceExisting is set", async () => {
    await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });
    const firstItemIds = ids("transaction_checklist_items");
    await setChecklistItemChecked(firstItemIds[0], true);

    const refused = await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-2",
      templateName: "Commercial",
      items: [{ title: "Lease", isRequired: true, sortOrder: 0 }],
    });

    expect(refused.status).toBe("exists");
    // Not one row changed — including the tick the user had already made.
    expect(ids("transaction_checklist_items")).toEqual(firstItemIds);
    expect(ids("transaction_checklists").length).toBe(1);
    expect(rows(`SELECT is_checked FROM transaction_checklist_items WHERE id = '${firstItemIds[0]}'`)).toEqual([
      { is_checked: 1 },
    ]);

    const replaced = await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-2",
      templateName: "Commercial",
      items: [{ title: "Lease", isRequired: true, sortOrder: 0 }],
      replaceExisting: true,
    });

    expect(replaced.status).toBe("replaced");
    // Still exactly one checklist, and every old item id is gone.
    expect(ids("transaction_checklists").length).toBe(1);
    expect(ids("transaction_checklist_items").some((id) => firstItemIds.includes(id))).toBe(false);
    const detail = await getChecklistForTransaction("txn-1");
    expect(detail?.items.map((i) => i.title)).toEqual(["Lease"]);
  });

  it("a replace that fails mid-copy leaves the OLD checklist whole", async () => {
    await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });
    const originalChecklistIds = ids("transaction_checklists");
    const originalItemIds = ids("transaction_checklist_items");

    // The second item's title is blank, which the column's CHECK refuses. The
    // delete of the old checklist has ALREADY run by then, inside the same
    // database transaction.
    //
    // `toThrow`, not `rejects.toThrow`: these are plain functions returning
    // `Promise<T>` rather than `async` ones (BACKLOG-2960), so the driver call
    // is evaluated before `Promise.resolve` wraps it and a failure throws
    // before the promise exists. `rejects` would pass vacuously on a function
    // that never rejected at all.
    expect(() =>
      selectChecklistTemplate({
        transactionId: "txn-1",
        templateId: "tpl-2",
        templateName: "Commercial",
        items: [
          { title: "Lease", isRequired: true, sortOrder: 0 },
          { title: "   ", isRequired: true, sortOrder: 1 },
        ],
        replaceExisting: true,
      }),
    ).toThrow(/CHECK constraint failed/);

    // Rolled back whole: the user still has the checklist they had before.
    expect(ids("transaction_checklists")).toEqual(originalChecklistIds);
    expect(ids("transaction_checklist_items")).toEqual(originalItemIds);
  });

  it("a first pick that fails mid-copy leaves no checklist and no items", async () => {
    expect(() =>
      selectChecklistTemplate({
        transactionId: "txn-1",
        templateId: "tpl-1",
        templateName: "Residential Purchase",
        items: [
          { title: "Signed purchase agreement", isRequired: true, sortOrder: 0 },
          { title: "", isRequired: true, sortOrder: 1 },
        ],
      }),
    ).toThrow(/CHECK constraint failed/);

    expect(ids("transaction_checklists")).toEqual([]);
    expect(ids("transaction_checklist_items")).toEqual([]);
  });

  it("a transaction that does not exist is refused, not thrown", async () => {
    const result = await selectChecklistTemplate({
      transactionId: "txn-missing",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });
    expect(result).toEqual({ status: "no_transaction" });
    expect(ids("transaction_checklists")).toEqual([]);
  });
});

describe("BACKLOG-3475 — evidence is the set of ids the user picked, never a thread expansion", () => {
  let itemId = "";

  beforeEach(async () => {
    await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });
    itemId = ids("transaction_checklist_items")[0];
  });

  it("two NULL-thread emails are stored as exactly those two, and a thread-mate is NOT swept in", async () => {
    const result = await addChecklistLink({
      itemId,
      kind: "email",
      targetIds: ["e-solo-1", "e-thread-linked"],
    });

    expect(result.status).toBe("added");
    const stored = rows(`SELECT email_id FROM transaction_checklist_link_members ORDER BY email_id`).map(
      (r) => r.email_id,
    );
    // e-thread-mate shares 'thr-shared' with e-thread-linked and is linked to
    // the same transaction. If evidence were expanded through thread_id it
    // would be here.
    expect(stored).toEqual(["e-solo-1", "e-thread-linked"]);
  });

  it("the group's label is derived from the earliest email, with a fallback when it has no subject", async () => {
    await addChecklistLink({ itemId, kind: "email", targetIds: ["e-solo-2", "e-solo-1"] });
    expect(rows(`SELECT label FROM transaction_checklist_links`)).toEqual([
      { label: "Offer for 1 Main St" },
    ]);

    const secondItem = ids("transaction_checklist_items")[1];
    await addChecklistLink({ itemId: secondItem, kind: "email", targetIds: ["e-no-subject"] });
    expect(
      rows(`SELECT label FROM transaction_checklist_links WHERE item_id = '${secondItem}'`),
    ).toEqual([{ label: "(no subject)" }]);
  });

  it("evidence from another transaction, unlinked evidence and unknown ids are all refused with nothing written", async () => {
    for (const targetIds of [["e-other"], ["e-unlinked"], ["e-does-not-exist"], ["e-solo-1", "e-other"]]) {
      const result = await addChecklistLink({ itemId, kind: "email", targetIds });
      expect(result.status).toBe("targets_not_in_transaction");
      // Including the mixed case: the VALID id is not written either.
      expect(ids("transaction_checklist_links")).toEqual([]);
      expect(ids("transaction_checklist_link_members")).toEqual([]);
    }

    const attachment = await addChecklistLink({ itemId, kind: "attachment", targetIds: ["att-other"] });
    expect(attachment.status).toBe("targets_not_in_transaction");
    expect(ids("transaction_checklist_links")).toEqual([]);
  });

  it("an attachment of this transaction is accepted and labelled with its filename", async () => {
    const result = await addChecklistLink({ itemId, kind: "attachment", targetIds: ["att-1"] });
    expect(result.status).toBe("added");
    expect(rows(`SELECT kind, label FROM transaction_checklist_links`)).toEqual([
      { kind: "attachment", label: "offer.pdf" },
    ]);
  });

  it("an item that does not exist is refused, not thrown", async () => {
    const result = await addChecklistLink({ itemId: "no-such-item", kind: "email", targetIds: ["e-solo-1"] });
    expect(result).toEqual({ status: "no_item" });
    expect(ids("transaction_checklist_links")).toEqual([]);
  });

  it("removing a group removes its members, and unlinking evidence marks it stale rather than deleting it", async () => {
    const added = await addChecklistLink({
      itemId,
      kind: "email",
      targetIds: ["e-solo-1", "e-solo-2"],
    });
    expect(added.status).toBe("added");

    // Unlink e-solo-2 from the transaction. The email survives, so the member
    // survives — reported as stale, which is what lets the surface explain it.
    run(`DELETE FROM communications WHERE id = 'cm-2'`);
    const detail = await getChecklistForTransaction("txn-1");
    const members = detail?.linksByItemId[itemId]?.[0]?.members ?? [];
    expect(members.map((m) => `${m.emailId}:${m.inTransaction}`).sort()).toEqual([
      "e-solo-1:true",
      "e-solo-2:false",
    ]);

    expect(await removeChecklistLink(added.status === "added" ? added.linkId : "")).toBe(true);
    expect(ids("transaction_checklist_link_members")).toEqual([]);
    // The emails themselves are untouched: removing evidence from a checklist
    // is not a delete.
    expect(rows(`SELECT COUNT(*) AS n FROM emails`)[0].n).toBe(7);
  });
});

describe("BACKLOG-3475 — ticks and notes are in the database, not in a cache", () => {
  it("survive closing and reopening the database file", async () => {
    tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3475-"));
    const file = nodePath.join(tempDir, "checklist.db");
    db.close();
    db = openSchema(file);
    seed();

    await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });
    // By sort order, not by id: ids are random UUIDs, so `ids(...)[0]` picks an
    // arbitrary item and an assertion about REQUIRED items would then pass or
    // fail by luck. `first` here is deliberately a required one.
    const seeded = await getChecklistForTransaction("txn-1");
    const first = seeded!.items[0].id;
    const second = seeded!.items[1].id;
    expect(seeded!.items[0].isRequired).toBe(true);
    await setChecklistItemChecked(first, true);
    await setChecklistItemNote(second, "Chasing the inspector");
    await addChecklistLink({ itemId: first, kind: "email", targetIds: ["e-solo-1"] });

    db.close();
    db = new Database(file) as unknown as DatabaseType;
    db.pragma("foreign_keys = ON");

    const detail = await getChecklistForTransaction("txn-1");
    const reloaded = detail?.items.find((i) => i.id === first);
    expect(reloaded?.isChecked).toBe(true);
    expect(reloaded?.checkedAt).not.toBeNull();
    expect(detail?.items.find((i) => i.id === second)?.note).toBe("Chasing the inspector");
    expect(detail?.requiredDone).toBe(1);
    expect(detail?.linksByItemId[first]?.[0]?.members.map((m) => m.emailId)).toEqual(["e-solo-1"]);

    // Unticking clears the time in the same statement, and that persists too.
    await setChecklistItemChecked(first, false);
    expect(
      rows(`SELECT is_checked, checked_at FROM transaction_checklist_items WHERE id = '${first}'`),
    ).toEqual([{ is_checked: 0, checked_at: null }]);
  });

  it("removing the checklist empties all four tables for that transaction", async () => {
    await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });
    const itemId = ids("transaction_checklist_items")[0];
    await addChecklistLink({ itemId, kind: "email", targetIds: ["e-solo-1"] });

    expect(await removeChecklist("txn-1")).toBe(true);

    expect(ids("transaction_checklists")).toEqual([]);
    expect(ids("transaction_checklist_items")).toEqual([]);
    expect(ids("transaction_checklist_links")).toEqual([]);
    expect(ids("transaction_checklist_link_members")).toEqual([]);
    expect(await getChecklistForTransaction("txn-1")).toBeNull();
    // Removing a checklist twice is a no-op, not an error.
    expect(await removeChecklist("txn-1")).toBe(false);
  });
});
