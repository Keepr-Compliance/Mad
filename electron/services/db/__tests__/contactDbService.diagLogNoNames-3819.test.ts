/**
 * @jest-environment node
 *
 * BACKLOG-3819 (SR review) — the [DIAG-1270] contact diagnostics log counts and
 * contact ids only: no display names (an unnamed contact's display name is its
 * phone number), no email or phone lists. Synthetic values only.
 *
 * Two layers:
 *  - behaviour: the ARGUMENTS handed to logService by createContactsBatch and
 *    backfillContactEmailsSync carry no name, phone or address;
 *  - source guard: no [DIAG-1270] log line in contactDbService.ts or
 *    contactHandlers.ts interpolates a name or joins a list (covers the import
 *    handler lines, which need the full IPC harness to execute).
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     --runTestsByPath electron/services/db/__tests__/contactDbService.diagLogNoNames-3819.test.ts
 */

import * as fs from "fs";
import * as path from "path";

const NAME_AS_PHONE = "5555550161";
const EMAIL_A = "pat.sample@example.com";
const EMAIL_B = "pat.other@example.com";

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => null,
  dbAll: () => [],
  dbGet: () => undefined,
  dbRun: () => ({ changes: 1 }),
  dbTransaction: <T>(fn: () => T): T => fn(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));
jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../contactsService", () => ({ getContactNames: () => new Map() }));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

import logService from "../../logService";
import { backfillContactEmailsSync, createContactsBatch } from "../contactDbService";

function diagCalls(): unknown[][] {
  return (logService.warn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes("[DIAG-1270]"));
}

describe("BACKLOG-3819: [DIAG-1270] contact diagnostics log no names or addresses", () => {
  beforeEach(() => (logService.warn as jest.Mock).mockClear());

  it("createContactsBatch logs counts and the new contact id", () => {
    const ids = createContactsBatch([
      {
        user_id: "user-3819",
        display_name: NAME_AS_PHONE,
        allEmails: [EMAIL_A, EMAIL_B],
        allPhones: [NAME_AS_PHONE],
        origin: { kind: "derived" } as never,
      },
    ]);
    const calls = diagCalls();
    expect(calls.length).toBe(2); // the producer ran both lines
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(NAME_AS_PHONE);
    expect(logged).not.toContain(EMAIL_A);
    expect(logged).not.toContain(EMAIL_B);
    expect(logged).toContain(ids[0]);
  });

  it("backfillContactEmailsSync logs counts, not the address list", () => {
    backfillContactEmailsSync("contact-3819", [EMAIL_A, EMAIL_B]);
    const calls = diagCalls();
    expect(calls.length).toBeGreaterThan(0);
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(EMAIL_A);
    expect(logged).not.toContain(EMAIL_B);
    expect(logged).toContain("input=2 emails");
  });
});

describe("BACKLOG-3819: source guard over every [DIAG-1270] log line", () => {
  const FILES = ["../contactDbService.ts", "../../../handlers/contactHandlers.ts"];
  // A name field, or a list joined into the line.
  const FORBIDDEN = /\$\{[^}]*(\bname\b|display_name|displayName|\.join\(|JSON\.stringify)/;

  it.each(FILES)("%s", (rel) => {
    const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
    const lines = src.split("\n").filter((l) => l.includes("`[DIAG-1270]"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => FORBIDDEN.test(l))).toEqual([]);
  });
});
