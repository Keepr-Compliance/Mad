/**
 * @jest-environment node
 *
 * BACKLOG-2757 + BACKLOG-2758 — WHAT AN EXPORTED THREAD IS CALLED.
 *
 * ===========================================================================
 * THE DEFECT THESE LEGS EXIST TO KEEP DEAD
 * ===========================================================================
 * Two saved contacts share a phone number — a household line, an office line,
 * a couple. Their messages are ONE real conversation (the grouping is correct
 * and is not what changed here), and the export used to label that conversation
 * with whichever of the two contacts SQLite returned LAST: `result[key] =
 * row.display_name` with no guard, over rows yielded in rowid order. Rowid order
 * is insertion order, so the winner was "whoever was saved second" — and that
 * name was written into a PDF FILE NAME inside an audit package handed to a
 * broker.
 *
 * A fix that merely picked the OTHER contact would not be a fix. The property
 * under test is therefore not "which name" but **that the answer does not depend
 * on insertion order at all**, and that where there is no honest single name,
 * none is written to disk.
 *
 * ===========================================================================
 * CONTROLS — every one of these was run as a MUTATION and observed RED.
 * Paths are from the repo root. Results are recorded in the PR body.
 * ===========================================================================
 *   M1  DETERMINISM — in electron/services/contactResolutionService.ts,
 *       `namesForHandle`: delete the `.sort(...)` so the order falls back to
 *       row order.
 *       -> RED on "insertion order changes NOTHING" (the two orderings produce
 *          "Dana Alvarez or Chris Alvarez" vs "Chris Alvarez or Dana Alvarez").
 *
 *   M2  AMBIGUITY -> FILENAME — in electron/services/folderExport/
 *       threadContactLabel.ts, `threadNaming`: change the `names.length > 1`
 *       branch to return `{ ...ambiguous: false }`.
 *       -> RED on the exact filename set (the wrong person's name returns to
 *          disk).
 *
 *   M3  TRANSACTION SCOPING — in electron/services/db/attachmentDbService.ts,
 *       `transactionLinkedSelect`: return `0 AS is_transaction_linked`
 *       unconditionally.
 *       -> RED on the scoping leg (the out-of-deal contact wins a share of the
 *          label it must not have).
 *
 *   M4  USER SCOPING — in the same file, `userScopeClause`: return
 *       `{ clause: "", params: [] }` unconditionally.
 *       -> RED on the cross-user leg (another user's contact names a party in
 *          this user's export).
 *
 *   M5  APPLE-ID DETERMINISM — in the same file,
 *       `getContactNameByAppleIdPrefix`: drop the `ORDER BY`.
 *       -> RED on the prefix leg.
 *
 * RUNNER (real native driver — plain `npx jest` cannot load it):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/folderExport/__tests__/exportThreadNaming-2757.test.ts
 */

import path from "path";
import fs from "fs";

const mockCapturedHtml: string[] = [];

jest.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const base = jest.requireActual("../../../../tests/__mocks__/electron.js");
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
        printToPDF: async () => Buffer.from("%PDF-1.4\n% BACKLOG-2757 stub\n"),
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
      getPath: (name: string) => (name === "temp" ? osInner.tmpdir() : base.app.getPath(name)),
    },
    BrowserWindow: MockBrowserWindow,
  };
});

// The macOS AddressBook must never be read here: stubbed to an EMPTY map, so
// every name that appears in an artifact is proven to come from the sqlite
// `contacts` store. (This is also the stub that proved BACKLOG-2758 finding 3:
// the PDF kept rendering names with the AddressBook empty, while the broker
// submission — which read ONLY the AddressBook — would have rendered none.)
jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(async () => ({ success: true, contactMap: {} })),
}));

import { createExportFixture, type ExportFixture } from "./helpers/exportCaptureFixture2612";
import transactionService from "../../transactionService/transactionService";
import folderExportService from "../folderExportService";
import { testExportPlan } from "../../__tests__/helpers/exportPlanFixture";
import {
  resolveHandles,
  nameForHandle,
  matchedNamesFor,
} from "../../contactResolutionService";
import { getContactNameByAppleIdPrefix } from "../../db/attachmentDbService";

// ---------------------------------------------------------------------------
// Identities — all invented (FICTIONAL_NAMES in scripts/ci/check-fixture-pii.mjs;
// the Alvarez pair exists there PRECISELY for shared-identifier cases),
// example.com, reserved 555-01xx.
// ---------------------------------------------------------------------------
const USER_ID = "user-2757";
const OTHER_USER_ID = "user-2757-other";
const TX = "tx-2757-main";
const TX_OTHER = "tx-2757-other";

