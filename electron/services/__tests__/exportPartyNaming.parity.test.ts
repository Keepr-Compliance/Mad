/**
 * @jest-environment node
 *
 * BACKLOG-2758 finding 3 — THE PORTAL AND THE PDF MUST NAME A PARTY IDENTICALLY.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * One transaction, two artifacts, two readers, no shared definition:
 *
 *   - the **broker submission** named parties from `contactsService.
 *     getContactNames()` — the macOS AddressBook (`submissionService.ts:298`
 *     and `:477` at the time of the finding);
 *   - the **desktop PDF** named them from the sqlite `contacts` table.
 *
 * So the same deal could be submitted to the broker under one name and archived
 * locally under another, and **nothing in the product would ever notice**. That
 * is the BACKLOG-2738 class — one fact, two readers — landing on the audit
 * record itself.
 *
 * The fix routes the submission through the same resolver the export uses. The
 * AddressBook is not dropped: it remains tier 3 *inside* that resolver, so a
 * name it alone could supply is still found. It simply stops being a second,
 * independent answer.
 *
 * ---------------------------------------------------------------------------
 * WHY AGREEMENT ALONE IS NOT ASSERTED
 * ---------------------------------------------------------------------------
 * Following the repo's `*.parity.test.ts` convention: two copies that are
 * identically WRONG agree perfectly. So every case states an `expected` string
 * INDEPENDENTLY, and the legs assert (a) the PDF matches it, (b) the submission
 * matches it, and (c) the two match each other. Breaking either side reds.
 *
 * ---------------------------------------------------------------------------
 * THE DISCRIMINATING FIXTURE
 * ---------------------------------------------------------------------------
 * `contactsService.getContactNames` is stubbed to an EMPTY map. Under the old
 * code that made the divergence maximal and visible: the PDF still rendered
 * every name (it read `contacts`), while the submission rendered NONE (it read
 * only the AddressBook). A parity test whose fixture let both sides resolve
 * from the AddressBook would have passed against the defect.
 *
 * CONTROLS — MEASURED, not assumed:
 *   P1  in electron/services/submissionService.ts, revert `resolvePhone` to the
 *       AddressBook-only answer (the pre-fix behaviour, which against this
 *       fixture's empty AddressBook resolves nothing).
 *       -> MEASURED 7 of 13 RED. This is the definitive control: it reproduces
 *          the exact defect — the submission naming a party differently from
 *          the archived PDF — and the suite catches it on every case at once.
 *
 *   P4  in electron/services/folderExport/threadContactLabel.ts, replace the
 *       ambiguous label's name join with a constant (breaking the PDF side
 *       only).
 *       -> MEASURED 1 RED, on the number-led-label leg.
 *          Only one, and the reason is worth stating: the two surfaces agree on
 *          the party NAME (the resolver's map value), which the per-message
 *          sender lines still render, so mutating the thread HEADING breaks the
 *          heading assertion without breaking name parity. P1 is the control
 *          for parity itself; P4 is a control for the heading.
 *
 *   P3  (attempted) in electron/services/contactResolutionService.ts, make
 *       `nameForHandle` skip its normalized-key lookup.
 *       -> MEASURED 13/13 GREEN — NOT a discriminating mutation, recorded so
 *          nobody counts it as one. The resolver writes the raw stored handle
 *          as an alias key alongside the normalized one, so this fixture's
 *          handles resolve either way. The normalized lookup is defensive
 *          against handle formats the contact store does not hold verbatim;
 *          this fixture does not produce one, and no leg here pins it.
 *
 * RUNNER (real native driver — plain `npx jest` cannot load it):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/__tests__/exportPartyNaming.parity.test.ts
 */

const mockCapturedHtml: string[] = [];

jest.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const base = jest.requireActual("../../../tests/__mocks__/electron.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsInner = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osInner = require("os");

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
        printToPDF: async () => Buffer.from("%PDF-1.4\n% parity stub\n"),
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
      getVersion: () => "0.0.0-test",
      getPath: (name: string) => (name === "temp" ? osInner.tmpdir() : base.app.getPath(name)),
    },
    net: base.net ?? {},
    BrowserWindow: MockBrowserWindow,
  };
});

