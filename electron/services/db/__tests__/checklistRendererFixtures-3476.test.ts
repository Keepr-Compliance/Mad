/**
 * @jest-environment node
 *
 * BACKLOG-3476 — THE CHECKLIST TAB'S FIXTURES COME FROM THE REAL PRODUCERS.
 *
 * The renderer suites under
 * `src/components/transactionDetailsModule/components/checklist/__tests__/`
 * read one JSON file. This suite is where that file comes from, and the
 * control that keeps it honest: it builds a transaction on the real driver
 * over the real schema, runs the three producers the tab consumes, and
 * compares the answer with the committed JSON.
 *
 *   ChecklistDetail      getChecklistForTransaction   (checklists:get)
 *   UnifiedAttachment[]  getTransactionAllAttachments (transactions:get-all-attachments)
 *   Communication[]      getCommunicationsWithMessages(transactions:getCommunications, "email")
 *
 * So a renderer test cannot describe a state the main process cannot emit
 * (CLAUDE.md, "Transcribe fixtures, never invent them"). If a producer's shape
 * changes, this goes red and the fixture is regenerated rather than edited:
 *
 *   CHECKLIST_FIXTURE_WRITE=1 ELECTRON_RUN_AS_NODE=1 npx electron \
 *     node_modules/jest/bin/jest.js --runTestsByPath \
 *     electron/services/db/__tests__/checklistRendererFixtures-3476.test.ts
 *
 * Random ids become `id-N` in first-seen order and the clock-stamped columns
 * become one fixed instant; nothing else is rewritten.
 *
 * The seed holds every state the tab has to draw:
 *   item 1  required, ticked, one attachment link
 *   item 2  required, not ticked, a thread link whose members share a thread_id
 *   item 3  optional, ticked, a note, a thread link PARTLY stale (one of two
 *           emails, e-solo-1, the first by id, was unlinked from the
 *           transaction afterwards)
 *   item 4  optional, not ticked, a link FULLY stale (its only email unlinked)
 * so requiredDone = 1 of 2 while two items are ticked — the case a renderer
 * counting ticks itself gets wrong.
 *
 * The attachment list also carries one LEGACY row reached only through the
 * `external_message_id` fallback arm, with `message_id` and `email_id` both
 * NULL. The current schema's CHECK refuses that row, so it is inserted with
 * `ignore_check_constraints` — which is exactly the database it lives in: one
 * created before the CHECK existed. The link picker must not offer it
 * (checklistSql.ts `targetsInTransactionSql` has no fallback arm).
 */
import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
jest.mock("../core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  addChecklistLink,
  getChecklistForTransaction,
  selectChecklistTemplate,
  setChecklistItemChecked,
  setChecklistItemNote,
} from "../checklistDbService";
import { getTransactionAllAttachments } from "../attachmentDbService";
import type { ChecklistDetail } from "../../../types/checklist";
import { getCommunicationsWithMessages } from "../communicationDbService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const FIXTURE = nodePath.join(
  __dirname, "..", "..", "..", "..",
  "src", "components", "transactionDetailsModule", "components", "checklist",
  "__tests__", "fixtures", "checklistFixtures-3476.json",
);
const USER = "user-3476";
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

