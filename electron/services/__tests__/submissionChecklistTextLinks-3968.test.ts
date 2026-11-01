/**
 * @jest-environment node
 *
 * BACKLOG-3968 PR-4a — checklist TEXT links at submit and in the export read.
 *
 * Real `schema.sql` (v78 shape), real driver (by absolute path; SR plan review
 * c4cae33e R9), real `submissionService.gatherForSubmission`, real text
 * selection and audit-window query, real gap finder and payload builder, real
 * checklist reader. Same harness as submitTextSet-3733.test.ts: the database
 * singleton is mocked only to delegate to the real statement modules.
 *
 * No writer of text links exists yet (PR-4b), so the link rows are inserted
 * with the v78 DDL's own columns.
 *
 * Corpus (deal window 2026-09-24 .. 2026-09-24, one user):
 *   t-in       thread-linked text, in the window        uploaded
 *   o-before   thread-linked text, BEFORE the window    in the export selection, NOT uploaded
 *   t-hid      thread-linked text, hidden from export   not selected, not uploaded
 *   t-off      a text on a thread the deal does not hold (stale member)
 *   t-re       a re-imported text: the hide row names its OLD id and its guid
 *
 * Links on "Signed offer":
 *   L-texts  [t-in, o-before]   L-hid [t-hid]   L-off [t-off]   L-re [t-re]
 *
 * The hold constant is read through a getter so one file can run both states;
 * a separate test pins the REAL value (held) — R6 / C14.
 *
 * Runner (real sqlite -> Electron ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/submissionChecklistTextLinks-3968.test.ts --bail=0
 *
 * EVERY FIXTURE ROW IS SYNTHETIC. This repo is public.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let db: DatabaseType;
let mockTextLinksHeld = true;

jest.mock("../checklistTextLinkHold", () => ({
  get TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION() {
    return mockTextLinksHeld;
  },
}));

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => db,
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  setDb: jest.fn(),
}));

jest.mock("../databaseService", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const submissionDb = require("../db/submissionDbService");
  const communicationDb = require("../db/communicationDbService");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const call =
    (fn: (...a: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args);
  return {
    __esModule: true,
    default: {
      getRawDatabase: () => db,
      getTransactionById: async (id: string) =>
        db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) ?? null,
      getCommunicationsByTransaction: call(communicationDb.getCommunicationsWithMessages),
      getTransactionContactsWithRoles: async () => [],
      getTransactionMessages: call(submissionDb.getTransactionMessages),
      getTransactionEmails: call(submissionDb.getTransactionEmails),
      getTransactionAttachments: call(submissionDb.getTransactionAttachments),
      getUndownloadedEmailAttachments: call(submissionDb.getUndownloadedEmailAttachments),
      updateTransaction: jest.fn(),
    },
  };
});

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getAuthSession: jest.fn().mockResolvedValue({ userId: "user-3968-owner" }),
    getClient: jest.fn(),
    trackEvent: jest.fn(),
  },
}));
jest.mock("../emailAttachmentDownload", () => ({
  downloadMissingEmailAttachments: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../contactsService");
jest.mock("../contactResolutionService", () => ({
  resolveHandles: jest.fn().mockResolvedValue({ names: {}, matches: {} }),
  extractParticipantHandles: jest.fn().mockReturnValue([]),
  nameForHandle: jest.fn(),
}));
jest.mock("../gmailFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../outlookFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.45.0"), getPath: jest.fn(() => "/tmp") },
  net: { isOnline: jest.fn().mockReturnValue(true) },
}));

import { createThreadCommunicationReference } from "../db/communicationDbService";
import { hideTextFromExport } from "../db/hiddenTextDbService";
import { submissionService } from "../submissionService";
import { setPreflightStatForTests } from "../submissionPreflight";
import {
  getChecklistExportTargets,
  getChecklistsForTransaction,
  selectChecklistTemplate,
  setChecklistLinkIncludeOutsideDates,
} from "../db/checklistDbService";
import { buildChecklistSnapshotPayload, type SnapshotSentSets } from "../submissionChecklistSnapshot";
import { gapMemberKeys, type ChecklistLinkGap } from "../submissionChecklistLinkGaps";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

const OWNER = "user-3968-owner";
const TXN = "txn-3968-texts";
const DAY = "2026-09-24";
/** uuid-shaped (select-template validates one); generated per run, never a stored value. */
const TEMPLATE = randomUUID();

const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00Z`;

function insertText(id: string, thread: string, sentAt: string, externalId = `guid-${id}`): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at, has_attachments)
     VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?, ?, ?, 0)`,
  ).run(id, OWNER, externalId, `Body ${id}`, JSON.stringify({ from: "+15550101", to: ["me"] }), thread, sentAt);
}

function insertTextLink(linkId: string, itemId: string, label: string, messageIds: string[], sortOrder: number): void {
  db.prepare(
    `INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order) VALUES (?, ?, 'text', ?, ?)`,
  ).run(linkId, itemId, label, sortOrder);
  for (const messageId of messageIds) {
    db.prepare(
      `INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES (?, ?, 'text', ?)`,
    ).run(`${linkId}-${messageId}`, linkId, messageId);
  }
}

