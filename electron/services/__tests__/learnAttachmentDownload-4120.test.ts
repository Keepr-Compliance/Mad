/**
 * @jest-environment node
 */

/**
 * BACKLOG-4120 PR3 — Learn mode's single on-demand attachment download.
 *
 *   D1-D2  exactly ONE bytes call (getAttachment) for the chosen attachment;
 *          its sibling on the same message keeps storage_path NULL
 *   D3     already on disk -> no provider call at all
 *   D4     not at the provider -> not_available, 0 bytes calls
 *   D5     quiet: a failure with the file name in its message reaches neither
 *          a log line nor Sentry
 *
 * The REAL emailAttachmentService and attachmentDbService run over the real
 * schema.sql on the real driver; the providers are mocked (no network), the
 * at-rest writer/reader are replaced by plain file writes in a temp dir.
 * Synthetic data only.
 */
import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
jest.mock("../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));

jest.mock("../databaseService", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require("../db/attachmentDbService");
  return {
    __esModule: true,
    default: {
      getAttachmentStoragePaths: () => real.getAttachmentStoragePaths(),
      createAttachmentRecord: (p: unknown) => real.createAttachmentRecord(p),
      findEmailAttachmentRow: (e: string, f: string, p: string | null) => real.findEmailAttachmentRow(e, f, p),
      setEmailAttachmentStorage: (id: string, sp: string, n: number, p?: string | null) =>
        real.setEmailAttachmentStorage(id, sp, n, p),
    },
  };
});

const TMP = fs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-4120-att-"));
jest.mock("electron", () => ({
  app: { getPath: () => (global as unknown as { __TMP_4120: string }).__TMP_4120 },
  net: { isOnline: () => true },
}));
(global as unknown as { __TMP_4120: string }).__TMP_4120 = TMP;

let sealFailure: Error | null = null;
jest.mock("../atRest/attachmentWriter", () => ({
  ...jest.requireActual("../atRest/attachmentWriter"),
  sealBufferToFile: jest.fn(async (p: string, data: Buffer) => {
    if (sealFailure) throw sealFailure;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("fs").writeFileSync(p, data);
    return { sha256: "x", plaintextSize: data.length };
  }),
}));
jest.mock("../atRest/attachmentReader", () => ({
  resolveRendererAttachment: jest.fn(async (p: string) => ({ realPath: p, scope: "email-attachments" })),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  readContainedAttachment: jest.fn(async (r: { realPath: string }) => require("fs").readFileSync(r.realPath)),
}));
jest.mock("../attachmentTextExtractionService", () => ({
  extractTextForAttachment: jest.fn(async () => undefined),
}));

const logCalls: unknown[][] = [];
jest.mock("../logService", () => {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      logCalls.push([level, ...args]);
    };
  const m = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
  return { __esModule: true, default: m, logService: m };
});
const sentryCalls: unknown[][] = [];
jest.mock("@sentry/electron/main", () => {
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      sentryCalls.push([name, ...args]);
    };
  return { captureException: rec("captureException"), captureMessage: rec("captureMessage"), addBreadcrumb: rec("addBreadcrumb") };
});

const gmail = {
  initialize: jest.fn(async () => true),
  getEmailById: jest.fn(),
  getAttachment: jest.fn(),
};
const outlook = {
  initialize: jest.fn(async () => true),
  getAttachments: jest.fn(),
  getAttachment: jest.fn(),
};
jest.mock("../gmailFetchService", () => ({ __esModule: true, default: gmail }));
jest.mock("../outlookFetchService", () => ({ __esModule: true, default: outlook }));

import { openQuestionAttachment } from "../learnAttachmentDownload";
import { getQuestionAttachment } from "../db/learnModeDbService";

const USER = "user-4120-a";
const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const TARGET_BYTES = Buffer.from("%PDF-1.4 canary target");
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

function seedEmail(id: string, source: "gmail" | "outlook", externalId: string): void {
  run(
    `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at, body_plain, has_attachments)
     VALUES (?, ?, ?, ?, 'acct-0', 'x', 'a@example.test', 'me@example.test', '2026-10-01T10:00:00.000Z', 'x', 1)`,
    id,
    USER,
    externalId,
    source,
  );
}

function seedAttachment(id: string, emailId: string, filename: string, providerId: string | null, storage: string | null = null): void {
  run(
    `INSERT INTO attachments (id, email_id, filename, mime_type, file_size_bytes, storage_path, provider_attachment_id)
     VALUES (?, ?, ?, 'application/pdf', 1234, ?, ?)`,
    id,
    emailId,
    filename,
    storage,
    providerId,
  );
}

function storageOf(id: string): string | null {
  return (db.prepare(`SELECT storage_path FROM attachments WHERE id = ?`).get(id) as { storage_path: string | null })
    .storage_path;
}

function rowFor(id: string) {
  const row = getQuestionAttachment(USER, id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  logCalls.length = 0;
  sentryCalls.length = 0;
  sealFailure = null;
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);

  gmail.getEmailById.mockResolvedValue({
    attachments: [
      { filename: "Canary sibling.pdf", mimeType: "application/pdf", size: 10, partId: "part-1", attachmentId: "tok-1" },
      { filename: "Canary target agreement.pdf", mimeType: "application/pdf", size: 10, partId: "part-2", attachmentId: "tok-2" },
    ],
  });
  gmail.getAttachment.mockResolvedValue(TARGET_BYTES);
  outlook.getAttachments.mockResolvedValue([
    { id: "graph-1", name: "Canary sibling.pdf", contentType: "application/pdf", size: 10 },
    { id: "graph-2", name: "Canary target agreement.pdf", contentType: "application/pdf", size: 10 },
  ]);
  outlook.getAttachment.mockResolvedValue(TARGET_BYTES);
});