function seed(): void {
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent@example.test', 'google', 'oa-3476')`, USER);
  run(`INSERT INTO transactions (id, user_id, property_address) VALUES ('txn-1', ?, '1 Probe Way')`, USER);

  const email = (id: string, threadId: string | null, subject: string, sender: string, sentAt: string) =>
    run(
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, thread_id, sent_at)
       VALUES (?, ?, ?, 'gmail', 'acct', ?, ?, 'agent@example.test', ?, ?)`,
      id, USER, `ext-${id}`, subject, sender, threadId, sentAt,
    );
  email("e-thread-1", "thr-probe", "Probe thread", "Probe Sender <sender-a@example.test>", "2026-03-01T10:00:00Z");
  email("e-thread-2", "thr-probe", "Re: Probe thread", "sender-b@example.test", "2026-03-02T10:00:00Z");
  email("e-solo-1", null, "Probe solo", "sender-a@example.test", "2026-03-03T10:00:00Z");
  email("e-solo-2", null, "Re: Probe solo", "sender-b@example.test", "2026-03-04T10:00:00Z");
  email("e-gone", null, "Probe gone", "sender-c@example.test", "2026-03-05T10:00:00Z");
  // Same conversation as e-solo-1/2 by subject only (thread_id NULL): the
  // Emails tab groups these three by normalized subject.
  email("e-solo-3", null, "Fwd: Probe solo", "sender-a@example.test", "2026-03-05T11:00:00Z");

  const link = (id: string, emailId: string, threadId: string | null = null) =>
    run(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source) VALUES (?, ?, 'txn-1', ?, ?, 'manual')`,
      id, USER, emailId, threadId,
    );
  link("cm-1", "e-thread-1", "thr-probe");
  link("cm-2", "e-thread-2", "thr-probe");
  link("cm-3", "e-solo-1");
  link("cm-4", "e-solo-2");
  link("cm-5", "e-gone");
  link("cm-7", "e-solo-3");

  run(
    `INSERT INTO attachments (id, email_id, filename, mime_type, file_size_bytes)
     VALUES ('att-1', 'e-solo-2', 'probe-document.pdf', 'application/pdf', 1258291),
            ('att-2', 'e-thread-1', 'probe-photo.jpg', 'image/jpeg', 204800)`,
  );

  // A text thread on the transaction, and the legacy fallback attachment.
  run(
    `INSERT INTO messages (id, user_id, channel, external_id, thread_id, body_text, sent_at, direction)
     VALUES ('m-1', ?, 'imessage', 'guid-probe-1', 'chat-probe', 'probe text', '2026-03-06T10:00:00Z', 'inbound')`,
    USER,
  );
  run(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source) VALUES ('cm-6', ?, 'txn-1', 'm-1', 'manual')`,
    USER,
  );
  run(
    `INSERT INTO attachments (id, message_id, filename, mime_type, file_size_bytes)
     VALUES ('att-text', 'm-1', 'probe-text-photo.heic', 'image/heic', 102400)`,
  );
  db.pragma("ignore_check_constraints = ON");
  run(
    `INSERT INTO attachments (id, external_message_id, filename, mime_type, file_size_bytes)
     VALUES ('att-legacy', 'guid-probe-1', 'probe-legacy.png', 'image/png', 51200)`,
  );
  db.pragma("ignore_check_constraints = OFF");
}

const TEMPLATE_ITEMS = [
  { title: "Probe item 1", description: "What counts for probe item 1.", isRequired: true, sortOrder: 0 },
  { title: "Probe item 2", description: null, isRequired: true, sortOrder: 1 },
  { title: "Probe item 3", description: "What counts for probe item 3.", isRequired: false, sortOrder: 2 },
  { title: "Probe item 4", description: null, isRequired: false, sortOrder: 3 },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK_KEYS = new Set(["checkedAt", "selectedAt", "created_at", "linked_at"]);
const FIXED_INSTANT = "2026-03-10T12:00:00.000Z";

/** Random ids → `id-N` in first-seen order; clock columns → one instant. */
function normalize(value: unknown): unknown {
  const seen = new Map<string, string>();
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const nk = UUID.test(k) ? (seen.get(k) ?? (seen.set(k, `id-${seen.size + 1}`), seen.get(k)!)) : k;
        out[nk] = walk(x, k);
      }
      return out;
    }
    if (typeof v === "string") {
      if (key && CLOCK_KEYS.has(key)) return FIXED_INSTANT;
      if (UUID.test(v)) {
        if (!seen.has(v)) seen.set(v, `id-${seen.size + 1}`);
        return seen.get(v);
      }
    }
    return v;
  };
  return walk(value);
}

/**
 * Two orders in the detail follow random UUIDs, not anything a user sees: the
 * key order of `linksByItemId` and the order of a link's `members`. Both are
 * fixed here so the fixture is stable run to run — keys in item order, members
 * by target id. The renderer must not depend on either order, and does not.
 */
function stableOrder(detail: ChecklistDetail): ChecklistDetail {
  const linksByItemId: ChecklistDetail["linksByItemId"] = {};
  for (const item of detail.items) {
    const links = detail.linksByItemId[item.id];
    if (!links) continue;
    linksByItemId[item.id] = links.map((l) => ({
      ...l,
      members: [...l.members].sort((x, y) =>
        String(x.emailId ?? x.attachmentId).localeCompare(String(y.emailId ?? y.attachmentId)),
      ),
    }));
  }
  return { ...detail, linksByItemId };
}

async function produce(): Promise<unknown> {
  const selected = await selectChecklistTemplate({
    transactionId: "txn-1",
    templateId: "tpl-probe",
    templateName: "Probe template",
    items: TEMPLATE_ITEMS,
  });
  expect(selected.status).toBe("selected");
  const first = await getChecklistForTransaction("txn-1");
  const [i1, i2, i3, i4] = first!.items;

  await setChecklistItemChecked(i1.id, true);
  await setChecklistItemChecked(i3.id, true);
  await setChecklistItemNote(i3.id, "Probe note text.");
  expect((await addChecklistLink({ itemId: i1.id, kind: "attachment", targetIds: ["att-1"] })).status).toBe("added");
  expect((await addChecklistLink({ itemId: i2.id, kind: "email", targetIds: ["e-thread-1", "e-thread-2"] })).status).toBe("added");
  expect((await addChecklistLink({ itemId: i3.id, kind: "email", targetIds: ["e-solo-1", "e-solo-2"] })).status).toBe("added");
  expect((await addChecklistLink({ itemId: i4.id, kind: "email", targetIds: ["e-gone"] })).status).toBe("added");

  // Unlinked from the transaction AFTER being linked to the checklist: the
  // evidence survives, so the members go stale rather than vanishing.
  // cm-3 (e-solo-1), not cm-4: members sort by id, so the STALE member of
  // item 3's link comes first. A chip that jumps to members[0] then aims at an
  // email no longer on the transaction, and the chip control sees it (SR B2).
  // att-1 hangs off e-solo-2 so it stays on the transaction.
  run(`DELETE FROM communications WHERE id IN ('cm-3', 'cm-5')`);

  return normalize({
    checklistDetail: stableOrder((await getChecklistForTransaction("txn-1"))!),
    attachments: getTransactionAllAttachments("txn-1"),
    emailCommunications: await getCommunicationsWithMessages("txn-1", "email"),
  });
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  seed();
});

afterEach(() => {
  db.close();
  // The 3475 teardown rule: a handle left open is invisible on macOS and a
  // hard EBUSY on Windows. In-memory here, but the assertion costs nothing.
  expect(db.open).toBe(false);
});

describe("BACKLOG-3476 — renderer fixtures match the producers", () => {
  it("the committed fixture is what the main process emits today", async () => {
    const produced = await produce();
    if (process.env.CHECKLIST_FIXTURE_WRITE === "1") {
      fs.writeFileSync(FIXTURE, JSON.stringify(produced, null, 2) + "\n");
    }
    const committed = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as unknown;
    expect(produced).toEqual(committed);
  });
});
