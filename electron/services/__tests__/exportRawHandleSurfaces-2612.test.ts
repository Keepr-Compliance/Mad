/**
 * @jest-environment node
 *
 * BACKLOG-2612 — the OTHER export channels: combined PDF (channels
 * `transactions:export-pdf` / `export-enhanced`→pdf), the csv/json/eml/txt
 * variants, and the CCPA dump.
 *
 * Two different pins:
 *
 *  1. The combined PDF's party section resolves by CONTACT (same resolver A
 *     as the folder export — exact name set, own values).
 *  2. csv / json / eml / txt emit `comm.sender` / `comm.recipients` with ZERO
 *     resolution (raw handles, no contact name). That ABSENCE is asserted
 *     deliberately: a surface with no resolver today is exactly where a
 *     person-grouped resolver would be wired in first, and this sweep must
 *     see it happen (SR review §5 / addendum path 2b).
 *  3. CCPA `privacy:export-data` is the ONLY export that emits `contacts.id` —
 *     the cheapest identity tripwire in the codebase. Its emitted id set must
 *     equal the seeded contact id set EXACTLY, tombstoned rows included
 *     (BACKLOG-2365: "all personal information we hold" would be a false
 *     statement without them).
 *
 * CONTROLS (manual, full paths, results on BACKLOG-2612):
 *   R1  combined-PDF party set — same mutation as C1 (drop the transaction
 *       WHERE in electron/services/db/transactionContactDbService.ts) → RED.
 *   R2  raw-handle absence — resolve `comm.sender` through a name in
 *       electron/services/enhancedExportService.ts `_createEMLContent`
 *       (replace `email.sender` with a constant name) → RED.
 *   R3  CCPA id set — filter tombstoned rows (drop `include_removed: true` in
 *       electron/services/ccpaExportService.ts) → RED.
 *
 * RUNNER:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/__tests__/exportRawHandleSurfaces-2612.test.ts
 */

import path from "path";
import fs from "fs";
import os from "os";

const mockCapturedHtml: string[] = [];
/** Where app.getPath("downloads") points for this suite — created in the mock factory. */
const mockDownloadsDir = path.join(os.tmpdir(), `export-2612-downloads-${process.pid}`);

jest.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const base = jest.requireActual("../../../tests/__mocks__/electron.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsInner = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osInner = require("os");

  fsInner.mkdirSync(mockDownloadsDir, { recursive: true });

  class MockBrowserWindow {
    public webContents: {
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      once: (event: string, cb: (...args: unknown[]) => void) => void;
      printToPDF: () => Promise<Buffer>;
      send: () => void;
    };

    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor() {
      this.webContents = {
        on: (event, cb) => {
          (this.listeners[event] ??= []).push(cb);
        },
        once: (event, cb) => {
          (this.listeners[event] ??= []).push(cb);
        },
        printToPDF: async () => Buffer.from("%PDF-1.4\n% BACKLOG-2612 stub\n"),
        send: () => undefined,
      };
    }

    async loadFile(file: string): Promise<void> {
      mockCapturedHtml.push(fsInner.readFileSync(file, "utf8"));
      for (const cb of this.listeners["did-finish-load"] ?? []) cb();
    }

    close(): void {
      // no-op
    }

    isDestroyed(): boolean {
      return false;
    }
  }

  return {
    ...base,
    app: {
      ...base.app,
      getPath: (name: string) => {
        if (name === "temp") return osInner.tmpdir();
        if (name === "downloads") return mockDownloadsDir;
        return base.app.getPath(name);
      },
    },
    BrowserWindow: MockBrowserWindow,
  };
});

jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(async () => ({ success: true, contactMap: {} })),
}));

import {
  createExportFixture,
  type ExportFixture,
} from "../folderExport/__tests__/helpers/exportCaptureFixture2612";
import transactionService from "../transactionService/transactionService";
import enhancedExportService from "../enhancedExportService";
import { exportUserData } from "../ccpaExportService";
import { deleteContact } from "../db/contactDbService";

const USER_ID = "user-2612-raw";
const TX = "tx-2612-raw";

const CHRIS = {
  id: "c-raw-chris",
  name: "Chris Alvarez",
  primaryEmail: "chris.alvarez@example.com",
  phone: "+15035550140",
};
const DANA = {
  id: "c-raw-dana",
  name: "Dana Alvarez",
  primaryEmail: "dana.alvarez@example.com",
  phone: "+15035550141",
};
const SHARED_PHONE = "+15035550142";
const PAT = { id: "c-raw-pat", name: "Pat Riverton", primaryEmail: "pat.riverton@example.com" };

let fx: ExportFixture;
let communicationsCount = 0;

