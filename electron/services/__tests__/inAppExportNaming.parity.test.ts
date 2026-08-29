/**
 * @jest-environment node
 *
 * BACKLOG-2842 — THE APP AND THE EXPORT MUST NAME THE SAME THREAD IDENTICALLY.
 *
 * ===========================================================================
 * THE DEFECT — PREDICTED, THEN OBSERVED
 * ===========================================================================
 * BACKLOG-2757/2758 made the EXPORT resolve party names with a transaction
 * scope. The in-app path could not: `contactHandlers`'s `contacts:resolve-handles`
 * passed no scope, and the IPC contract had no parameter to put a transaction id
 * in. So the same handle resolved GLOBALLY in the app and SCOPED in the export.
 *
 * The PR #2369 SR review called this out on 2026-08-23 and named the exact
 * string it would produce: a contested handle reading "Chris Alvarez or Pat
 * Riverton" in the messages tab and "Chris Alvarez" in the exported PDF. The
 * founder hit precisely that four days later, by unlinking a duplicate contact
 * and comparing the Texts tab against the export.
 *
 * The harm is specific: the app and the audit artifact disagree about who a
 * thread belongs to, and the artifact is the one handed to a broker.
 *
 * ===========================================================================
 * WHY A PARITY TEST, AND NOT TWO SEPARATE ONES
 * ===========================================================================
 * BACKLOG-2842 asked for this pattern by name. Two independently-tested
 * surfaces can each be "correct" against their own expectation and still
 * disagree with each other — the divergence itself is the defect, so the
 * divergence itself must be the failure.
 *
 * Following the repo's `*.parity.test.ts` convention: agreement alone is NOT
 * asserted, because two copies that are identically wrong agree perfectly.
 * Every case states its `expected` label INDEPENDENTLY, and the legs assert
 * (a) the app matches it, (b) the export matches it, (c) the two match each
 * other. Breaking either side reds.
 *
 * ===========================================================================
 * BOTH SIDES RUN THEIR REAL PRODUCTION ENTRY POINT
 * ===========================================================================
 *   - APP: the registered `contacts:resolve-handles` IPC handler, invoked with
 *     the argument tuple the Texts tab sends. Not a re-statement of it — the
 *     handler builds its own scope, so reverting that construction reds here.
 *   - EXPORT: `folderExportService.exportTransactionToFolder`, with the labels
 *     read out of the HTML it actually rendered.
 *
 *   `databaseService`, `contactResolutionService` and the contact DB services
 *   are deliberately NOT mocked; only providers, workers and schedulers are, so
 *   the module can be imported without opening a network connection.
 *
 * ===========================================================================
 * THE DISCRIMINATING FIXTURE
 * ===========================================================================
 * CONTESTED_PHONE is held by two contacts: one a party to THIS deal, one a
 * party to a different deal. That is the only shape where scoped and unscoped
 * resolution differ, and it is the founder's exact case. A fixture whose shared
 * handle had both holders on the deal would agree under the defect and prove
 * nothing. The macOS AddressBook is stubbed EMPTY so every name below is proven
 * to come from the sqlite `contacts` store.
 *
 * ===========================================================================
 * CONTROLS — MEASURED, `--bail=0` (jest.config.js sets `bail: 1`, so a count
 * taken without the flag is a FLOOR). Counts recorded in the PR body.
 * ===========================================================================
 *   Y1  THE DEFECT ITSELF — in electron/handlers/contactHandlers.ts, revert to
 *       the pre-fix `resolveHandles(handles, validatedUserId ?? undefined)`.
 *       Breaks the APP side only; the export is untouched. This is the exact
 *       divergence the SR review predicted.
 *       -> MEASURED 4 failed / 7 passed of 11.
 *
 *   Y2  BREAK THE EXPORT SIDE INSTEAD — in
 *       electron/services/folderExport/folderExportService.ts, drop the scope
 *       from the `resolveAllHandles` call at :237. Proves the file is not
 *       merely pinning the app against itself.
 *       -> MEASURED 3 failed / 8 passed of 11.
 *
 * TWO FIXTURE LESSONS, BOTH LEARNED BY Y2 REFUSING TO GO RED. Recorded because
 * either would silently disarm this file again:
 *
 *   1. A SUBSTRING READER CANNOT SEE THIS DEFECT. The first version asserted
 *      `expect(allHtml).toContain("Dana Alvarez")`. The broken export renders
 *      "Dana Alvarez or Pat Riverton", which CONTAINS that — Y2 measured 10/10
 *      GREEN. The readers below match the closing tag so the name's end is
 *      pinned.
 *
 *   2. TWO CASES EXPECTING THE SAME NAME ALIAS. With both the contested and the
 *      uncontested handle expecting "Chris Alvarez", the uncontested thread kept
 *      rendering that exact string, so the contested thread could break and the
 *      export-side list still contained the expected value — Y2 measured only
 *      1 red of 11, and the parity leg itself survived a broken export. The
 *      contested handle now resolves to a DIFFERENT party (Dana), so nothing
 *      else in the artifact can stand in for it.
 *
 * RUNNER — the real native sqlite driver; plain `npx jest` cannot load it:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/__tests__/inAppExportNaming.parity.test.ts
 *
 * Every name is invented (FICTIONAL_NAMES in scripts/ci/check-fixture-pii.mjs);
 * numbers are reserved-for-fiction 555-01xx. None refers to anyone.
 */

