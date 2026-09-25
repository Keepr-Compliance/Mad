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
 *   an add that deletes, or a remove that reaches past its checklist
 *       (BACKLOG-3476: a transaction holds several checklists). Adding never
 *       deletes anything (BACKLOG-3476 round 2: Change is gone, so this is
 *       now the ONLY thing `selectChecklistTemplate` can do); remove acts on
 *       ONE checklist of ONE transaction.
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
  getChecklistsForTransaction,
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

/** The first (by display order) checklist on a transaction, or undefined. */
async function getChecklistForTransaction(transactionId: string) {
  return (await getChecklistsForTransaction(transactionId)).checklists[0];
}

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

    expect(result.status).toBe("added");
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

  it("progress counts REQUIRED ticks only: ticking an optional item leaves requiredDone at 0 (BACKLOG-3476)", async () => {
    // The tab renders `requiredDone of requiredTotal` straight from here, so
    // counting an optional tick would tell the agent a required document is
    // done when it is not. Nothing pinned this before 3476: counting every
    // tick left every checklist suite green.
    await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });
    // By title, not by id: ids are random UUIDs.
    const seeded = await getChecklistForTransaction("txn-1");
    const optional = seeded!.items.find((i) => i.title === "Seller disclosure")!;
    expect(optional.isRequired).toBe(false);

    await setChecklistItemChecked(optional.id, true);

    const detail = await getChecklistForTransaction("txn-1");
    expect(detail!.items.find((i) => i.id === optional.id)!.isChecked).toBe(true);
    expect(detail!.requiredDone).toBe(0);
    expect(detail!.requiredTotal).toBe(2);
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

  it("an EMPTY target list is its own answer, no_targets, and writes nothing (BACKLOG-3476)", async () => {
    // Unreachable over IPC (Zod `.min(1)`, pinned in the handler suite), so
    // this is the db contract for an in-process caller. Before 3476 the guard
    // answered `targets_not_in_transaction` with an empty `rejectedIds`, and
    // replacing it with `no_item` or deleting it outright left every checklist
    // suite green. Exact object, so neither of those passes.
    for (const kind of ["email", "attachment"] as const) {
      const result = await addChecklistLink({ itemId, kind, targetIds: [] });
      expect(result).toEqual({ status: "no_targets" });
    }
    expect(ids("transaction_checklist_links")).toEqual([]);
    expect(ids("transaction_checklist_link_members")).toEqual([]);
  });

  it("a repeated target id is stored once (BACKLOG-3476)", async () => {
    const result = await addChecklistLink({
      itemId,
      kind: "email",
      targetIds: ["e-solo-1", "e-solo-1"],
    });
    expect(result).toMatchObject({ status: "added", memberCount: 1 });
    expect(
      rows(`SELECT email_id FROM transaction_checklist_link_members`).map((r) => r.email_id),
    ).toEqual(["e-solo-1"]);
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
    const added = await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: "tpl-1",
      templateName: "Residential Purchase",
      items: TEMPLATE_ITEMS,
    });
    if (added.status !== "added") throw new Error("seed failed");
    const itemId = ids("transaction_checklist_items")[0];
    await addChecklistLink({ itemId, kind: "email", targetIds: ["e-solo-1"] });

    expect(await removeChecklist("txn-1", added.checklistId)).toMatchObject({
      id: added.checklistId,
      templateId: "tpl-1",
    });

    expect(ids("transaction_checklists")).toEqual([]);
    expect(ids("transaction_checklist_items")).toEqual([]);
    expect(ids("transaction_checklist_links")).toEqual([]);
    expect(ids("transaction_checklist_link_members")).toEqual([]);
    expect(await getChecklistsForTransaction("txn-1")).toEqual({
      checklists: [],
      requiredDone: 0,
      requiredTotal: 0,
    });
    // Removing a checklist twice is a no-op, not an error.
    expect(await removeChecklist("txn-1", added.checklistId)).toBeNull();
  });
});

// ===========================================================================
// BACKLOG-3476 — several checklists per transaction
// ===========================================================================

const TPL_A = "tpl-a";
const TPL_B = "tpl-b";

async function addTemplate(
  transactionId: string,
  templateId: string,
  templateName: string,
  items = TEMPLATE_ITEMS,
): Promise<string> {
  const result = await selectChecklistTemplate({ transactionId, templateId, templateName, items });
  if (result.status !== "added") throw new Error(`add ${templateId} answered ${result.status}`);
  return result.checklistId;
}

/** Every row under one checklist, by table, so "intact" can be asserted row for row. */
function rowsUnder(checklistId: string) {
  return {
    checklist: rows(`SELECT * FROM transaction_checklists WHERE id = '${checklistId}'`),
    items: rows(
      `SELECT * FROM transaction_checklist_items WHERE checklist_id = '${checklistId}' ORDER BY id`,
    ),
    links: rows(
      `SELECT l.* FROM transaction_checklist_links l JOIN transaction_checklist_items i ON i.id = l.item_id
       WHERE i.checklist_id = '${checklistId}' ORDER BY l.id`,
    ),
    members: rows(
      `SELECT m.* FROM transaction_checklist_link_members m
       JOIN transaction_checklist_links l ON l.id = m.link_id
       JOIN transaction_checklist_items i ON i.id = l.item_id
       WHERE i.checklist_id = '${checklistId}' ORDER BY m.id`,
    ),
  };
}

