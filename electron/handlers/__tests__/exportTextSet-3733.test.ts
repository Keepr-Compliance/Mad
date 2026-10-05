/**
 * @jest-environment node
 *
 * BACKLOG-3733 — FIXED EXPECTED ID LISTS FOR EVERY EXPORT PATH.
 *
 * The three export channels (`transactions:export-pdf`, `-enhanced`, `-folder`)
 * each run the same data prep: re-fetch the deal after the sync backstops, run
 * the paywall gate, then `resolveExportPlan`. This suite pins WHICH texts each
 * channel hands to its renderer, as literal id lists, over a real-sqlite corpus
 * that reaches every filtering branch.
 *
 * Why fixed lists and not a parity test: a parity test between two callers of
 * one shared reader moves with the reader, so it stays green under every reader
 * regression (plan, pm_comments on BACKLOG-3733, §7). A literal list does not.
 *
 * The suite drives the REAL IPC handlers with the REAL reader
 * (`getCommunicationsWithMessages`) and the REAL resolver. Only the renderers
 * (the export services), the sync backstops and the paywall decision are mocked
 * — and the mocks are the observation seams:
 *   - the export service mocks record the plan / communications each channel
 *     received (what would have been written into the artifact);
 *   - the gate mock records the ids it received, so a gate that runs AFTER the
 *     resolver (which would hand it a filtered list) goes red;
 *   - the messages-sync mock inserts one more text, so a prep that forgets the
 *     post-sync re-fetch goes red.
 *
 * Corpus branches (deal window 2026-09-24 .. 2026-09-24):
 *   t-normal        thread-linked text                       in
 *   r-of-normal     reaction to a kept text                  in
 *   p-a, p-b        caption-less photos, same second         in (both — empty body exempt from dedup)
 *   d-a / d-b       unhidden content duplicates              d-a only
 *   t-hidden        hidden text                              out
 *   r-of-hidden     reaction to a hidden text                out
 *   hd-hidden/-unh  duplicate pair, one hidden               neither
 *   hp / r-of-hp    hidden text BEFORE the window / its      out / out
 *                   in-window reaction
 *   o-before        thread text before the window            out (in for the windowless pdf channel)
 *   pm-sel          per-message link in another chat         in
 *   pm-unsel        unlinked text in that chat               out
 *   g-in            text in a linked GROUP thread            in
 *   g-unsel         text in an unlinked group thread         out
 *   x-collide       text reached only through an EMAIL comm  out
 *                   row's thread_id
 *   ch-email        messages.channel='email' row, per-message as an email row in "both", out of "texts"
 *   em-1            linked email                             in "both" only
 *   t-late          inserted by the sync backstop            in (proves the re-fetch)
 *
 * MULTI-USER: a second signed-in user's copies of the linked threads (same
 * provider guids, bodies and times, distinct ids, inserted FIRST) must never
 * reach the export. The expected lists are the SAME lists — a missing owner
 * scope shows up as foreign ids or doubled empty-body rows.
 *
 * Run under Electron's node (the shared native module is Electron-ABI at rest):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/handlers/__tests__/exportTextSet-3733.test.ts --bail=0
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

// getTransactionDetails is a pass-through to the REAL transaction row and the
// REAL reader, forwarding all three arguments (a mock that dropped the channel
// filter or the limit would hide a regression in either).
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: { getTransactionDetails: jest.fn() },
}));
jest.mock("../../services/enhancedExportService", () => ({
  __esModule: true,
  default: { exportTransaction: jest.fn().mockResolvedValue("/tmp/export-3733.xlsx") },
}));
jest.mock("../../services/folderExportService", () => ({
  __esModule: true,
  default: {
    exportTransactionToFolder: jest.fn().mockResolvedValue("/tmp/export-3733-folder"),
    exportTransactionToCombinedPDF: jest.fn().mockResolvedValue("/tmp/export-3733.pdf"),
    getDefaultExportPath: jest.fn(() => "/tmp/export-3733"),
  },
}));
jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn().mockResolvedValue(undefined) },
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

// The driver is moduleNameMapper'd to a mock for the rest of the suite, so the
// real one has to be reached by absolute path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../../services/db/core/dbConnection";
import {
  createCommunication,
  createCommunicationReference,
  createThreadCommunicationReference,
  getCommunicationsWithMessages,
} from "../../services/db/communicationDbService";
import { hideTextFromExport } from "../../services/db/hiddenTextDbService";
import transactionService from "../../services/transactionService";
import enhancedExportService from "../../services/enhancedExportService";
import folderExportService from "../../services/folderExportService";
import { enforceExportGate } from "../../services/exportGate";
import { ensureTransactionMessagesSynced } from "../../services/messagesSyncTrigger";
import { registerTransactionExportHandlers } from "../transactionExportHandlers";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

const OWNER = "user-3733-owner";
const OTHER = "user-3733-other";
// The handlers validate the id as a UUID.
// pii-allow-uuid: invented, not from any live row — repeating-digit v4 pattern
const TXN = "37333333-3733-4733-8733-373333333333";
const DAY = "2026-09-24";

let db: DatabaseType;

interface TextRow {
  id: string;
  thread: string;
  at: string;
  body?: string;
  channel?: "imessage" | "sms" | "email";
  reactionTo?: string; // parent external_id
  attachments?: boolean;
  group?: boolean;
}

function insertMessage(user: string, idPrefix: string, r: TextRow): void {
  const participants = r.group
    ? { from: "+15550101", to: ["me", "+15550102", "+15550103"] }
    : { from: "+15550101", to: ["me"] };
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants,
                           thread_id, sent_at, has_attachments, associated_message_type, associated_message_guid)
     VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${idPrefix}${r.id}`,
    user,
    r.channel ?? "imessage",
    `guid-${r.id}`,
    r.body ?? "",
    JSON.stringify(participants),
    r.thread,
    r.at,
    r.attachments ? 1 : 0,
    r.reactionTo ? 2000 : null,
    r.reactionTo ?? null,
  );
}

const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00Z`;

/** Every text in the corpus. Thread links decide which of them the deal sees. */
const TEXTS: TextRow[] = [
  { id: "t-normal", thread: "chat-sel", at: at("12:00"), body: "Normal text" },
  { id: "r-of-normal", thread: "chat-sel", at: at("12:01"), reactionTo: "guid-t-normal" },
  { id: "t-hidden", thread: "chat-sel", at: at("12:02"), body: "Hidden text", attachments: true },
  { id: "r-of-hidden", thread: "chat-sel", at: at("12:03"), reactionTo: "guid-t-hidden" },
  { id: "p-a", thread: "chat-sel", at: at("12:04"), attachments: true },
  { id: "p-b", thread: "chat-sel", at: at("12:04"), attachments: true },
  { id: "d-a", thread: "chat-sel", at: at("12:05"), body: "Duplicate body" },
  { id: "d-b", thread: "chat-sel", at: at("12:05"), body: "Duplicate body", attachments: true },
  // The UNHIDDEN copy goes in first, so plain first-wins would keep it; only
  // the hidden-copy-wins rule drops it.
  { id: "hd-unhidden", thread: "chat-sel", at: at("12:06"), body: "Hidden duplicate" },
  { id: "hd-hidden", thread: "chat-sel", at: at("12:06"), body: "Hidden duplicate" },
  { id: "hp", thread: "chat-sel", at: at("12:00", "2026-09-20"), body: "Hidden before window" },
  { id: "r-of-hp", thread: "chat-sel", at: at("12:07"), reactionTo: "guid-hp" },
  { id: "o-before", thread: "chat-sel", at: at("12:00", "2026-09-10"), body: "Before the window" },
  { id: "pm-sel", thread: "chat-other", at: at("13:00"), body: "Selected single message" },
  { id: "pm-unsel", thread: "chat-other", at: at("13:01"), body: "Unselected single message" },
  { id: "g-in", thread: "chat-group", at: at("14:00"), body: "Group text", group: true },
  { id: "g-unsel", thread: "chat-group-unsel", at: at("14:01"), body: "Unselected group", group: true },
  { id: "x-collide", thread: "chat-x", at: at("15:00"), body: "Reached via an email row" },
  { id: "ch-email", thread: "chat-mail", at: at("15:30"), body: "Email-channel message row", channel: "email" },
];