async function seed(): Promise<void> {
  db.exec(
    "DELETE FROM transaction_checklists; DELETE FROM transaction_hidden_texts; DELETE FROM communications; DELETE FROM messages; DELETE FROM transactions; DELETE FROM users_local;",
  );
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
    OWNER,
    "owner-3968@example.test",
    "oauth-3968",
  );
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?, ?, '1 Fixture Way', ?, ?)",
  ).run(TXN, OWNER, DAY, DAY);

  insertText("t-in", "chat-a", at("12:00"));
  insertText("o-before", "chat-a", at("12:00", "2026-09-10"));
  insertText("t-hid", "chat-a", at("12:05"));
  insertText("t-off", "chat-b", at("12:10"));
  insertText("t-re", "chat-a", at("12:15"), "guid-reimported");
  await createThreadCommunicationReference("chat-a", TXN, OWNER, "manual");
  expect(await hideTextFromExport({ transactionId: TXN, messageId: "t-hid", userId: OWNER })).toBe(true);
  // A hide recorded before a re-import: the old id, the shared guid.
  db.prepare(
    "INSERT INTO transaction_hidden_texts (transaction_id, message_id, message_external_id, hidden_by) VALUES (?, 't-re-old-id', 'guid-reimported', ?)",
  ).run(TXN, OWNER);

  const added = await selectChecklistTemplate({
    transactionId: TXN,
    templateId: TEMPLATE,
    templateName: "Residential Purchase",
    items: [{ title: "Signed offer", isRequired: true, sortOrder: 0 }],
  });
  if (added.status !== "added") throw new Error("seed: template not added");
  const itemId = (db.prepare("SELECT id FROM transaction_checklist_items").get() as { id: string }).id;
  insertTextLink("L-texts", itemId, "Texts with seller", ["t-in", "o-before"], 0);
  insertTextLink("L-hid", itemId, "Hidden text", ["t-hid"], 1);
  insertTextLink("L-off", itemId, "Other thread", ["t-off"], 2);
  insertTextLink("L-re", itemId, "Re-imported", ["t-re"], 3);
}

type Gathered = {
  messages: Array<{ id: string }>;
  checklistLinkGaps: ChecklistLinkGap[];
  sentEmailIds: Set<string>;
  sentAttachmentIds: Set<string>;
  sentTextIds: Set<string>;
};
const gather = (): Promise<Gathered> =>
  (submissionService as unknown as { gatherForSubmission(id: string): Promise<Gathered> }).gatherForSubmission(TXN);

const sentSets = (g: Gathered): SnapshotSentSets => ({
  emailIds: g.sentEmailIds,
  attachmentIds: g.sentAttachmentIds,
  textIds: g.sentTextIds,
  acceptedMembers: gapMemberKeys(g.checklistLinkGaps),
});

const gapSummary = (gaps: ChecklistLinkGap[]) =>
  gaps
    .map((g) => ({ linkId: g.linkId, kind: g.kind, reason: g.reason, detail: g.detail, missingIds: g.missingIds }))
    .sort((a, b) => a.linkId.localeCompare(b.linkId));

const payloadLinks = (payload: ReturnType<typeof buildChecklistSnapshotPayload>) =>
  payload.flatMap((c) => c.items.flatMap((i) => i.links));