/** Tick, note and link the first item of a checklist, so it has something to lose. */
async function dirty(checklistId: string): Promise<void> {
  const detail = (await getChecklistsForTransaction("txn-1")).checklists.find(
    (d) => d.checklist.id === checklistId,
  )!;
  const first = detail.items[0].id;
  await setChecklistItemChecked(first, true);
  await setChecklistItemNote(first, "Received");
  const linked = await addChecklistLink({ itemId: first, kind: "email", targetIds: ["e-solo-1"] });
  expect(linked.status).toBe("added");
}

function everyRow() {
  return [
    "transaction_checklists",
    "transaction_checklist_items",
    "transaction_checklist_links",
    "transaction_checklist_link_members",
  ].map((t) => rows(`SELECT * FROM ${t} ORDER BY id`));
}

describe("BACKLOG-3476 — several checklists per transaction", () => {
  it("A-1: adding a second template never touches the first (its tick, note and link rows are intact)", async () => {
    const a = await addTemplate("txn-1", TPL_A, "Listing");
    await dirty(a);
    const before = rowsUnder(a);
    expect(before.links).toHaveLength(1);

    await addTemplate("txn-1", TPL_B, "Buyer");

    expect(ids("transaction_checklists")).toHaveLength(2);
    expect(rowsUnder(a)).toEqual(before);
  });

  it("A-2: get returns every checklist, in sort_order", async () => {
    const a = await addTemplate("txn-1", TPL_A, "Listing");
    const b = await addTemplate("txn-1", TPL_B, "Buyer");
    const got = await getChecklistsForTransaction("txn-1");
    expect(got.checklists.map((d) => d.checklist.id)).toEqual([a, b]);
    expect(got.checklists.map((d) => d.checklist.sortOrder)).toEqual([0, 1]);

    // Order is the stored position, not insertion order.
    run(`UPDATE transaction_checklists SET sort_order = 5 WHERE id = ?`, a);
    const reordered = await getChecklistsForTransaction("txn-1");
    expect(reordered.checklists.map((d) => d.checklist.id)).toEqual([b, a]);
  });

  it("A-3: removing one checklist leaves the other's rows intact", async () => {
    const a = await addTemplate("txn-1", TPL_A, "Listing");
    const b = await addTemplate("txn-1", TPL_B, "Buyer");
    await dirty(a);
    const aBefore = rowsUnder(a);

    expect(await removeChecklist("txn-1", b)).not.toBeNull();
    expect(rowsUnder(a)).toEqual(aBefore);
    expect(ids("transaction_checklists")).toEqual([a]);
  });

  it("A-4: a remove naming another transaction's checklist is refused and changes no row anywhere", async () => {
    await addTemplate("txn-1", TPL_A, "Listing");
    const other = await addTemplate("txn-2", TPL_A, "Listing");
    const before = everyRow();

    expect(await removeChecklist("txn-1", other)).toBeNull();
    expect(everyRow()).toEqual(before);
  });

  it("A-5 (main half): the envelope sums REQUIRED progress across checklists", async () => {
    const a = await addTemplate("txn-1", TPL_A, "Listing", [
      { title: "A1", isRequired: true, sortOrder: 0 },
      { title: "A2", isRequired: true, sortOrder: 1 },
      { title: "A3 optional", isRequired: false, sortOrder: 2 },
    ]);
    const b = await addTemplate("txn-1", TPL_B, "Buyer", [
      { title: "B1", isRequired: true, sortOrder: 0 },
      { title: "B2", isRequired: true, sortOrder: 1 },
      { title: "B3", isRequired: true, sortOrder: 2 },
    ]);
    const tick = (title: string) =>
      setChecklistItemChecked(
        (rows(`SELECT id FROM transaction_checklist_items WHERE title = '${title}'`)[0].id as string),
        true,
      );
    await tick("A1");
    await tick("A3 optional");
    await tick("B1");

    const got = await getChecklistsForTransaction("txn-1");
    const byId = Object.fromEntries(got.checklists.map((d) => [d.checklist.id, d]));
    expect([byId[a].requiredDone, byId[a].requiredTotal]).toEqual([1, 2]);
    expect([byId[b].requiredDone, byId[b].requiredTotal]).toEqual([1, 3]);
    expect([got.requiredDone, got.requiredTotal]).toEqual([2, 5]);
  });

  it("A-9: the same template twice is refused as exists, with one row", async () => {
    const a = await addTemplate("txn-1", TPL_A, "Listing");
    const again = await selectChecklistTemplate({
      transactionId: "txn-1",
      templateId: TPL_A,
      templateName: "Listing",
      items: TEMPLATE_ITEMS,
    });
    expect(again).toEqual({ status: "exists", checklistId: a });
    expect(ids("transaction_checklists")).toEqual([a]);
  });

  it("Q2: allItemsChecked is true only when every item, optional included, is ticked; never for zero items", async () => {
    const a = await addTemplate("txn-1", TPL_A, "Listing");
    const empty = await addTemplate("txn-1", TPL_B, "Empty", []);
    const itemsOf = (id: string) =>
      rows(`SELECT id, is_required FROM transaction_checklist_items WHERE checklist_id = '${id}' ORDER BY sort_order`);
    for (const item of itemsOf(a).filter((i) => i.is_required === 1)) {
      await setChecklistItemChecked(item.id as string, true);
    }
    const flag = async (id: string) =>
      (await getChecklistsForTransaction("txn-1")).checklists.find((d) => d.checklist.id === id)!
        .allItemsChecked;
    // All required ticked, the optional one not.
    expect(await flag(a)).toBe(false);
    for (const item of itemsOf(a)) await setChecklistItemChecked(item.id as string, true);
    expect(await flag(a)).toBe(true);
    expect(await flag(empty)).toBe(false);
  });
});
