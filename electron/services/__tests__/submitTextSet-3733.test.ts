/**
 * @jest-environment node
 *
 * BACKLOG-3733 PR-2 — FIXED EXPECTED ID LISTS FOR THE SUBMIT.
 *
 * The submit, its pre-flight and the date-step summary send exactly the texts
 * the export of the deal includes, cropped to the audit window: the owner's
 * copies, hidden texts and reactions to hidden texts removed, duplicates
 * collapsed. Text attachments follow that set.
 *
 * Why literal lists and not a parity test against the export: both now read
 * through `prepareTransactionCommunications`, so a parity test moves with the
 * shared reader and stays green under every reader regression (plan §7,
 * pm_comments on BACKLOG-3733). A literal list does not.
 *
 * Real `schema.sql`, real `submissionDbService`, real export reader and
 * resolver, real `transactionService.getTransactionDetails`, real pre-flight.
 * Mocked: the database singleton (delegates to the real statement modules),
 * the cloud, the email download, and name resolution.
 *
 * Corpus (deal window 2026-09-24 .. 2026-09-24):
 *   t-normal        thread-linked text                       sent
 *   r-of-normal     reaction to a kept text                  sent
 *   lp-1            link preview: flagged, no attachment row  sent, one pre-flight line
 *   p-a, p-b        caption-less photos, same second, files  sent (both), attachments sent
 *   d-a / d-b       unhidden content duplicates              d-a only (d-b's file not sent)
 *   t-hidden        hidden text with a file                  not sent, file not sent
 *   r-of-hidden     reaction to a hidden text, flagged       not sent, no pre-flight line
 *   hd-hidden/-unh  duplicate pair, one hidden               neither
 *   hp / r-of-hp    hidden text BEFORE the window / its      not sent / not sent
 *                   in-window reaction
 *   o-before        thread text before the window            not sent (window)
 *   pm-sel          per-message link in another chat         sent
 *   pm-unsel        unlinked text in that chat               not sent
 *   g-in            text in a linked GROUP thread            sent
 *   g-unsel         text in an unlinked group thread         not sent
 *   x-collide       text reached only through an EMAIL comm  not sent
 *                   row's thread_id
 *   ch-email        messages.channel='email' row, per-message not sent (not a text)
 *
 * MULTI-USER: a second signed-in user's copies of every text (same provider
 * guids, bodies and times, distinct ids, with their own photo files), inserted
 * FIRST. The expected lists are the SAME lists.
 *
 * Run under Electron's node (the shared native module is Electron-ABI at rest):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/submitTextSet-3733.test.ts --bail=0
 *
 * Fixture values are invented and documentation-only.
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// The driver is moduleNameMapper'd to a mock for the rest of the suite, so the
// real one has to be reached by absolute path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let db: DatabaseType;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => db,
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  setDb: jest.fn(),
}));

/**
 * The real `databaseService` opens an encrypted file. Its readers used here are
 * pure delegations, so this mock delegates to the SAME real modules.
 */
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
    getAuthSession: jest.fn().mockResolvedValue({ userId: "user-3733-owner" }),
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
  app: { getVersion: jest.fn().mockReturnValue("2.39.0"), getPath: jest.fn(() => "/tmp") },
  net: { isOnline: jest.fn().mockReturnValue(true) },
}));

import {
  createCommunication,
  createCommunicationReference,
  createThreadCommunicationReference,
} from "../db/communicationDbService";
import { hideTextFromExport } from "../db/hiddenTextDbService";
import { submissionService } from "../submissionService";
import databaseService from "../databaseService";
import { setPreflightStatForTests } from "../submissionPreflight";
import { selectSubmissionTextIds } from "../transactionCommunicationSet";
import { auditPeriodFromRow } from "../submissionAuditPeriod";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

const OWNER = "user-3733-owner";
const OTHER = "user-3733-other";
const TXN = "txn-3733-submit";
const DAY = "2026-09-24";

interface TextRow {
  id: string;
  thread: string;
  at: string;
  body?: string;
  channel?: "imessage" | "sms" | "email";
  reactionTo?: string; // parent external_id
  flagged?: boolean; // has_attachments = 1
  file?: boolean; // an attachment row with bytes on disk
  group?: boolean;
}