// THE DISCRIMINATING STUB — see the docblock. Empty on purpose.
jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(async () => ({ success: true, contactMap: {} })),
}));

// The submission service reaches Supabase at import time for nothing this test
// touches, but the module graph must still load.
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: jest.fn(() => ({})) },
}));

import {
  createExportFixture,
  type ExportFixture,
} from "../folderExport/__tests__/helpers/exportCaptureFixture2612";
import transactionService from "../transactionService/transactionService";
import folderExportService from "../folderExport/folderExportService";
import { testExportPlan } from "./helpers/exportPlanFixture";
import submissionService from "../submissionService";
import {
  resolveHandles,
  extractParticipantHandles,
  type HandleNameResolution,
} from "../contactResolutionService";
import type { Communication, Message } from "../../types/models";

const USER_ID = "user-parity";
const TX = "tx-parity";
const OWNER_EMAIL = "owner-parity@example.com";

const MORGAN = { id: "c-parity-morgan", name: "Morgan Ellery", phone: "+15035550160" };
const RILEY = { id: "c-parity-riley", name: "Riley Voss", phone: "+15035550161" };
/** Held by BOTH — the ambiguous case must reach the portal as an "or" too. */
const SHARED_PHONE = "+15035550162";
const SHARED_PHONE_LABEL = "+1 (503) 555-0162";

/**
 * Independently stated. NOT read out of either implementation — that is the
 * point of the convention.
 */
const EXPECTED: Array<{ desc: string; handle: string; name: string | undefined }> = [
  {
    desc: "a handle exactly one contact holds",
    handle: MORGAN.phone,
    name: MORGAN.name,
  },
  {
    desc: "a second single-holder handle",
    handle: RILEY.phone,
    name: RILEY.name,
  },
  {
    desc: "a handle TWO contacts share names both, in declared order",
    handle: SHARED_PHONE,
    name: `${MORGAN.name} or ${RILEY.name}`,
  },
];

let fx: ExportFixture;
let resolution: HandleNameResolution;
let seededMessages: Communication[];

beforeAll(async () => {
  fx = await createExportFixture();
  fx.seedUser(USER_ID, OWNER_EMAIL, "Test User");
  fx.seedTransaction({ id: TX, userId: USER_ID, address: "3 Parity Way" });

  fx.seedContact({
    id: MORGAN.id,
    userId: USER_ID,
    displayName: MORGAN.name,
    phones: [{ phone: MORGAN.phone, isPrimary: true }, { phone: SHARED_PHONE }],
  });
  fx.seedContact({
    id: RILEY.id,
    userId: USER_ID,
    displayName: RILEY.name,
    phones: [{ phone: RILEY.phone, isPrimary: true }, { phone: SHARED_PHONE }],
  });
  fx.attachContact({ transactionId: TX, contactId: MORGAN.id, createdAt: "2026-01-01 00:00:00" });
  fx.attachContact({ transactionId: TX, contactId: RILEY.id, createdAt: "2026-01-01 00:00:01" });

  const texts: Array<[string, string, string, string]> = [
    ["msg-parity-1", MORGAN.phone, "2026-03-01 09:00:00", "thr-parity-morgan"],
    ["msg-parity-2", RILEY.phone, "2026-03-02 09:00:00", "thr-parity-riley"],
    ["msg-parity-3", SHARED_PHONE, "2026-03-03 09:00:00", "thr-parity-shared"],
  ];
  for (const [id, sender, sentAt, threadId] of texts) {
    fx.seedLinkedText({
      id,
      userId: USER_ID,
      transactionId: TX,
      sender,
      recipients: OWNER_EMAIL,
      body: "Fixture message",
      sentAt,
      threadId,
    });
  }

  const details = await transactionService.getTransactionDetails(TX);
  if (!details) throw new Error("fixture transaction not found");
  seededMessages = details.communications ?? [];

  // The SAME construction both production surfaces now perform: same handles,
  // same user, same transaction scope.
  resolution = await resolveHandles(extractParticipantHandles(seededMessages), USER_ID, {
    userId: USER_ID,
    transactionId: TX,
  });

  await folderExportService.exportTransactionToFolder(
    details,
    testExportPlan(seededMessages, { contentType: "both", attachmentType: "all" }),
    { transactionId: TX, outputPath: fx.outputDir }
  );
}, 120_000);