beforeAll(() => {
  db = new RealDatabase(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  db.pragma("foreign_keys = ON");
  setPreflightStatForTests(async () => ({ size: 1024 }));
});

afterAll(() => {
  setPreflightStatForTests(null);
  db.close();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockTextLinksHeld = true;
  await seed();
});

describe("BACKLOG-3968 — the stored text link, read back", () => {
  it("the REAL driver, at a known SQLite version (a CHECK fires)", () => {
    const { v } = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    expect(v).toMatch(/^3\.\d+\.\d+$/);
    expect(() =>
      db.prepare("INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('x', 'y', 'fax', 'z')").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("reads as kind 'text' with message ids, and knows which texts are still on the deal", async () => {
    const { checklists } = await getChecklistsForTransaction(TXN, "broker");
    const links = Object.values(checklists[0].linksByItemId).flat();
    expect(
      links.map((l) => ({
        id: l.id,
        kind: l.kind,
        members: l.members.map((m) => [m.kind, m.messageId, m.attachmentId, m.emailId, m.inTransaction]),
      })),
    ).toEqual([
      { id: "L-texts", kind: "text", members: [["text", "o-before", null, null, true], ["text", "t-in", null, null, true]] },
      { id: "L-hid", kind: "text", members: [["text", "t-hid", null, null, true]] },
      { id: "L-off", kind: "text", members: [["text", "t-off", null, null, false]] },
      { id: "L-re", kind: "text", members: [["text", "t-re", null, null, true]] },
    ]);
  });
});

describe("BACKLOG-3968 — the hold (TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION)", () => {
  it("C14 pin: the shipped value is HELD", () => {
    const real = jest.requireActual("../checklistTextLinkHold") as typeof import("../checklistTextLinkHold");
    expect(real.TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION).toBe(true);
  });

  it("R2: the uploaded texts are the gathered messages (selection AND window), not the selection", async () => {
    const g = await gather();
    expect([...g.sentTextIds].sort()).toEqual(g.messages.map((m) => m.id).sort());
    // o-before is in the export selection but outside the window; t-hid is hidden.
    expect([...g.sentTextIds].sort()).toEqual(["t-in"]);
  });

  it("C14a (held): every text link is a pre-flight line — not included, never asked about the dates", async () => {
    const g = await gather();
    expect(gapSummary(g.checklistLinkGaps)).toEqual([
      { linkId: "L-hid", kind: "text", reason: "not_included", detail: "not_sent", missingIds: ["t-hid"] },
      { linkId: "L-off", kind: "text", reason: "not_included", detail: "not_on_transaction", missingIds: ["t-off"] },
      { linkId: "L-re", kind: "text", reason: "not_included", detail: "not_sent", missingIds: ["t-re"] },
      { linkId: "L-texts", kind: "text", reason: "not_included", detail: "not_sent", missingIds: ["o-before", "t-in"] },
    ]);
  });

  it("C14b (held): the payload carries no text link — with the submit's sent sets, and without", async () => {
    const g = await gather();
    const local = await getChecklistsForTransaction(TXN, "broker");
    const withheld: string[] = [];
    const payload = buildChecklistSnapshotPayload(local, sentSets(g), withheld);
    expect(payloadLinks(payload)).toEqual([]);
    // Every held member was listed and accepted at the pre-flight, so none is an unconfirmed drop.
    const accepted = sentSets(g).acceptedMembers;
    expect(withheld.sort()).toEqual(["L-hid:t-hid", "L-off:t-off", "L-re:t-re", "L-texts:o-before", "L-texts:t-in"]);
    expect(withheld.filter((m) => !accepted.has(m))).toEqual([]);
    // The item itself still goes up.
    expect(payload[0].items.map((i) => i.title)).toEqual(["Signed offer"]);
    expect(payloadLinks(buildChecklistSnapshotPayload(local))).toEqual([]);
  });

  it("C14c (released): a text in the window is sent; the one outside the dates and the hidden one are listed", async () => {
    mockTextLinksHeld = false;
    const g = await gather();
    expect(gapSummary(g.checklistLinkGaps)).toEqual([
      { linkId: "L-hid", kind: "text", reason: "not_included", detail: "not_sent", missingIds: ["t-hid"] },
      { linkId: "L-off", kind: "text", reason: "not_included", detail: "not_on_transaction", missingIds: ["t-off"] },
      { linkId: "L-re", kind: "text", reason: "not_included", detail: "not_sent", missingIds: ["t-re"] },
      { linkId: "L-texts", kind: "text", reason: "not_included", detail: "not_sent", missingIds: ["o-before"] },
    ]);
    const local = await getChecklistsForTransaction(TXN, "broker");
    const payload = buildChecklistSnapshotPayload(local, sentSets(g));
    expect(payloadLinks(payload)).toEqual([
      { kind: "text", label: "Texts with seller", sort_order: 0, local_ids: ["t-in"] },
    ]);
  });

  it("R3: 'Include it' is refused on a text link (the flag stays 0); an email link on the same item takes it", async () => {
    expect(await setChecklistLinkIncludeOutsideDates(TXN, "L-texts")).toBe(false);
    expect(
      db.prepare("SELECT include_outside_dates AS f FROM transaction_checklist_links WHERE id = 'L-texts'").get(),
    ).toEqual({ f: 0 });
    // Positive control: the same call, same item and deal, on an email link.
    const itemId = (db.prepare("SELECT item_id FROM transaction_checklist_links WHERE id = 'L-texts'").get() as { item_id: string }).item_id;
    db.prepare("INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order) VALUES ('L-mail', ?, 'email', 'Offer', 9)").run(itemId);
    expect(await setChecklistLinkIncludeOutsideDates(TXN, "L-mail")).toBe(true);
  });
});

describe("BACKLOG-3968 — the export reader's text rows (C17 reader half)", () => {
  it("names each text member's row; hidden by message id AND by the guid of a re-imported copy", async () => {
    const { checklists } = await getChecklistsForTransaction(TXN, "broker");
    const { textTargets } = await getChecklistExportTargets(TXN, checklists);
    const summary = Object.fromEntries(
      Object.entries(textTargets).map(([id, t]) => [id, { externalId: t.externalId, sentAt: t.sentAt, hidden: t.hidden }]),
    );
    expect(summary).toEqual({
      "t-in": { externalId: "guid-t-in", sentAt: at("12:00"), hidden: false },
      "o-before": { externalId: "guid-o-before", sentAt: at("12:00", "2026-09-10"), hidden: false },
      "t-hid": { externalId: "guid-t-hid", sentAt: at("12:05"), hidden: true },
      "t-off": { externalId: "guid-t-off", sentAt: at("12:10"), hidden: false },
      "t-re": { externalId: "guid-reimported", sentAt: at("12:15"), hidden: true },
    });
  });
});
