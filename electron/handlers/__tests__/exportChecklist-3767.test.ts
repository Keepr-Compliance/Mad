/**
 * @jest-environment node
 *
 * BACKLOG-3767 — the enhanced export handler's checklist read.
 *
 * Drives the REAL `transactions:export-enhanced` handler over a real-sqlite
 * database with the REAL checklist reader. Only the renderer
 * (enhancedExportService), the sync backstops and the paywall gate are mocked;
 * the renderer mock is the observation seam (what the PDF would be built from).
 *
 * Pins:
 *   - only `includeChecklist === true` with a PDF format reads the checklists
 *     (absent, the string "true", and a non-PDF format all read nothing);
 *   - the read happens AFTER the sync backstops (an email linked by the sync
 *     reads as part of the transaction);
 *   - each attachment member's `hidden` comes from the transaction's whole hide
 *     list, on the message id and on the Apple guid of another copy.
 *
 * Fixture values are invented and documentation-only.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: { getTransactionDetails: jest.fn() },
}));
jest.mock("../../services/enhancedExportService", () => ({
  __esModule: true,
  default: { exportTransaction: jest.fn().mockResolvedValue("/tmp/export-3767.pdf") },
}));
jest.mock("../../services/folderExportService", () => ({
  __esModule: true,
  default: {
    exportTransactionToFolder: jest.fn().mockResolvedValue("/tmp/export-3767-folder"),
    exportTransactionToCombinedPDF: jest.fn().mockResolvedValue("/tmp/export-3767.pdf"),
    getDefaultExportPath: jest.fn(() => "/tmp/export-3767"),
  },
}));
jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
    recordInTransaction: jest.fn(),
    recordFailure: jest.fn(),
  },
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
}));
jest.mock("../../services/submissionService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/submissionSyncService", () => ({
  __esModule: true,
  default: { stopAllSync: jest.fn() },
}));
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/transactionSyncTrigger", () => ({
  ensureTransactionEmailsSynced: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/messagesSyncTrigger", () => ({
  ensureTransactionMessagesSynced: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/exportGate", () => ({
  enforceExportGate: jest.fn(),
  emitExportCompleted: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../../services/db/core/dbConnection";
import {
  createCommunication,
  createThreadCommunicationReference,
  getCommunicationsWithMessages,
} from "../../services/db/communicationDbService";
import { hideTextFromExport } from "../../services/db/hiddenTextDbService";
import transactionService from "../../services/transactionService";
import enhancedExportService from "../../services/enhancedExportService";
import { enforceExportGate } from "../../services/exportGate";
import { ensureTransactionEmailsSynced } from "../../services/transactionSyncTrigger";
import { registerTransactionExportHandlers } from "../transactionExportHandlers";
import type { ChecklistExportInput } from "../../services/enhancedExportService";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

const OWNER = "user-3767-owner";
const OTHER = "user-3767-other";
// pii-allow-uuid: invented, not from any live row — repeating-digit v4 pattern
const TXN = "37673767-3767-4767-8767-376737673767";
const DAY = "2026-09-24";
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00Z`;

let db: DatabaseType;

function insertMessage(user: string, id: string, guid: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants,
                           thread_id, sent_at, has_attachments)
     VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?, 'chat-1', ?, 1)`,
  ).run(id, user, guid, `Body ${id}`, JSON.stringify({ from: "+15550101", to: ["me"] }), sentAt);
}

function insertAttachment(id: string, messageId: string, guid: string | null, filename: string): void {
  db.prepare(
    `INSERT INTO attachments (id, message_id, external_message_id, filename) VALUES (?, ?, ?, ?)`,
  ).run(id, messageId, guid, filename);
}

function insertEmail(id: string, subject: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, direction, subject, body_plain, sender, recipients, thread_id, sent_at)
     VALUES (?, ?, ?, 'gmail', 'inbound', ?, 'Email body', 'a@example.test', 'b@example.test', ?, ?)`,
  ).run(id, OWNER, `ext-${id}`, subject, `mt-${id}`, at("11:00"));
}

let memberSeq = 0;
function link(itemId: string, kind: "email" | "attachment", label: string, targets: string[]): void {
  const linkId = `link-${++memberSeq}`;
  db.prepare(
    `INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order) VALUES (?, ?, ?, ?, ?)`,
  ).run(linkId, itemId, kind, label, memberSeq);
  for (const t of targets) {
    db.prepare(
      `INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id, email_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(`m-${++memberSeq}`, linkId, kind, kind === "attachment" ? t : null, kind === "email" ? t : null);
  }
}

async function seed(): Promise<void> {
  db.exec(
    `DELETE FROM transaction_checklist_link_members; DELETE FROM transaction_checklist_links;
     DELETE FROM transaction_checklist_items; DELETE FROM transaction_checklists;
     DELETE FROM attachments; DELETE FROM transaction_hidden_texts; DELETE FROM communications;
     DELETE FROM messages; DELETE FROM emails; DELETE FROM transactions; DELETE FROM users_local;`,
  );
  for (const u of [OWNER, OTHER]) {
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
    ).run(u, `${u}@example.test`, `oauth-${u}`);
  }
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(TXN, OWNER, "1 Fixture Way", DAY, DAY);

  // Texts: ok (in window), hp (hidden, BEFORE the window), hx (hidden; its
  // attachment row belongs to the other user's copy u2-hx, same guid).
  insertMessage(OWNER, "ok", "guid-ok", at("12:00"));
  insertMessage(OWNER, "hp", "guid-hp", at("12:00", "2026-09-20"));
  insertMessage(OWNER, "hx", "guid-hx", at("12:05"));
  insertMessage(OTHER, "u2-hx", "guid-hx", at("12:05"));
  insertAttachment("att-ok", "ok", "guid-ok", "ok-photo.jpg");
  insertAttachment("att-hp", "hp", "guid-hp", "hp-photo.jpg");
  insertAttachment("att-hx", "u2-hx", "guid-hx", "hx-photo.jpg");
  // hn: a hide row with no provider id (written before external ids were
  // stored); only the message-id arm reaches it.
  insertMessage(OWNER, "hn", "guid-hn", at("12:10"));
  insertAttachment("att-hn", "hn", null, "hn-photo.jpg");
  await createThreadCommunicationReference("chat-1", TXN, OWNER, "manual");
  for (const id of ["hp", "hx"]) {
    expect(await hideTextFromExport({ transactionId: TXN, messageId: id, userId: OWNER })).toBe(true);
  }
  db.prepare(
    `INSERT INTO transaction_hidden_texts (transaction_id, message_id, message_external_id, hidden_by)
     VALUES (?, 'hn', NULL, ?)`,
  ).run(TXN, OWNER);

  // Emails: em-1 linked now; em-late is linked by the email sync backstop.
  insertEmail("em-1", "Offer accepted");
  insertEmail("em-late", "Inspection report");
  await createCommunication({
    user_id: OWNER,
    transaction_id: TXN,
    email_id: "em-1",
    thread_id: "mt-em-1",
    link_source: "manual",
  } as Parameters<typeof createCommunication>[0]);

  db.prepare(
    `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('cl-1', ?, 'tpl-1', 'Purchase file')`,
  ).run(TXN);
  db.prepare(
    `INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required, sort_order) VALUES ('it-1', 'cl-1', 'Offer', 1, 0)`,
  ).run();
  link("it-1", "email", "Offer accepted", ["em-1"]);
  link("it-1", "email", "Inspection report", ["em-late"]);
  link("it-1", "attachment", "ok-photo.jpg", ["att-ok"]);
  link("it-1", "attachment", "hp-photo.jpg", ["att-hp"]);
  link("it-1", "attachment", "hx-photo.jpg", ["att-hx"]);
  link("it-1", "attachment", "hn-photo.jpg", ["att-hn"]);
}

async function invoke(options?: unknown): Promise<{ success: boolean; error?: string }> {
  const handler = handlers.get("transactions:export-enhanced");
  if (!handler) throw new Error("handler not registered");
  return (await handler({} as never, TXN, options)) as { success: boolean; error?: string };
}

function capturedChecklist(): ChecklistExportInput | undefined {
  const calls = (enhancedExportService.exportTransaction as jest.Mock).mock.calls;
  expect(calls).toHaveLength(1);
  return (calls[0][2] as { checklist?: ChecklistExportInput }).checklist;
}

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  setDb(db);
  registerTransactionExportHandlers(null);
});

afterAll(() => {
  db.close();
});

beforeEach(async () => {
  jest.clearAllMocks();
  memberSeq = 0;
  (transactionService.getTransactionDetails as jest.Mock).mockImplementation(async (id: string) => {
    const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!tx) return null;
    return { ...tx, communications: await getCommunicationsWithMessages(id), contact_assignments: [] };
  });
  (enforceExportGate as jest.Mock).mockImplementation(async (input: { communications: unknown[] }) => ({
    communications: input.communications ?? [],
    decision: { mode: "full" },
  }));
  // The email backstop links em-late. Only a read AFTER it sees em-late as
  // part of the transaction.
  (ensureTransactionEmailsSynced as jest.Mock).mockImplementation(async () => {
    await createCommunication({
      user_id: OWNER,
      transaction_id: TXN,
      email_id: "em-late",
      thread_id: "mt-em-late",
      link_source: "manual",
    } as Parameters<typeof createCommunication>[0]);
  });
  await seed();
});

describe("BACKLOG-3767 export-enhanced: checklist read", () => {
  it.each([
    ["absent", { exportFormat: "pdf" }],
    ["false", { exportFormat: "pdf", includeChecklist: false }],
    ["the string \"true\"", { exportFormat: "pdf", includeChecklist: "true" }],
    ["true with a non-PDF format", { exportFormat: "excel", includeChecklist: true }],
  ])("reads no checklist when includeChecklist is %s", async (_label, options) => {
    expect(await invoke(options)).toMatchObject({ success: true });
    expect(capturedChecklist()).toBeUndefined();
  });

  it("reads the local checklist when includeChecklist is true", async () => {
    expect(await invoke({ exportFormat: "pdf", includeChecklist: true })).toMatchObject({ success: true });
    const checklist = capturedChecklist();
    expect(checklist).toBeDefined();
    expect(checklist!.checklists.map((c) => c.checklist.templateName)).toEqual(["Purchase file"]);
    expect(checklist!.emailSubjects).toEqual({ "em-1": "Offer accepted", "em-late": "Inspection report" });
  });

  it("reads after the sync backstops: an email the sync linked is part of the transaction", async () => {
    await invoke({ exportFormat: "pdf", includeChecklist: true });
    const links = capturedChecklist()!.checklists[0].linksByItemId["it-1"];
    const late = links.find((l) => l.label === "Inspection report")!;
    expect(late.members.map((m) => m.inTransaction)).toEqual([true]);
  });

  it("marks attachments on hidden texts from the whole hide list, on both arms", async () => {
    await invoke({ exportFormat: "pdf", includeChecklist: true });
    const targets = capturedChecklist()!.attachmentTargets;
    expect(
      Object.fromEntries(Object.entries(targets).map(([id, t]) => [id, t.hidden])),
    ).toEqual({ "att-ok": false, "att-hp": true, "att-hx": true, "att-hn": true });
    expect(targets["att-hx"]).toMatchObject({
      messageId: "u2-hx",
      externalMessageId: "guid-hx",
      messageExternalId: "guid-hx",
      emailId: null,
      filename: "hx-photo.jpg",
    });
  });
});