const mockCapturedHtml: string[] = [];

jest.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const base = jest.requireActual("../../../tests/__mocks__/electron.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osInner = require("os");

  class MockBrowserWindow {
    public webContents: {
      on: (e: string, cb: (...a: unknown[]) => void) => void;
      once: (e: string, cb: (...a: unknown[]) => void) => void;
      printToPDF: () => Promise<Buffer>;
      send: () => void;
    };
    private listeners: Record<string, Array<(...a: unknown[]) => void>> = {};

    constructor() {
      this.webContents = {
        on: (e, cb) => {
          (this.listeners[e] ||= []).push(cb);
        },
        once: (e, cb) => {
          (this.listeners[e] ||= []).push(cb);
        },
        printToPDF: async () => Buffer.from("%PDF-1.4 fixture"),
        send: () => {},
      };
    }
    async loadFile(file: string): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fsInner = require("fs");
      mockCapturedHtml.push(fsInner.readFileSync(file, "utf8"));
      for (const cb of this.listeners["did-finish-load"] ?? []) cb();
    }
    close(): void {}
    destroy(): void {}
    isDestroyed(): boolean {
      return false;
    }
    static getAllWindows(): unknown[] {
      return [];
    }
  }

  return {
    ...base,
    app: {
      ...base.app,
      getPath: (name: string) => (name === "temp" ? osInner.tmpdir() : base.app.getPath(name)),
    },
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle: jest.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
        handlersRef.set(channel, fn);
      }),
      on: jest.fn(),
    },
  };
});

// The macOS AddressBook must never answer: stubbed EMPTY, so every name below is
// proven to come from the sqlite `contacts` store rather than a machine-local
// address book CI does not have.
jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(async () => ({ success: true, contactMap: {} })),
}));

const handlersRef = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));


jest.mock("../db/contactSourceSets", () => ({
  __esModule: true,
  getLiveSourcesForContact: jest.fn(() => []),
}));