beforeAll(async () => {
  fx = await createExportFixture();
  fx.seedUser(USER_ID, "owner-2612-raw@example.com", "Test User");
  fx.seedTransaction({
    id: TX,
    userId: USER_ID,
    address: "114 Cypress Ave",
    startedAt: "2026-01-01 00:00:00",
    closedAt: "2026-03-01 00:00:00",
  });
  fx.seedContact({
    id: CHRIS.id,
    userId: USER_ID,
    displayName: CHRIS.name,
    emails: [{ email: CHRIS.primaryEmail, isPrimary: true }],
    phones: [{ phone: SHARED_PHONE, isPrimary: true }, { phone: CHRIS.phone }],
  });
  fx.seedContact({
    id: DANA.id,
    userId: USER_ID,
    displayName: DANA.name,
    emails: [{ email: DANA.primaryEmail, isPrimary: true }],
    phones: [{ phone: SHARED_PHONE, isPrimary: true }, { phone: DANA.phone }],
  });
  fx.seedContact({
    id: PAT.id,
    userId: USER_ID,
    displayName: PAT.name,
    emails: [{ email: PAT.primaryEmail, isPrimary: true }],
  });
  fx.attachContact({ transactionId: TX, contactId: CHRIS.id, role: "buyer", isPrimary: true, createdAt: "2026-01-05 10:00:00" });
  fx.attachContact({ transactionId: TX, contactId: DANA.id, role: "buyer", createdAt: "2026-01-05 10:01:00" });

  fx.seedLinkedEmail({
    id: "em-raw-1",
    userId: USER_ID,
    transactionId: TX,
    sender: CHRIS.primaryEmail,
    recipients: "owner-2612-raw@example.com",
    subject: "Inspection scheduling",
    sentAt: "2026-01-10 09:00:00",
  });
  fx.seedLinkedText({
    id: "msg-raw-1",
    userId: USER_ID,
    transactionId: TX,
    sender: SHARED_PHONE,
    recipients: "owner-2612-raw@example.com",
    body: "Keys are at the office",
    sentAt: "2026-01-12 09:00:00",
    threadId: "thr-raw-shared",
  });
}, 120_000);

afterAll(async () => {
  await fx.cleanup();
  fs.rmSync(mockDownloadsDir, { recursive: true, force: true });
});

async function runEnhancedExport(format: "pdf" | "csv" | "json" | "txt_eml"): Promise<string> {
  const details = await transactionService.getTransactionDetails(TX);
  if (!details) throw new Error("fixture transaction not found");
  communicationsCount = details.communications?.length ?? 0;
  return enhancedExportService.exportTransaction(details, details.communications ?? [], {
    exportFormat: format,
    contentType: "both",
    summaryOnly: format === "pdf",
  });
}

describe("BACKLOG-2612 — combined PDF (channels export-pdf / export-enhanced→pdf)", () => {
  test("the party section names exactly the two attached contacts with their own primary values", async () => {
    mockCapturedHtml.length = 0;
    await runEnhancedExport("pdf");
    expect(communicationsCount).toBeGreaterThan(0); // anti-vacuity: the export had content

    const html = mockCapturedHtml.find((h) => h.includes("<h3>Contacts"));
    expect(html).toBeTruthy();
    const names = [...(html as string).matchAll(/<span class="contact-name">([^<]*)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual([CHRIS.name, DANA.name]);
    expect(html).toContain(CHRIS.primaryEmail);
    expect(html).toContain(DANA.primaryEmail);
    // The unattached contact never leaks in.
    expect(html).not.toContain(PAT.name);
  }, 60_000);
});

describe("BACKLOG-2612 — csv / json / eml / txt resolve the party by NOTHING (pinned absence)", () => {
  test("CSV: From/To are raw handles; no contact display name anywhere in the file", async () => {
    const outPath = await runEnhancedExport("csv");
    const csv = fs.readFileSync(outPath, "utf8");
    expect(csv).toContain(CHRIS.primaryEmail); // raw email handle
    expect(csv).toContain(SHARED_PHONE); // raw phone handle
    for (const name of [CHRIS.name, DANA.name, PAT.name]) {
      expect(csv).not.toContain(name);
    }
  }, 60_000);

  test("JSON: sender/recipients are raw handles; no contact display name anywhere in the document", async () => {
    const outPath = await runEnhancedExport("json");
    const doc = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
      communications: Array<{ sender?: string }>;
    };
    // Exact sender set across the exported communications — raw handles.
    expect(doc.communications.map((c) => c.sender).sort()).toEqual(
      [CHRIS.primaryEmail, SHARED_PHONE].sort(),
    );
    const raw = fs.readFileSync(outPath, "utf8");
    for (const name of [CHRIS.name, DANA.name, PAT.name]) {
      expect(raw).not.toContain(name);
    }
  }, 60_000);

  test("EML/TXT: From lines carry the raw handle; no contact display name in any emitted file", async () => {
    const outPath = await runEnhancedExport("txt_eml");
    // _exportTxtEml writes a folder of .eml / .txt files.
    const files = fs.readdirSync(outPath, { recursive: true }) as string[];
    const contentFiles = files.filter((f) => f.endsWith(".eml") || f.endsWith(".txt"));
    expect(contentFiles.length).toBeGreaterThan(0);

    const froms: string[] = [];
    for (const f of contentFiles) {
      const text = fs.readFileSync(path.join(outPath, f), "utf8");
      froms.push(...[...text.matchAll(/^From: (.*)$/gm)].map((m) => m[1].trim()));
      for (const name of [CHRIS.name, DANA.name, PAT.name]) {
        expect(text).not.toContain(name);
      }
    }
    // The exact From set is the raw handle set of the seeded communications.
    expect([...new Set(froms)].sort()).toEqual([CHRIS.primaryEmail, SHARED_PHONE].sort());
  }, 60_000);
});

describe("BACKLOG-2612 — CCPA export: the contact-id tripwire", () => {
  test("the emitted contacts record id set EQUALS the seeded contact id set — tombstoned rows included", async () => {
    // Tombstone one contact through the real producer first: the CCPA dump
    // must still emit her row (BACKLOG-2365 — omitting tombstoned rows would
    // make "all personal information we hold" a false statement).
    await deleteContact(DANA.id, "user_deleted");

    const data = await exportUserData(USER_ID);
    const emittedIds = (data.contacts.records as Array<{ id: string }>).map((r) => r.id).sort();
    // EXACT id set — one JSON record per contacts.id. A person-style grouping
    // collapsing rows here is visible immediately, which is what makes this
    // the cheapest identity tripwire on any export path.
    expect(emittedIds).toEqual([CHRIS.id, DANA.id, PAT.id].sort());
  }, 60_000);
});