afterEach(() => db.close());
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function decode(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

describe("D1 Gmail: one bytes call for the chosen part, sibling untouched", () => {
  it("fetches a fresh token for the stored part id and downloads only that attachment", async () => {
    seedEmail("e-1", "gmail", "gm-1");
    seedAttachment("a-sib", "e-1", "Canary sibling.pdf", "part-1");
    seedAttachment("a-tgt", "e-1", "Canary target agreement.pdf", "part-2");

    const r = await openQuestionAttachment(USER, rowFor("a-tgt"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.downloadedNow).toBe(true);
    expect(decode(r.dataUrl).equals(TARGET_BYTES)).toBe(true);

    expect(gmail.getAttachment).toHaveBeenCalledTimes(1);
    expect(gmail.getAttachment).toHaveBeenCalledWith("gm-1", "tok-2");
    expect(storageOf("a-tgt")).not.toBeNull();
    expect(storageOf("a-sib")).toBeNull();
    expect(outlook.getAttachment).not.toHaveBeenCalled();
  });

  it("falls back to a unique file name when the row has no part id", async () => {
    seedEmail("e-1", "gmail", "gm-1");
    seedAttachment("a-sib", "e-1", "Canary sibling.pdf", null);
    seedAttachment("a-tgt", "e-1", "Canary target agreement.pdf", null);
    const r = await openQuestionAttachment(USER, rowFor("a-tgt"));
    expect(r.ok).toBe(true);
    expect(gmail.getAttachment).toHaveBeenCalledTimes(1);
    expect(gmail.getAttachment).toHaveBeenCalledWith("gm-1", "tok-2");
    expect(storageOf("a-sib")).toBeNull();
  });
});

describe("D2 Outlook: one bytes call for the chosen Graph id", () => {
  it("downloads only that attachment", async () => {
    seedEmail("e-2", "outlook", "ol-1");
    seedAttachment("a-sib", "e-2", "Canary sibling.pdf", "graph-1");
    seedAttachment("a-tgt", "e-2", "Canary target agreement.pdf", "graph-2");
    const r = await openQuestionAttachment(USER, rowFor("a-tgt"));
    expect(r.ok).toBe(true);
    expect(outlook.getAttachment).toHaveBeenCalledTimes(1);
    expect(outlook.getAttachment).toHaveBeenCalledWith("ol-1", "graph-2");
    expect(storageOf("a-tgt")).not.toBeNull();
    expect(storageOf("a-sib")).toBeNull();
    expect(gmail.getAttachment).not.toHaveBeenCalled();
  });
});

describe("D3 already on disk", () => {
  it("reads the stored file; no provider call at all", async () => {
    seedEmail("e-1", "gmail", "gm-1");
    const p = nodePath.join(TMP, "stored-4120.pdf");
    fs.writeFileSync(p, TARGET_BYTES);
    seedAttachment("a-tgt", "e-1", "Canary target agreement.pdf", "part-2", p);
    const r = await openQuestionAttachment(USER, rowFor("a-tgt"));
    expect(r).toEqual({ ok: true, downloadedNow: false, dataUrl: `data:application/pdf;base64,${TARGET_BYTES.toString("base64")}` });
    expect(gmail.initialize).not.toHaveBeenCalled();
    expect(gmail.getEmailById).not.toHaveBeenCalled();
    expect(gmail.getAttachment).not.toHaveBeenCalled();
  });
});

describe("D4 not at the provider", () => {
  it("an attachment the message no longer lists is not_available with 0 bytes calls", async () => {
    seedEmail("e-1", "gmail", "gm-1");
    seedAttachment("a-gone", "e-1", "Canary gone.pdf", "part-9");
    expect(await openQuestionAttachment(USER, rowFor("a-gone"))).toEqual({ ok: false, reason: "not_available" });
    expect(gmail.getAttachment).not.toHaveBeenCalled();
  });

  it("a provider that cannot be initialised is not_available", async () => {
    gmail.initialize.mockResolvedValueOnce(false);
    seedEmail("e-1", "gmail", "gm-1");
    seedAttachment("a-tgt", "e-1", "Canary target agreement.pdf", "part-2");
    expect(await openQuestionAttachment(USER, rowFor("a-tgt"))).toEqual({ ok: false, reason: "not_available" });
    expect(gmail.getAttachment).not.toHaveBeenCalled();
  });
});

describe("D5 quiet: no file name in a log line, nothing to Sentry", () => {
  it("a write failure whose message quotes the file name leaks nowhere", async () => {
    sealFailure = new Error("disk full writing Canary target agreement.pdf");
    seedEmail("e-1", "gmail", "gm-1");
    seedAttachment("a-tgt", "e-1", "Canary target agreement.pdf", "part-2");
    const r = await openQuestionAttachment(USER, rowFor("a-tgt"));
    expect(r).toEqual({ ok: false, reason: "failed" });
    expect(gmail.getAttachment).toHaveBeenCalledTimes(1);
    expect(logCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logCalls)).not.toMatch(/canary/i);
    expect(sentryCalls).toEqual([]);
  });

  it("the same failure WITHOUT quiet does name the file and report to Sentry (the flag is what holds)", async () => {
    sealFailure = new Error("disk full writing Canary target agreement.pdf");
    seedEmail("e-1", "gmail", "gm-1");
    const svc = (await import("../emailAttachmentService")).default;
    await svc.downloadEmailAttachments(USER, "e-1", "gm-1", "gmail", [
      { filename: "Canary target agreement.pdf", mimeType: "application/pdf", size: 10, partId: "part-2", attachmentId: "tok-2" },
    ]);
    expect(JSON.stringify(logCalls)).toMatch(/Canary target/);
    expect(sentryCalls.length).toBe(1);
  });
});