const CHRIS = { id: "c-2757-chris", name: "Chris Alvarez", phone: "+15035550150" };
const DANA = { id: "c-2757-dana", name: "Dana Alvarez", phone: "+15035550151" };
const ELLIOT = { id: "c-2757-elliot", name: "Elliot Alvarez" };

/** Held by CHRIS and DANA — the two-contact case. */
const SHARED_PHONE = "+15035550152";
const SHARED_PHONE_LABEL = "+1 (503) 555-0152";
/** Held by CHRIS, DANA and ELLIOT — the three-contact boundary. */
const TRIPLE_PHONE = "+15035550153";
const TRIPLE_PHONE_LABEL = "+1 (503) 555-0153";
/** Held by NOBODY — the no-contact boundary (BACKLOG-2463's number naming). */
const ORPHAN_PHONE = "+15035550154";

/** Attached to TX_OTHER only, and holding a handle a TX thread uses. */
const PAT = { id: "c-2757-pat", name: "Pat Riverton" };
/** Belongs to a DIFFERENT user entirely. */
const SAM = { id: "c-2757-sam", name: "Sam Rivers" };
/** The handle PAT (out of this deal) and CHRIS (a party) BOTH hold. */
const CONTESTED_PHONE = "+15035550155";
/** The handle only SAM (another user) holds. */
const OTHER_USER_PHONE = "+15035550156";

const OWNER_EMAIL = "owner-2757@example.com";

/**
 * Seed the whole world.
 *
 * `insertionOrder` decides which of the two shared-phone holders is written to
 * the database FIRST. Everything else is identical. That parameter is the entire
 * point of this suite: the measured pre-fix winner was the SECOND-inserted
 * contact, so an export run under both orderings must produce byte-identical
 * artifacts, and a resolver that still leans on row order cannot.
 */
