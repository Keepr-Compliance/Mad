/**
 * @jest-environment node
 *
 * BACKLOG-3819 (founder QA 2026-10-09) — the communication-date backfill must
 * not log phone numbers. Its "Found phone-message matches" sample used to carry
 * each match's normalized phone, and "Backfill complete" carried contact display
 * names (a contact with no name is displayed by its phone number).
 *
 * The assertion is on the ARGUMENTS handed to logService — before the log-sink
 * redactor — so this goes red if a raw value is logged at the source, whatever
 * the redactor would later do with it. Synthetic digits only.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     --runTestsByPath electron/services/db/__tests__/contactDbService.backfillLogNoPhone-3819.test.ts
 */

const PHONE_A = "5555550123";
const PHONE_B = "5555550145";

const mockDbAll = jest.fn();
jest.mock("../core/dbConnection", () => ({
  ensureDb: () => null,
  dbAll: (...args: unknown[]) => mockDbAll(...args),
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
import { backfillContactCommunicationDates } from "../contactDbService";

describe("BACKLOG-3819: backfillContactCommunicationDates logs no phone numbers", () => {
  beforeEach(() => {
    mockDbAll.mockReset();
    // 1st query: phone→message matches. 2nd: the "top contacts" debug read,
    // where an unnamed contact's display_name is its number.
    mockDbAll
      .mockReturnValueOnce([
        { normalized_phone: PHONE_A, contact_id: "c0ffee01-contact-3819-a", last_msg_date: "2026-10-01T12:00:00.000Z" },
        { normalized_phone: PHONE_B, contact_id: "c0ffee02-contact-3819-b", last_msg_date: "2026-10-02T12:00:00.000Z" },
      ])
      .mockReturnValueOnce([
        { display_name: PHONE_B, last_inbound_at: "2026-10-02T12:00:00.000Z" },
      ]);
    (logService.info as jest.Mock).mockClear();
  });

  it("no logged argument carries a matched phone or a display name", async () => {
    const updated = await backfillContactCommunicationDates("user-3819");
    expect(updated).toBe(2);

    const calls = (logService.info as jest.Mock).mock.calls;
    const messages = calls.map((c) => c[0]);
    // The producer really ran both log calls (guards against a vacuous pass).
    expect(messages).toEqual(
      expect.arrayContaining(["Backfill: Found phone-message matches", "Backfill complete"]),
    );
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(PHONE_A);
    expect(logged).not.toContain(PHONE_B);
  });

  it("the sample still identifies matches by contact id prefix and date", async () => {
    await backfillContactCommunicationDates("user-3819");
    const call = (logService.info as jest.Mock).mock.calls.find(
      (c) => c[0] === "Backfill: Found phone-message matches",
    );
    expect(call?.[2]).toEqual({
      matchCount: 2,
      samples: [
        { contactId: "c0ffee01", lastDate: "2026-10-01T12:00:00.000Z" },
        { contactId: "c0ffee02", lastDate: "2026-10-02T12:00:00.000Z" },
      ],
    });
  });
});