const LATE: TextRow = { id: "t-late", thread: "chat-sel", at: at("16:00"), body: "Arrived during the sync" };

async function seed(opts: { foreignUser: boolean }): Promise<void> {
  db.exec(
    "DELETE FROM transaction_hidden_texts; DELETE FROM communications; DELETE FROM messages; DELETE FROM emails; DELETE FROM transactions; DELETE FROM users_local;",
  );
  for (const u of [OWNER, OTHER]) {
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
    ).run(u, `${u}@example.test`, `oauth-${u}`);
  }
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, started_at, closed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(TXN, OWNER, "1 Fixture Way", DAY, DAY);

  // The other user's copies go in FIRST so that, without an owner scope, they
  // are the rows a first-wins dedup keeps.
  if (opts.foreignUser) {
    for (const r of TEXTS) insertMessage(OTHER, "u2-", r);
  }
  for (const r of TEXTS) insertMessage(OWNER, "", r);

  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, direction, subject, body_plain, sender, recipients, thread_id, sent_at)
     VALUES ('em-1', ?, 'ext-em-1', 'gmail', 'inbound', 'Offer', 'Email body', 'a@example.test', 'b@example.test', 'mail-thread-1', ?)`,
  ).run(OWNER, at("11:00"));

  await createThreadCommunicationReference("chat-sel", TXN, OWNER, "manual");
  await createThreadCommunicationReference("chat-group", TXN, OWNER, "manual");
  await createCommunicationReference({ user_id: OWNER, message_id: "pm-sel", transaction_id: TXN, link_source: "manual" });
  await createCommunicationReference({ user_id: OWNER, message_id: "ch-email", transaction_id: TXN, link_source: "manual" });
  // An EMAIL link whose row also carries the text thread id "chat-x".
  await createCommunication({
    user_id: OWNER,
    transaction_id: TXN,
    email_id: "em-1",
    thread_id: "chat-x",
    link_source: "manual",
  } as Parameters<typeof createCommunication>[0]);

  for (const id of ["t-hidden", "hd-hidden", "hp"]) {
    expect(await hideTextFromExport({ transactionId: TXN, messageId: id, userId: OWNER })).toBe(true);
  }
}

const sortedIds = (rows: Array<{ id?: unknown }>): string[] => rows.map((r) => String(r.id)).sort();

/** Window texts every windowed channel keeps. */
const WINDOW_TEXTS = ["d-a", "g-in", "p-a", "p-b", "pm-sel", "r-of-normal", "t-late", "t-normal"];

/** FIXED expected lists, per channel. */
const EXPECTED = {
  // No window, contentType both: adds o-before, the email, and the email-channel row.
  pdf: {
    ids: [...WINDOW_TEXTS, "ch-email", "em-1", "o-before"].sort(),
    hidden: ["hd-hidden", "hp", "t-hidden"],
  },
  // Window from the deal's dates, contentType both.
  enhanced: {
    ids: [...WINDOW_TEXTS, "ch-email", "em-1"].sort(),
    hidden: ["hd-hidden", "t-hidden"],
  },
  // Window from the deal's dates, contentType texts.
  folder: {
    ids: [...WINDOW_TEXTS].sort(),
    hidden: ["hd-hidden", "t-hidden"],
  },
};

/** The rows the reader returns after the sync — what the gate must receive. */
let gateInputs: string[][];

async function invoke(channel: string, options?: unknown): Promise<{ success: boolean; error?: string }> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return (await handler({} as never, TXN, options)) as { success: boolean; error?: string };
}

interface Captured {
  ids: string[];
  hidden: string[];
  hiddenCount: number;
}

async function runChannel(label: "pdf" | "enhanced" | "folder"): Promise<Captured> {
  if (label === "pdf") {
    const res = await invoke("transactions:export-pdf");
    expect(res).toMatchObject({ success: true });
    const call = (folderExportService.exportTransactionToCombinedPDF as jest.Mock).mock.calls[0];
    const comms = call[1] as Array<{ id: string }>;
    const opts = call[3] as { hiddenTextCount: number; hiddenTexts: Array<{ id: string }> };
    return { ids: sortedIds(comms), hidden: sortedIds(opts.hiddenTexts), hiddenCount: opts.hiddenTextCount };
  }
  if (label === "enhanced") {
    const res = await invoke("transactions:export-enhanced", {
      exportFormat: "excel",
      contentType: "both",
      attachmentType: "none",
    });
    expect(res).toMatchObject({ success: true });
    const plan = (enhancedExportService.exportTransaction as jest.Mock).mock.calls[0][1] as {
      communications: Array<{ id: string }>;
      hiddenTexts: Array<{ id: string }>;
      hiddenTextCount: number;
    };
    return { ids: sortedIds(plan.communications), hidden: sortedIds(plan.hiddenTexts), hiddenCount: plan.hiddenTextCount };
  }
  const res = await invoke("transactions:export-folder", { contentType: "texts", attachmentType: "all" });
  expect(res).toMatchObject({ success: true });
  const plan = (folderExportService.exportTransactionToFolder as jest.Mock).mock.calls[0][1] as {
    communications: Array<{ id: string }>;
    hiddenTexts: Array<{ id: string }>;
    hiddenTextCount: number;
  };
  return { ids: sortedIds(plan.communications), hidden: sortedIds(plan.hiddenTexts), hiddenCount: plan.hiddenTextCount };
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

beforeEach(() => {
  jest.clearAllMocks();
  gateInputs = [];

  (transactionService.getTransactionDetails as jest.Mock).mockImplementation(
    async (id: string, channelFilter?: "email" | "text", limit?: number) => {
      const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!tx) return null;
      const communications = await getCommunicationsWithMessages(id, channelFilter, limit);
      return { ...tx, communications, contact_assignments: [] };
    },
  );

  // Option A passthrough that records what it was handed.
  (enforceExportGate as jest.Mock).mockImplementation(
    async (input: { communications: Array<{ id: string }> }) => {
      gateInputs.push(sortedIds(input.communications ?? []));
      return { communications: input.communications ?? [], decision: { mode: "full" } };
    },
  );

  // The texts backstop imports one more message into a linked thread. Only a
  // prep that re-reads AFTER the sync can see it.
  (ensureTransactionMessagesSynced as jest.Mock).mockImplementation(async () => {
    insertMessage(OWNER, "", LATE);
  });
});

for (const foreignUser of [false, true]) {
  const corpus = foreignUser ? "two users share the threads" : "single user";

  describe(`BACKLOG-3733 export text sets — ${corpus}`, () => {
    beforeEach(async () => {
      await seed({ foreignUser });
    });

    for (const label of ["pdf", "enhanced", "folder"] as const) {
      it(`${label}: the renderer receives exactly the fixed id list`, async () => {
        const got = await runChannel(label);
        expect(got.ids).toEqual(EXPECTED[label].ids);
        expect(got.hidden).toEqual(EXPECTED[label].hidden);
        expect(got.hiddenCount).toBe(EXPECTED[label].hidden.length);
      });

      it(`${label}: the gate runs once, on the post-sync read, before any filtering`, async () => {
        await runChannel(label);
        expect(gateInputs).toHaveLength(1);
        const fullRead = sortedIds(await getCommunicationsWithMessages(TXN));
        expect(gateInputs[0]).toEqual(fullRead);
        // The gate saw the unfiltered set: hidden rows and the late row included.
        expect(gateInputs[0]).toEqual(expect.arrayContaining(["t-hidden", "t-late"]));
      });

      it(`${label}: a locked deal fails and the renderer is never called`, async () => {
        (enforceExportGate as jest.Mock).mockImplementation(async () => {
          throw new Error("PAYWALL_LOCKED");
        });
        const options =
          label === "pdf"
            ? undefined
            : label === "enhanced"
              ? { exportFormat: "excel", contentType: "both", attachmentType: "none" }
              : { contentType: "texts", attachmentType: "all" };
        const res = await invoke(`transactions:export-${label}`, options);
        expect(res.success).toBe(false);
        expect(folderExportService.exportTransactionToCombinedPDF).not.toHaveBeenCalled();
        expect(folderExportService.exportTransactionToFolder).not.toHaveBeenCalled();
        expect(enhancedExportService.exportTransaction).not.toHaveBeenCalled();
      });
    }
  });
}