// Everything else `registerContactHandlers` pulls in at module load. None of it
// is exercised by `contacts:resolve-handles`; these exist so the module can be
// imported without opening a provider connection or starting a worker pool.
//
// `databaseService`, `contactResolutionService`, `contactDbService`,
// `externalContactDbService` and `dbConnection` are DELIBERATELY NOT mocked —
// this file resolves names against the real fixture database, which is the whole
// point of a parity test.
jest.mock("../failureLogService", () => ({ __esModule: true, default: {} }));
jest.mock("../auditService", () => ({ __esModule: true, default: { log: jest.fn() } }));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../contactIngestionFunnel", () => ({
  __esModule: true,
  recordPicker: jest.fn(),
  recordLinks: jest.fn(),
}));
jest.mock("../contactLinkingScheduler", () => ({
  __esModule: true,
  cancelPendingContactLinking: jest.fn(),
  configureContactLinking: jest.fn(),
  requestContactLinking: jest.fn(),
  runContactLinkingNow: jest.fn(),
}));
jest.mock("../db/contactSourceLinkDbService", () => ({
  __esModule: true,
  createLink: jest.fn(),
  findContactIdBySourceRecord: jest.fn(),
  getLinkedSourceKeys: jest.fn(() => new Set()),
  sourceKey: jest.fn(),
}));
jest.mock("../db/contactSourceLinkSql", () => ({
  __esModule: true,
  CONTACT_SOURCE_RECORDS_SQL: "",
}));
jest.mock("../contactSourceLinker", () => ({
  __esModule: true,
  linkExternalContactsForUser: jest.fn(),
}));
jest.mock("../contactNameAutoLink", () => ({
  __esModule: true,
  runUniqueNameAutoLink: jest.fn(),
}));
jest.mock("../contactLinkEvidence", () => ({
  __esModule: true,
  buildEvidence: jest.fn(),
  sourceLabel: jest.fn(),
}));
jest.mock("../db/contactLinkReviewDbService", () => ({
  __esModule: true,
  proposeLink: jest.fn(),
  listVerdicts: jest.fn(() => []),
  getRejectedSourceKeys: jest.fn(() => new Set()),
}));
jest.mock("../contactLinkReview", () => ({
  __esModule: true,
  countReviewQueue: jest.fn(() => 0),
  getReviewQueue: jest.fn(() => []),
  confirmProposal: jest.fn(),
  rejectProposal: jest.fn(),
}));
jest.mock("../contactProvenance", () => ({
  __esModule: true,
  getContactProvenance: jest.fn(() => []),
  unlinkContactSource: jest.fn(),
}));
jest.mock("../../workers/contactWorkerPool", () => ({
  __esModule: true,
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));
jest.mock("../contactSourceValues", () => ({
  __esModule: true,
  applyLinkedSourceValues: jest.fn(),
}));
jest.mock("../db/contactOriginLink", () => ({
  __esModule: true,
  recordContactOrigin: jest.fn(),
}));
jest.mock("../contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn() },
}));
jest.mock("../providers/outlookContactProvider", () => ({
  __esModule: true,
  OutlookContactProvider: class {},
}));
jest.mock("../providers/googleContactProvider", () => ({
  __esModule: true,
  GoogleContactProvider: class {},
}));


jest.mock("../contactManualLink", () => ({
  __esModule: true,
  findLinkableSourceRecords: jest.fn(() => []),
  linkSourceRecordsToContact: jest.fn(() => [{ ok: true, linkId: "link-1" }]),
}));

const mockGetValidUserId = jest.fn();
jest.mock("../../utils/userIdHelper", () => ({
  __esModule: true,
  getValidUserId: (...a: unknown[]) => mockGetValidUserId(...a),
  getValidUserIdSync: jest.fn(),
}));


import { createExportFixture, type ExportFixture } from "../folderExport/__tests__/helpers/exportCaptureFixture2612";
import { testExportPlan } from "./helpers/exportPlanFixture";
import transactionService from "../transactionService/transactionService";
import folderExportService from "../folderExport/folderExportService";
import { registerContactHandlers } from "../../handlers/contactHandlers";
import { normalizePhone } from "../contactResolutionService";

const USER_ID = "user-2842";
const TX = "tx-2842-main";
const TX_OTHER = "tx-2842-other";
const OWNER_EMAIL = "owner-2842@example.com";

const CHRIS = { id: "c-2842-chris", name: "Chris Alvarez" };
/**
 * Holds the contested line and IS a party to this deal. Deliberately a
 * DIFFERENT person from the uncontested handle's holder: if both cases expected
 * the same name, the export-side assertions would alias — the uncontested
 * thread would keep rendering that name exactly, and a broken contested thread
 * would still find it in the list. MEASURED: with both cases expecting
 * "Chris Alvarez", control Y2 red only 1 of 11 and the parity leg itself
 * survived a broken export.
 */
const DANA = { id: "c-2842-dana", name: "Dana Alvarez" };
/** The "duplicate contact": a real contact, party to a DIFFERENT deal. */
const PAT = { id: "c-2842-pat", name: "Pat Riverton" };

/**
 * Held by DANA (a party to TX) and PAT (not a party to TX). THE case: the only
 * shape where scoped and unscoped resolution disagree.
 */
const CONTESTED_PHONE = "+15035550155";
/** Held by CHRIS alone — must agree under BOTH the fix and the defect. */
const PLAIN_PHONE = "+15035550150";