const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00Z`;

const TEXTS: TextRow[] = [
  { id: "t-normal", thread: "chat-sel", at: at("12:00"), body: "Normal text" },
  { id: "r-of-normal", thread: "chat-sel", at: at("12:01"), reactionTo: "guid-t-normal" },
  { id: "t-hidden", thread: "chat-sel", at: at("12:02"), body: "Hidden text", flagged: true, file: true },
  { id: "r-of-hidden", thread: "chat-sel", at: at("12:03"), reactionTo: "guid-t-hidden", flagged: true },
  { id: "p-a", thread: "chat-sel", at: at("12:04"), flagged: true, file: true },
  { id: "p-b", thread: "chat-sel", at: at("12:04"), flagged: true, file: true },
  { id: "d-a", thread: "chat-sel", at: at("12:05"), body: "Duplicate body" },
  { id: "d-b", thread: "chat-sel", at: at("12:05"), body: "Duplicate body", flagged: true, file: true },
  // The UNHIDDEN copy goes in first, so plain first-wins would keep it; only
  // the hidden-copy-wins rule drops it.
  { id: "hd-unhidden", thread: "chat-sel", at: at("12:06"), body: "Hidden duplicate" },
  { id: "hd-hidden", thread: "chat-sel", at: at("12:06"), body: "Hidden duplicate" },
  { id: "hp", thread: "chat-sel", at: at("12:00", "2026-09-20"), body: "Hidden before window" },
  { id: "r-of-hp", thread: "chat-sel", at: at("12:07"), reactionTo: "guid-hp" },
  { id: "lp-1", thread: "chat-sel", at: at("12:08"), body: "https://example.test/listing", flagged: true },
  { id: "o-before", thread: "chat-sel", at: at("12:00", "2026-09-10"), body: "Before the window" },
  { id: "pm-sel", thread: "chat-other", at: at("13:00"), body: "Selected single message" },
  { id: "pm-unsel", thread: "chat-other", at: at("13:01"), body: "Unselected single message" },
  { id: "g-in", thread: "chat-group", at: at("14:00"), body: "Group text", group: true },
  { id: "g-unsel", thread: "chat-group-unsel", at: at("14:01"), body: "Unselected group", group: true },
  { id: "x-collide", thread: "chat-x", at: at("15:00"), body: "Reached via an email row" },
  { id: "ch-email", thread: "chat-mail", at: at("15:30"), body: "Email-channel message row", channel: "email" },
];

function insertMessage(user: string, idPrefix: string, r: TextRow): void {
  const participants = r.group
    ? { from: "+15550101", to: ["me", "+15550102", "+15550103"] }
    : { from: "+15550101", to: ["me"] };
  const id = `${idPrefix}${r.id}`;
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants,
                           thread_id, sent_at, has_attachments, associated_message_type, associated_message_guid)
     VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    user,
    r.channel ?? "imessage",
    `guid-${r.id}`,
    r.body ?? "",
    JSON.stringify(participants),
    r.thread,
    r.at,
    r.flagged ? 1 : 0,
    r.reactionTo ? 2000 : null,
    r.reactionTo ?? null,
  );
  if (r.file) {
    db.prepare(
      `INSERT INTO attachments (id, message_id, external_message_id, filename, mime_type, storage_path, created_at)
       VALUES (?, ?, ?, 'photo.jpg', 'image/jpeg', ?, ?)`,
    ).run(`att-${id}`, id, `guid-${r.id}`, `/local/bytes/att-${id}`, r.at);
  }
}

async function seed(opts: { foreignUser: boolean }): Promise<void> {
  db.exec(
    "DELETE FROM transaction_hidden_texts; DELETE FROM communications; DELETE FROM attachments; DELETE FROM messages; DELETE FROM emails; DELETE FROM transactions; DELETE FROM users_local;",
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

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/** FIXED: the texts the submit sends. */
const EXPECTED_TEXTS = ["d-a", "g-in", "lp-1", "p-a", "p-b", "pm-sel", "r-of-normal", "t-normal"];
/** FIXED: the attachment files the submit sends. */
const EXPECTED_ATTACHMENTS = ["att-p-a", "att-p-b"];
/** FIXED: the pre-flight lines — the link preview only. */
const EXPECTED_NOT_INCLUDED = ["msg:lp-1"];

type Gathered = {
  messages: Array<{ id: string }>;
  preflight: { sendable: Array<{ id: string }>; notIncluded: Array<{ key: string }> };
};
const gather = (): Promise<Gathered> =>
  (submissionService as unknown as { gatherForSubmission(id: string): Promise<Gathered> })
    .gatherForSubmission(TXN);

beforeAll(() => {
  db = new RealDatabase(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  setPreflightStatForTests(async () => ({ size: 1024 }));
});

afterAll(() => {
  db.close();
});

for (const foreignUser of [false, true]) {
  const corpus = foreignUser ? "two users hold copies of the same threads" : "single user";

  describe(`BACKLOG-3733 submit text set — ${corpus}`, () => {
    beforeEach(async () => {
      jest.clearAllMocks();
      await seed({ foreignUser });
    });

    it("C2: the submit gathers exactly the fixed text list", async () => {
      const got = await gather();
      expect(sorted(got.messages.map((m) => m.id))).toEqual(EXPECTED_TEXTS);
    });

    it("C3: attachments follow the text set — only the kept photos' files are sent", async () => {
      const got = await gather();
      expect(sorted(got.preflight.sendable.map((a) => a.id))).toEqual(EXPECTED_ATTACHMENTS);

      const { auditStartDate, auditEndDate } = auditPeriodFromRow({ started_at: DAY, closed_at: DAY });
      const selected = await selectSubmissionTextIds(TXN);
      const rows = databaseService.getTransactionAttachments(TXN, auditStartDate, auditEndDate, selected);
      expect(sorted(rows.map((a) => a.id))).toEqual(EXPECTED_ATTACHMENTS);
    });

    it("C3: the pre-flight lists the link preview and nothing from a removed text", async () => {
      const got = await gather();
      expect(sorted(got.preflight.notIncluded.map((i) => i.key))).toEqual(EXPECTED_NOT_INCLUDED);

      const ipc = await submissionService.preflightSubmission(TXN);
      expect(ipc.success).toBe(true);
      expect(sorted(ipc.notIncluded.map((i) => i.key))).toEqual(EXPECTED_NOT_INCLUDED);
    });

    it("C3: the date-step summary counts the same texts and files", async () => {
      const scope = await submissionService.getSubmissionScope(TXN, { started_at: DAY, closed_at: DAY });
      expect(scope).toMatchObject({
        success: true,
        inWindow: {
          emails: 1,
          texts: EXPECTED_TEXTS.length,
          textThreads: 3, // chat-sel, chat-other, chat-group
          attachments: EXPECTED_ATTACHMENTS.length,
          emailAttachments: 0,
          attachmentBytes: 0,
        },
      });
    });

    it("the shared set is the deal's export text set, not cropped to the window", async () => {
      // o-before is outside the window but in the set; the window crops it
      // in the submit's query.
      expect(sorted(await selectSubmissionTextIds(TXN))).toEqual(sorted([...EXPECTED_TEXTS, "o-before"]));
    });
  });
}