function seedWorld(fx: ExportFixture, insertionOrder: "chris-first" | "dana-first"): void {
  fx.seedUser(USER_ID, OWNER_EMAIL, "Test User");
  fx.seedUser(OTHER_USER_ID, "other-2757@example.com", "Other User");
  fx.seedTransaction({ id: TX, userId: USER_ID, address: "1 Shared Line Rd" });
  fx.seedTransaction({ id: TX_OTHER, userId: USER_ID, address: "2 Other Deal Ave" });

  const chris = () =>
    fx.seedContact({
      id: CHRIS.id,
      userId: USER_ID,
      displayName: CHRIS.name,
      phones: [
        { phone: CHRIS.phone, isPrimary: true },
        { phone: SHARED_PHONE },
        { phone: TRIPLE_PHONE },
        { phone: CONTESTED_PHONE },
      ],
      emails: [{ email: "chris.alvarez@example.com", isPrimary: true }],
    });
  const dana = () =>
    fx.seedContact({
      id: DANA.id,
      userId: USER_ID,
      displayName: DANA.name,
      phones: [
        { phone: DANA.phone, isPrimary: true },
        { phone: SHARED_PHONE },
        { phone: TRIPLE_PHONE },
      ],
      emails: [{ email: "dana.alvarez@example.com", isPrimary: true }],
    });

  // THE MUTATION HANDLE. Pre-fix, whichever of these ran second won the label.
  if (insertionOrder === "chris-first") {
    chris();
    dana();
  } else {
    dana();
    chris();
  }

  fx.seedContact({
    id: ELLIOT.id,
    userId: USER_ID,
    displayName: ELLIOT.name,
    phones: [{ phone: TRIPLE_PHONE, isPrimary: true }],
  });

  // Out of THIS deal, but holds CONTESTED_PHONE alongside party Chris.
  fx.seedContact({
    id: PAT.id,
    userId: USER_ID,
    displayName: PAT.name,
    phones: [{ phone: CONTESTED_PHONE, isPrimary: true }],
  });

  // Another user's contact entirely.
  fx.seedContact({
    id: SAM.id,
    userId: OTHER_USER_ID,
    displayName: SAM.name,
    phones: [{ phone: OTHER_USER_PHONE, isPrimary: true }],
  });

  // Parties on THIS deal: Chris and Dana. Pat is a party on the OTHER deal.
  fx.attachContact({ transactionId: TX, contactId: CHRIS.id, createdAt: "2026-01-01 00:00:00" });
  fx.attachContact({ transactionId: TX, contactId: DANA.id, createdAt: "2026-01-01 00:00:01" });
  // Elliot is a party too, so TRIPLE_PHONE is a THREE-WAY AMBIGUITY and not a
  // scoping question. (Discovered by running this suite: with Elliot off the
  // deal, the transaction preference correctly reduced him away and the
  // three-contact boundary was silently measuring the two-contact one.)
  fx.attachContact({ transactionId: TX, contactId: ELLIOT.id, createdAt: "2026-01-01 00:00:03" });
  fx.attachContact({
    transactionId: TX_OTHER,
    contactId: PAT.id,
    createdAt: "2026-01-01 00:00:02",
  });

  // One thread per handle shape under test, each on its own day so thread
  // ordering (oldest first) is fixed and the index numbers are stable.
  const texts: Array<[string, string, string, string]> = [
    ["msg-shared", SHARED_PHONE, "2026-02-01 09:00:00", "thr-shared"],
    ["msg-triple", TRIPLE_PHONE, "2026-02-02 09:00:00", "thr-triple"],
    ["msg-chris", CHRIS.phone, "2026-02-03 09:00:00", "thr-chris"],
    ["msg-orphan", ORPHAN_PHONE, "2026-02-04 09:00:00", "thr-orphan"],
    ["msg-contested", CONTESTED_PHONE, "2026-02-05 09:00:00", "thr-contested"],
    ["msg-otheruser", OTHER_USER_PHONE, "2026-02-06 09:00:00", "thr-otheruser"],
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
}

async function runFolderExport(fx: ExportFixture): Promise<void> {
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
}

function textFilesOf(fx: ExportFixture): string[] {
  return fs.readdirSync(path.join(fx.outputDir, "texts")).sort();
}

// ===========================================================================
// LEG 1 — the artifact on disk, run twice under opposite insertion orders.
// ===========================================================================
describe("BACKLOG-2757 — the exported filename set does not depend on insertion order", () => {
  /**
   * The exact set, written out. Every entry is load-bearing:
   *
   *  - `text_001_1_503_555-0152.pdf` — TWO contacts share this line, so the
   *    file names the NUMBER and carries no date. Pre-fix this read
   *    `text_001_Dana_Alvarez_2026-02-01.pdf` under one insertion order and
   *    `text_001_Chris_Alvarez_2026-02-01.pdf` under the other.
   *  - `text_002_1_503_555-0153.pdf` — THREE contacts. Same rule; the boundary
   *    is swept, not sampled.
   *  - `text_003_Chris_Alvarez_2026-02-03.pdf` — ONE contact. Unchanged,
   *    including the date suffix. This is the collateral-damage control.
   *  - `text_004_1_503_555-0154_2026-02-04.pdf` — NO contact. BACKLOG-2463's
   *    number naming, and it KEEPS ITS DATE. Worth stating because it is the
   *    one place the two number-named cases differ: an unresolved thread is
   *    unchanged from what shipped, while an AMBIGUOUS thread follows the
   *    founder decision's literal `text_NNN_<number>.pdf`. Same segment, and
   *    deliberately not the same filename — one of these is old behaviour left
   *    alone, the other is a new rule.
   *  - `text_005_Chris_Alvarez_2026-02-05.pdf` — TWO contacts hold this handle,
   *    but only Chris is a party to this deal. Scoping resolves the ambiguity,
   *    so this thread is NOT ambiguous and keeps a name. (BACKLOG-2758.)
   *  - `text_006_1_503_555-0156_2026-02-06.pdf` — held only by ANOTHER USER's
   *    contact, so it resolves to nothing and lands in the unresolved case.
   *    (BACKLOG-2758.)
   */
  const EXPECTED_FILENAMES = [
    "text_001_1_503_555-0152.pdf",
    "text_002_1_503_555-0153.pdf",
    "text_003_Chris_Alvarez_2026-02-03.pdf",
    "text_004_1_503_555-0154_2026-02-04.pdf",
    "text_005_Chris_Alvarez_2026-02-05.pdf",
    "text_006_1_503_555-0156_2026-02-06.pdf",
  ];

  const runs: Record<string, { files: string[]; html: string[] }> = {};

  for (const order of ["chris-first", "dana-first"] as const) {
    describe(`insertion order: ${order}`, () => {
      let fx: ExportFixture;

      beforeAll(async () => {
        mockCapturedHtml.length = 0;
        fx = await createExportFixture();
        seedWorld(fx, order);
        await runFolderExport(fx);
        runs[order] = { files: textFilesOf(fx), html: [...mockCapturedHtml] };
      }, 120_000);

      afterAll(async () => {
        await fx.cleanup();
      });

      test("the EXACT filename set on disk is the decided one", () => {
        expect(runs[order].files).toEqual(EXPECTED_FILENAMES);
      });

      test("no person's surname appears in an ambiguous thread's filename", () => {
        // Belt to the exact-set brace: a future renaming that kept the set the
        // same length but reintroduced a name would already have failed above;
        // this states the PROPERTY the founder decision is about, so the
        // intent survives an edit to the expected list.
        const ambiguous = runs[order].files.filter(
          (f) => f.startsWith("text_001_") || f.startsWith("text_002_")
        );
        expect(ambiguous).toHaveLength(2);
        for (const f of ambiguous) {
          expect(f).not.toContain("Alvarez");
        }
      });
    });
  }

  test("MUTATION TARGET: both insertion orders produce byte-identical filenames", () => {
    // The defect in one line. Pre-fix these two arrays differed; the whole fix
    // is that they cannot. Mutation M1 (drop the sort in `namesForHandle`) reds
    // the label leg below, and M2 reds this one.
    expect(runs["chris-first"].files).toEqual(runs["dana-first"].files);
  });

  test("MUTATION TARGET: both insertion orders produce the same thread LABELS", () => {
    // Filenames could match while the labels still flipped, so the labels are
    // asserted as their own set — and as EXACT STRINGS, in declared order.
    const labelIn = (html: string[], needle: string): string[] =>
      html.filter((h) => h.includes(needle));

    for (const order of ["chris-first", "dana-first"] as const) {
      const html = runs[order].html;
      const twoWay = `${SHARED_PHONE_LABEL} — ${CHRIS.name} or ${DANA.name}`;
      const threeWay = `${TRIPLE_PHONE_LABEL} — ${CHRIS.name}, ${DANA.name} or ${ELLIOT.name}`;

      expect(labelIn(html, twoWay).length).toBeGreaterThan(0);
      expect(labelIn(html, threeWay).length).toBeGreaterThan(0);

      // The reverse orderings must NEVER appear — this is what "declared order"
      // buys, and asserting only the forward form would pass on a run that
      // emitted both.
      expect(labelIn(html, `${DANA.name} or ${CHRIS.name}`)).toEqual([]);
      expect(labelIn(html, `${ELLIOT.name}, `)).toEqual([]);
    }
  });
});

// ===========================================================================
// LEG 2 — the resolver, directly. Boundaries swept, scoping pinned.
// ===========================================================================
describe("BACKLOG-2757/2758 — handle resolution rules", () => {
  let fx: ExportFixture;

  beforeAll(async () => {
    fx = await createExportFixture();
    seedWorld(fx, "dana-first");
  }, 120_000);

  afterAll(async () => {
    await fx.cleanup();
  });

  const scope = { userId: USER_ID, transactionId: TX };

  test("boundary: TWO contacts on one handle -> both names, declared order", async () => {
    const r = await resolveHandles([SHARED_PHONE], USER_ID, scope);
    expect(matchedNamesFor(r, SHARED_PHONE)).toEqual([CHRIS.name, DANA.name]);
    expect(nameForHandle(r, SHARED_PHONE)).toBe(`${CHRIS.name} or ${DANA.name}`);
  });

  test("boundary: THREE contacts on one handle -> comma-then-or, declared order", async () => {
    const r = await resolveHandles([TRIPLE_PHONE], USER_ID, scope);
    expect(matchedNamesFor(r, TRIPLE_PHONE)).toEqual([CHRIS.name, DANA.name, ELLIOT.name]);
    expect(nameForHandle(r, TRIPLE_PHONE)).toBe(
      `${CHRIS.name}, ${DANA.name} or ${ELLIOT.name}`
    );
  });

  test("boundary: ONE contact holding TWO handles is NOT ambiguous on either", async () => {
    // Chris holds his own number and the shared one. His own must stay a plain
    // single name — the rule keys on contact identity, not on how many rows the
    // query returned. A "more than one row means ambiguous" implementation reds.
    const r = await resolveHandles([CHRIS.phone], USER_ID, scope);
    expect(matchedNamesFor(r, CHRIS.phone)).toEqual([CHRIS.name]);
    expect(nameForHandle(r, CHRIS.phone)).toBe(CHRIS.name);
  });

  test("boundary: a handle NO contact holds resolves to nothing", async () => {
    const r = await resolveHandles([ORPHAN_PHONE], USER_ID, scope);
    expect(matchedNamesFor(r, ORPHAN_PHONE)).toEqual([]);
    expect(nameForHandle(r, ORPHAN_PHONE)).toBeUndefined();
  });

  test("BACKLOG-2758 scoping: an out-of-transaction contact cannot win a share of the label", async () => {
    // CONTESTED_PHONE is held by Chris (a party to TX) and Pat (a party to a
    // DIFFERENT deal). Without the transaction preference this is a two-name
    // ambiguity and the thread loses its name; with it, the party wins outright.
    //
    // Asserted as the exact NAME SET, not as "Pat is absent": a resolver that
    // returned nobody would also satisfy an absence check.
    const r = await resolveHandles([CONTESTED_PHONE], USER_ID, scope);
    expect(matchedNamesFor(r, CONTESTED_PHONE)).toEqual([CHRIS.name]);
    expect(nameForHandle(r, CONTESTED_PHONE)).toBe(CHRIS.name);
  });

  test("BACKLOG-2758 scoping: with NO transaction named, the out-of-deal contact is a peer again", async () => {
    // The other half of the same claim — proof the leg above measures the
    // transaction preference and not some unrelated filter that drops Pat
    // always. Both names appear the moment there is no deal to prefer.
    const r = await resolveHandles([CONTESTED_PHONE], USER_ID, { userId: USER_ID });
    expect(matchedNamesFor(r, CONTESTED_PHONE)).toEqual([CHRIS.name, PAT.name]);
  });

  test("BACKLOG-2758 scoping: ANOTHER USER's contact never resolves, with or without a transaction", async () => {
    for (const s of [scope, { userId: USER_ID }]) {
      const r = await resolveHandles([OTHER_USER_PHONE], USER_ID, s);
      expect(matchedNamesFor(r, OTHER_USER_PHONE)).toEqual([]);
      expect(nameForHandle(r, OTHER_USER_PHONE)).toBeUndefined();
    }
  });

  test("BACKLOG-2758 scoping: that same handle DOES resolve for the user who owns it", async () => {
    // Anti-vacuity for the leg above: without this, deleting the contact from
    // the fixture would make the cross-user assertion pass for the wrong reason.
    const r = await resolveHandles([OTHER_USER_PHONE], OTHER_USER_ID, {
      userId: OTHER_USER_ID,
    });
    expect(matchedNamesFor(r, OTHER_USER_PHONE)).toEqual([SAM.name]);
  });

  test("BACKLOG-2758 determinism: the Apple-ID prefix resolver declares its winner", async () => {
    // Two contacts hold emails starting with the same local-part prefix. The
    // statement is `LIKE ? || '@%' LIMIT 1`; before this fix it had no ORDER BY
    // and returned whatever SQLite offered first. The declared winner is the
    // alphabetically first email, tie-broken on contact id — a rule, checkable,
    // and unmoved by a vacuum or a new index.
    fx.seedContact({
      id: "c-2757-ap-b",
      userId: USER_ID,
      displayName: "Bo Prefix",
      emails: [{ email: "shareprefix@zeta.example.com", isPrimary: true }],
    });
    fx.seedContact({
      id: "c-2757-ap-a",
      userId: USER_ID,
      displayName: "Avery Prefix",
      emails: [{ email: "shareprefix@alpha.example.com", isPrimary: true }],
    });

    // Inserted Bo FIRST and Avery SECOND — so a row-order winner would be one of
    // them for reasons that are not a rule. The declared winner is Avery's,
    // because "shareprefix@alpha…" sorts before "shareprefix@zeta…".
    expect(getContactNameByAppleIdPrefix("shareprefix", { userId: USER_ID })).toEqual({
      contact_id: "c-2757-ap-a",
      email: "shareprefix@alpha.example.com",
      display_name: "Avery Prefix",
    });

    // And it is scoped: the same prefix held only by another user resolves to
    // nothing for this one.
    fx.seedContact({
      id: "c-2757-ap-other",
      userId: OTHER_USER_ID,
      displayName: "Otherling Prefix",
      emails: [{ email: "otherprefix@alpha.example.com", isPrimary: true }],
    });
    expect(
      getContactNameByAppleIdPrefix("otherprefix", { userId: USER_ID })
    ).toBeUndefined();
    expect(getContactNameByAppleIdPrefix("otherprefix", { userId: OTHER_USER_ID })).toEqual({
      contact_id: "c-2757-ap-other",
      email: "otherprefix@alpha.example.com",
      display_name: "Otherling Prefix",
    });
  });
});