/**
 * The labels, stated INDEPENDENTLY of either surface. Per the parity convention:
 * two copies that are identically wrong agree perfectly, so agreement alone is
 * never the assertion.
 */
const EXPECTED: Array<{ desc: string; handle: string; label: string }> = [
  {
    desc: "a contested handle — one holder on this deal, one not",
    handle: CONTESTED_PHONE,
    // Scoped: the party wins outright. Pre-fix the APP said
    // "Dana Alvarez or Pat Riverton" here while the export said this.
    label: DANA.name,
  },
  {
    desc: "an uncontested handle",
    handle: PLAIN_PHONE,
    label: CHRIS.name,
  },
];

let fx: ExportFixture;

beforeAll(async () => {
  fx = await createExportFixture();

  fx.seedUser(USER_ID, OWNER_EMAIL, "Test User");
  fx.seedTransaction({ id: TX, userId: USER_ID, address: "1 Shared Line Rd" });
  fx.seedTransaction({ id: TX_OTHER, userId: USER_ID, address: "2 Other Deal Ave" });

  // PAT is inserted FIRST and CHRIS second: under the pre-2757 resolver the
  // LAST row won, so this ordering is the one that would have produced the
  // wrong name. It keeps the fixture honest about which property is under test.
  fx.seedContact({
    id: PAT.id,
    userId: USER_ID,
    displayName: PAT.name,
    phones: [{ phone: CONTESTED_PHONE, isPrimary: true }],
  });
  fx.seedContact({
    id: DANA.id,
    userId: USER_ID,
    displayName: DANA.name,
    phones: [{ phone: CONTESTED_PHONE, isPrimary: true }],
  });
  fx.seedContact({
    id: CHRIS.id,
    userId: USER_ID,
    displayName: CHRIS.name,
    phones: [{ phone: PLAIN_PHONE, isPrimary: true }],
  });

  fx.attachContact({ transactionId: TX, contactId: CHRIS.id, createdAt: "2026-01-01 00:00:00" });
  fx.attachContact({ transactionId: TX, contactId: DANA.id, createdAt: "2026-01-01 00:00:01" });
  fx.attachContact({ transactionId: TX_OTHER, contactId: PAT.id, createdAt: "2026-01-01 00:00:02" });

  fx.seedLinkedText({
    id: "m-2842-1",
    userId: USER_ID,
    transactionId: TX,
    sender: CONTESTED_PHONE,
    recipients: "me",
    body: "Fixture message on the contested line",
    sentAt: "2026-02-01T10:00:00Z",
    threadId: "t-2842-contested",
  });
  fx.seedLinkedText({
    id: "m-2842-2",
    userId: USER_ID,
    transactionId: TX,
    sender: PLAIN_PHONE,
    recipients: "me",
    body: "Fixture message on the plain line",
    sentAt: "2026-02-02T10:00:00Z",
    threadId: "t-2842-plain",
  });

  mockGetValidUserId.mockResolvedValue(USER_ID);
  registerContactHandlers({} as never);

  const details = await transactionService.getTransactionDetails(TX);
  if (!details) throw new Error("fixture transaction not found");

  await folderExportService.exportTransactionToFolder(
    details,
    testExportPlan(details.communications ?? [], {
      contentType: "both",
      attachmentType: "all",
    }),
    { transactionId: TX, outputPath: fx.outputDir }
  );
}, 180_000);

afterAll(async () => {
  await fx.cleanup();
});

/**
 * The APP side, through the REAL registered IPC handler, invoked with the
 * argument tuple TransactionMessagesTab sends. The handler builds its own scope,
 * so reverting that construction reds these legs.
 */
async function appLabelFor(handle: string): Promise<string | undefined> {
  const handler = handlersRef.get("contacts:resolve-handles");
  if (!handler) throw new Error("contacts:resolve-handles was never registered");
  const res = (await handler({}, [handle], USER_ID, { transactionId: TX })) as {
    success: boolean;
    names: Record<string, string>;
  };
  expect(res.success).toBe(true);
  // The same key chain the renderer uses (normalized, then raw).
  return res.names[normalizePhone(handle)] ?? res.names[handle];
}