afterAll(async () => {
  await fx.cleanup();
});

/**
 * The portal side, through the REAL production mapper.
 *
 * `mapToSubmissionMessage` is private; reached by cast rather than re-stated,
 * because a re-statement would be a third copy of the very thing this file
 * exists to prevent.
 */
function submissionNameFor(handle: string): string | undefined {
  const message = seededMessages.find((m) => {
    const p = typeof m.participants === "string" ? JSON.parse(m.participants) : m.participants;
    return p?.from === handle;
  });
  if (!message) throw new Error(`no seeded message from ${handle}`);

  const record = (
    submissionService as unknown as {
      mapToSubmissionMessage: (
        m: Message,
        submissionId: string,
        names: HandleNameResolution
      ) => { participants?: Record<string, unknown> };
    }
  ).mapToSubmissionMessage(message as unknown as Message, "sub-parity", resolution);

  return record.participants?.from_name as string | undefined;
}

/** The PDF side: every name the exported artifacts actually rendered. */
function pdfRenderedNames(): string {
  return mockCapturedHtml.join("\n");
}

describe("BACKLOG-2758 — portal and PDF name a party identically", () => {
  test("anti-vacuity: the export actually rendered artifacts", () => {
    // Without this, every "the PDF contains X" leg below could pass on an
    // export that produced nothing at all.
    expect(mockCapturedHtml.length).toBeGreaterThan(0);
    expect(seededMessages).toHaveLength(3);
  });

  for (const { desc, handle, name } of EXPECTED) {
    describe(desc, () => {
      test("the SUBMISSION names the party as expected", () => {
        expect(submissionNameFor(handle)).toBe(name);
      });

      test("the PDF names the party as expected", () => {
        expect(pdfRenderedNames()).toContain(name);
      });

      test("PARITY: the two strings are identical", () => {
        // The claim in its own right. The submission's string must appear
        // verbatim in what the PDF rendered — not a variant, not a prefix.
        const submitted = submissionNameFor(handle);
        expect(submitted).toBe(name);
        expect(pdfRenderedNames()).toContain(submitted as string);
      });
    });
  }

  test("the ambiguous party reaches the PORTAL as an 'or', never as one winner", () => {
    // The shared-line rule is not a rendering flourish on the PDF — it has to
    // survive into the record the broker reads, or the two artifacts disagree
    // about who was on the deal in precisely the case that matters.
    const submitted = submissionNameFor(SHARED_PHONE);
    expect(submitted).toBe(`${MORGAN.name} or ${RILEY.name}`);
    expect(submitted).not.toBe(MORGAN.name);
    expect(submitted).not.toBe(RILEY.name);
  });

  test("the AddressBook was empty, so every name above came from `contacts`", () => {
    // Makes the discriminating fixture an assertion rather than a comment: if
    // someone gives the stub real entries later, this leg reds and the person
    // editing it has to notice they have disarmed the test.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getContactNames } = require("../contactsService");
    return getContactNames().then((r: { contactMap: Record<string, string> }) => {
      expect(Object.keys(r.contactMap)).toEqual([]);
    });
  });

  test("the shared handle's thread PDF carries the number-led ambiguous label", () => {
    // Ties the parity claim back to the artifact BACKLOG-2757 is about: the
    // same two names, in the same order, behind the same handle.
    expect(pdfRenderedNames()).toContain(
      `${SHARED_PHONE_LABEL} — ${MORGAN.name} or ${RILEY.name}`
    );
  });
});