/**
 * The EXPORT side, read EXACTLY rather than by substring.
 *
 * This matters more than it looks. A `toContain("Chris Alvarez")` check over the
 * whole HTML blob passes when the export degrades to "Chris Alvarez or Pat
 * Riverton", because that string contains it — MEASURED: with a substring
 * reader, control Y2 (drop the export's scope) left this file 10/10 GREEN and
 * the export half of the parity claim was worth nothing. Reading the closing
 * tag pins the end of the name, so the ambiguous label no longer matches.
 */
function exportSenderNames(): string[] {
  const html = mockCapturedHtml.join("\n");
  return [...html.matchAll(/<span class="sender">([^<]*)<\/span>/g)].map((m) => m[1]);
}

/** Every conversation heading the export rendered, names only. */
function exportConversationNames(): string[] {
  const html = mockCapturedHtml.join("\n");
  return [...html.matchAll(/<h1>Conversation with ([^<]*?) <span/g)].map((m) => m[1]);
}

/** Everything rendered, for absence checks. */
function exportRenderedNames(): string {
  return mockCapturedHtml.join("\n");
}

describe("BACKLOG-2842 — the app and the export name a thread identically", () => {
  test("anti-vacuity: the export actually rendered artifacts", () => {
    // Without this, every "the export contains X" leg below could pass on an
    // export that produced nothing at all.
    expect(mockCapturedHtml.length).toBeGreaterThan(0);
  });

  for (const { desc, handle, label } of EXPECTED) {
    describe(desc, () => {
      test("the APP names the party as expected", async () => {
        expect(await appLabelFor(handle)).toBe(label);
      });

      test("the EXPORT names the party as expected", () => {
        // Exact rendered values, not a substring of the page: the ambiguous
        // label CONTAINS the scoped one, so a substring check cannot tell the
        // fixed export from the broken one.
        expect(exportSenderNames()).toContain(label);
        expect(exportConversationNames()).toContain(label);
      });

      test("PARITY: the app's string is EXACTLY a name the export rendered", async () => {
        const app = await appLabelFor(handle);
        expect(app).toBe(label);
        expect(exportSenderNames()).toContain(app as string);
        expect(exportConversationNames()).toContain(app as string);
      });
    });
  }

  test("the contested handle does NOT reach the app as an ambiguous label", async () => {
    // The defect's exact string, named so a future reader can see what was
    // being produced. Asserted as inequality AND as the positive value above,
    // because "not the or" alone would also pass on an empty answer.
    const app = await appLabelFor(CONTESTED_PHONE);
    expect(app).not.toBe(`${DANA.name} or ${PAT.name}`);
    expect(app).toBe(DANA.name);
  });

  test("the EXPORT never renders the ambiguous label for the contested handle", () => {
    // The export half of the divergence, stated as its own claim. This is the
    // leg control Y2 reds; without it, dropping the export's scope left the file
    // entirely green because every assertion was a substring check.
    const ambiguous = `${DANA.name} or ${PAT.name}`;
    expect(exportSenderNames()).not.toContain(ambiguous);
    expect(exportConversationNames()).not.toContain(ambiguous);
    // Pat is not on this deal, so Pat's name has no business anywhere in this
    // deal's audit package — not in a heading, a sender line, or a party table.
    expect(exportRenderedNames()).not.toContain(PAT.name);
  });

  test("the out-of-deal contact is a real, resolvable contact — not simply absent", async () => {
    // ANTI-VACUITY FOR THE WHOLE FILE. If Pat could not resolve at all, every
    // leg above would pass for the wrong reason and the scoping would be
    // untested. Resolved against the deal Pat IS a party to, Pat must answer.
    const handler = handlersRef.get("contacts:resolve-handles");
    if (!handler) throw new Error("contacts:resolve-handles was never registered");
    const res = (await handler({}, [CONTESTED_PHONE], USER_ID, {
      transactionId: TX_OTHER,
    })) as { success: boolean; names: Record<string, string> };
    expect(res.names[normalizePhone(CONTESTED_PHONE)]).toBe(PAT.name);
  });

  test("the AddressBook was empty, so every name above came from `contacts`", async () => {
    // Makes the discriminating fixture an assertion rather than a comment: if
    // someone gives the stub real entries later, this reds and whoever edited it
    // has to notice they have disarmed the test.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getContactNames } = require("../contactsService");
    const r = await getContactNames();
    expect(Object.keys(r.contactMap)).toEqual([]);
  });
});
