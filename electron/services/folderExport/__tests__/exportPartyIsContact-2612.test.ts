/**
 * @jest-environment node
 *
 * BACKLOG-2612 — THE EXPORT PARTY UNIT IS THE CONTACT.
 *
 * Characterization suite: pins that every writer on the folder-export path
 * resolves a transaction party through `transaction_contacts.contact_id →
 * contacts` (the contact — not any grouping above it), and that the exported
 * VALUE SET for a party is exactly that contact's own values. A party-identity
 * assertion alone would keep passing while a party's value set silently became
 * a union across contacts (BACKLOG-2676 decision), so the discriminating
 * fixture here is TWO CONTACTS SHARING AN IDENTIFIER — the exact shape any
 * person-style grouping would wrongly merge — and every value assertion is an
 * exact set, never a count.
 *
 * This suite is TESTS ONLY. Where current behaviour is surprising, it is
 * pinned as-is with a comment naming the discrepancy; changing production
 * behaviour is out of scope (see the findings list on BACKLOG-2612 in
 * pm_comments).
 *
 * CONTROLS (mutations run manually, results recorded on BACKLOG-2612 /
 * the PR body; every mutation names the full file path from repo root):
 *   C1  party ID set — drop `WHERE tc.transaction_id = ?` in
 *       electron/services/db/transactionContactDbService.ts → RED (party from
 *       the OTHER seeded transaction appears in the set).
 *   C2  shared-identifier discrimination — dedupe parties on `contact_phone`
 *       in electron/services/folderExport/summaryHelpers.ts
 *       generateContactsSection → RED on the exact name set; and the
 *       union-expectation half: flip the expected value set to the union of
 *       both contacts → RED (proves the assertion separates own-values from
 *       union).
 *   C4  anti-vacuity — make getTransactionContactsWithRoles return [] → RED
 *       here (the artifact must NAME both parties; without this leg every
 *       other assertion could pass on an export that short-circuited).
 *   C5  tombstone — add `AND c.removed_at IS NULL` to the party query WHERE →
 *       RED on the exact ID set (a tombstoned-but-attached party must export
 *       complete; that is written policy, electron/services/db/
 *       contactTombstoneSql.ts:32-37, not a bug).
 *   A1  filenames — make threadContactLabel return a constant → RED on the
 *       exact filename set.
 *   A3  email-PDF raw handles — replace `email.sender` with a constant in
 *       electron/services/folderExport/emailExportHelpers.ts → RED.
 *
 * RUNNER (real native driver — plain `npx jest` cannot load it):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/folderExport/__tests__/exportPartyIsContact-2612.test.ts
 */

import path from "path";
import fs from "fs";

// ---------------------------------------------------------------------------
// Electron mock: the shared mock plus a BrowserWindow that CAPTURES the HTML
// handed to loadFile (htmlToPdf unlinks the temp file in `finally`, so the
// content must be read inside the stub, not after) and stubs printToPDF.
// ---------------------------------------------------------------------------
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
        printToPDF: async () => Buffer.from("%PDF-1.4\n% BACKLOG-2612 stub\n"),
        send: () => undefined,
      };
    }

    async loadFile(file: string): Promise<void> {
      mockCapturedHtml.push(fsInner.readFileSync(file, "utf8"));
      // combinedHtmlToPdf resolves on did-finish-load; fire it like Chromium would.
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

// The macOS AddressBook must never be read in a test: getContactNames is
// stubbed to an EMPTY map, so every name that appears in an artifact here is
// proven to come from the sqlite `contacts` store, not from the Mac.
jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(async () => ({ success: true, contactMap: {} })),
}));

import { createExportFixture, type ExportFixture } from "./helpers/exportCaptureFixture2612";
import transactionService from "../../transactionService/transactionService";
import folderExportService from "../folderExportService";
import { deleteContact } from "../../db/contactDbService";
// BACKLOG-2771: plans are built by the REAL resolver, never by hand.
import { testExportPlan } from "../../__tests__/helpers/exportPlanFixture";

// ---------------------------------------------------------------------------
// Fixture identities — all invented (FICTIONAL_NAMES in
// scripts/ci/check-fixture-pii.mjs; the Alvarez pair exists there PRECISELY
// for two-people-sharing-an-identifier cases), example.com, reserved 555-01xx.
// ---------------------------------------------------------------------------
const USER_ID = "user-2612";
const TX = "tx-2612-main";
const TX_OTHER = "tx-2612-other"; // control C1's tripwire: its party must never leak into TX artifacts

const CHRIS = {
  id: "c-2612-chris",
  name: "Chris Alvarez",
  primaryEmail: "chris.alvarez@example.com",
  secondEmail: "chris.a.work@example.com",
  phone: "+15035550140",
};
const DANA = {
  id: "c-2612-dana",
  name: "Dana Alvarez",
  primaryEmail: "dana.alvarez@example.com",
  phone: "+15035550141",
};
/** The SHARED identifier both contacts hold — the person-union shape. */
const SHARED_PHONE = "+15035550142";
const SHARED_EMAIL = "shared.alvarez@example.com";
/** Attached to TX_OTHER only. */
const PAT = {
  id: "c-2612-pat",
  name: "Pat Riverton",
  primaryEmail: "pat.riverton@example.com",
  phone: "+15035550143",
};

const T0 = "2026-01-05 10:00:00";
const T1 = "2026-01-05 10:01:00";

function seedScenario(fx: ExportFixture, opts: { txStatus?: string } = {}): void {
  fx.seedUser(USER_ID, "owner-2612@example.com", "Test User");
  fx.seedTransaction({
    id: TX,
    userId: USER_ID,
    address: "114 Cypress Ave",
    status: opts.txStatus ?? "active",
    startedAt: "2026-01-01 00:00:00",
    closedAt: "2026-03-01 00:00:00",
  });
  fx.seedTransaction({
    id: TX_OTHER,
    userId: USER_ID,
    address: "77 Juniper Ct",
    status: "active",
    startedAt: "2026-01-01 00:00:00",
    closedAt: "2026-03-01 00:00:00",
  });

  // SHARED phone is PRIMARY on both contacts: the COALESCE projection in
  // getTransactionContactsWithRoles then projects the SAME phone for two
  // DIFFERENT parties — the sharpest available person-union bait. Emails are
  // each contact's own; the shared email is deliberately NON-primary so the
  // projected party line must carry the contact's own primary address.
  fx.seedContact({
    id: CHRIS.id,
    userId: USER_ID,
    displayName: CHRIS.name,
    emails: [
      { email: CHRIS.primaryEmail, isPrimary: true },
      { email: CHRIS.secondEmail },
      { email: SHARED_EMAIL },
    ],
    phones: [{ phone: SHARED_PHONE, isPrimary: true }, { phone: CHRIS.phone }],
  });
  fx.seedContact({
    id: DANA.id,
    userId: USER_ID,
    displayName: DANA.name,
    emails: [{ email: DANA.primaryEmail, isPrimary: true }, { email: SHARED_EMAIL }],
    phones: [{ phone: SHARED_PHONE, isPrimary: true }, { phone: DANA.phone }],
  });
  fx.seedContact({
    id: PAT.id,
    userId: USER_ID,
    displayName: PAT.name,
    emails: [{ email: PAT.primaryEmail, isPrimary: true }],
    phones: [{ phone: PAT.phone, isPrimary: true }],
  });

  fx.attachContact({ transactionId: TX, contactId: CHRIS.id, role: "buyer", isPrimary: true, createdAt: T0 });
  fx.attachContact({ transactionId: TX, contactId: DANA.id, role: "buyer", createdAt: T1 });
  fx.attachContact({ transactionId: TX_OTHER, contactId: PAT.id, role: "seller", createdAt: T0 });

  // Communications — seeded as real `emails`/`messages` rows and hydrated by
  // the REAL projection (getCommunicationsWithMessages), so the Communication
  // shape the writers receive is produced, not imitated.
  fx.seedLinkedEmail({
    id: "em-2612-1",
    userId: USER_ID,
    transactionId: TX,
    sender: CHRIS.primaryEmail,
    recipients: "owner-2612@example.com",
    subject: "Inspection scheduling",
    sentAt: "2026-01-10 09:00:00",
    threadId: "thr-em-1",
  });
  fx.seedLinkedEmail({
    id: "em-2612-2",
    userId: USER_ID,
    transactionId: TX,
    sender: DANA.primaryEmail,
    recipients: "owner-2612@example.com",
    subject: "Closing docs",
    sentAt: "2026-01-11 09:00:00",
    threadId: "thr-em-2",
  });
  // Text from the SHARED phone: the handle two contacts both hold.
  fx.seedLinkedText({
    id: "msg-2612-1",
    userId: USER_ID,
    transactionId: TX,
    sender: SHARED_PHONE,
    recipients: "owner-2612@example.com",
    body: "Keys are at the office",
    sentAt: "2026-01-12 09:00:00",
    threadId: "thr-txt-shared",
    withAttachmentFilename: "keys-photo.png",
  });
  // Text from a handle held by ONE contact.
  fx.seedLinkedText({
    id: "msg-2612-2",
    userId: USER_ID,
    transactionId: TX,
    sender: CHRIS.phone,
    recipients: "owner-2612@example.com",
    body: "See you at noon",
    sentAt: "2026-01-13 09:00:00",
    threadId: "thr-txt-chris",
  });
}

async function runFolderExport(fx: ExportFixture): Promise<void> {
  // Armed across getTransactionDetails AND the writer: the export handler
  // (electron/handlers/transactionExportHandlers.ts, transactions:export-folder)
  // composes exactly these two — the party resolution happens inside
  // getTransactionDetails, so the capture must cover it.
  fx.arm();
  try {
    const details = await transactionService.getTransactionDetails(TX);
    if (!details) throw new Error("fixture transaction not found");
    await folderExportService.exportTransactionToFolder(details,
        testExportPlan(details.communications ?? [], { contentType: "both", attachmentType: "all" }),
        {
      // Required by FolderExportOptions (folderExportService.ts:115) though
      // nothing under electron/services/folderExport/ reads it — the writer
      // takes the transaction from `details`. Passed for type correctness; it
      // selects nothing, so it cannot alter what this suite measures.
      transactionId: TX,
      outputPath: fx.outputDir,
        }
      );
  } finally {
    fx.disarm();
  }
}

/** The Contacts section of the summary PDF's HTML, located by its heading. */
function summaryHtml(): string {
  const html = mockCapturedHtml.find((h) => h.includes("<h3>Contacts"));
  if (!html) throw new Error("summary HTML not captured — export short-circuited (control C4)");
  return html;
}

/** Exact ordered list of party names rendered in the Contacts section. */
function partyNames(html: string): string[] {
  return [...html.matchAll(/<span class="contact-name">([^<]*)<\/span>/g)].map((m) => m[1]);
}

/** The single contact-item block whose name is `name` (throws unless exactly one). */
function partyLine(html: string, name: string): string {
  const blocks = [...html.matchAll(/<div class="contact-item">[\s\S]*?<\/div>\s*<\/div>/g)].map((m) => m[0]);
  const mine = blocks.filter((b) => b.includes(`<span class="contact-name">${name}</span>`));
  if (mine.length !== 1) {
    throw new Error(`expected exactly one party line for ${name}, found ${mine.length}`);
  }
  return mine[0];
}

/**
 * The EXACT list of contact-detail values (emails and phones) rendered for one
 * party — the whole value set the filed PDF shows for them.
 *
 * This is the assertion that separates "the party is the right contact" from
 * "the party's VALUES are that contact's own". A party-identity check passes
 * unchanged while a party's value set silently becomes a union across contacts
 * (BACKLOG-2676); an exact list does not. `generateContactsSection` renders
 * `<div class="contact-details"><span>email</span><span>phone</span></div>`,
 * so extracting those spans yields precisely what a reader sees.
 */
function partyDetailValues(html: string, name: string): string[] {
  const details = partyLine(html, name).match(
    /<div class="contact-details">([\s\S]*?)<\/div>/,
  )?.[1];
  if (details === undefined) return [];
  return [...details.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
}

/**
 * The WHOLE Contacts section — the heading plus EVERY party block — found by
 * balanced `<div>` matching over `contact-list`.
 *
 * It THROWS on any miss, and it never falls back to the full document.
 *
 * Both properties are here because their absence shipped a broken control in
 * PR #2328 and SR caught it. The original extractor was
 * `html.match(/<h3>Contacts[\s\S]*?<\/div>\s*<\/div>\s*$/m)?.[0] ?? html`. The
 * lazy quantifier stopped at the first `</div>\s*</div>` at end-of-line — which
 * closes the FIRST contact block — so it captured 318 of 5507 characters and
 * the comparison never saw the second party at all. The `?? html` fallback then
 * meant a total miss would silently degrade into comparing entire documents,
 * which is a different assertion wearing this one's name.
 *
 * A regex that quietly captures the wrong region produces a green test that
 * cannot fail. Throwing is the point: a miss must be loud.
 */
function contactsSection(html: string): string {
  const headingIdx = html.indexOf("<h3>Contacts");
  if (headingIdx === -1) {
    throw new Error("Contacts heading not found — the export did not render a party section");
  }
  const listIdx = html.indexOf('<div class="contact-list">', headingIdx);
  if (listIdx === -1) {
    throw new Error("contact-list container not found after the Contacts heading");
  }

  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = listIdx;
  let depth = 0;
  let end = -1;
  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    } else {
      depth += 1;
    }
  }
  if (end === -1) {
    throw new Error("contact-list container is unbalanced — cannot delimit the Contacts section");
  }
  return html.slice(headingIdx, end);
}

describe("BACKLOG-2612 — the export party unit is the contact", () => {
  describe("live parties (two contacts sharing an identifier)", () => {
    let fx: ExportFixture;

    beforeAll(async () => {
      mockCapturedHtml.length = 0;
      fx = await createExportFixture();
      seedScenario(fx);
      await runFolderExport(fx);
    }, 120_000);

    afterAll(async () => {
      await fx.cleanup();
    });

    test("C4 anti-vacuity: the export RAN the tc→contacts resolution and the artifact NAMES both parties", () => {
      // Positive leg first — without it, every absence assertion below is
      // decoration: an export that short-circuits before resolving anyone
      // would pass them all.
      const partySql = fx.captured.filter(
        (s) => s.sql.includes("FROM transaction_contacts tc") && s.sql.includes("JOIN contacts c"),
      );
      expect(partySql.length).toBeGreaterThan(0);
      // Exact name set, not toContain: the union/collapse failure holds counts
      // steady while changing contents.
      expect(partyNames(summaryHtml())).toEqual([CHRIS.name, DANA.name]);
    });

    test("C1: the party set is exactly the two attached contacts — the other transaction's party never leaks", () => {
      const names = partyNames(summaryHtml());
      expect(names).toEqual([CHRIS.name, DANA.name]);
      expect(names).not.toContain(PAT.name);
    });

    test("C2 value set: each party line renders EXACTLY that contact's own projected values — an exact list, so a union across contacts cannot pass", () => {
      const html = summaryHtml();

      // THE discriminating assertion of this suite. Both contacts hold
      // SHARED_PHONE as primary, so the two parties legitimately project the
      // same phone — the shape a person-style grouping would take as evidence
      // that these are one party and merge their value sets.
      //
      // The projection is primary-else-first, i.e. ONE email and ONE phone per
      // party (getTransactionContactsWithRoles' COALESCE subselects), so the
      // exact rendered list is [own primary email, own primary phone]. If any
      // site ever unioned values across contacts, each list would grow to carry
      // the other contact's addresses and this equality goes red — which a
      // `toContain`/`not.toContain` pair states less completely and an identity
      // assertion does not state at all.
      //
      // Union-simulation control run in BOTH halves (expectation flipped to the
      // union, observed RED; restored, observed GREEN) — output pasted on
      // BACKLOG-2612 and in the PR body.
      expect(partyDetailValues(html, CHRIS.name)).toEqual([CHRIS.primaryEmail, SHARED_PHONE]);
      expect(partyDetailValues(html, DANA.name)).toEqual([DANA.primaryEmail, SHARED_PHONE]);

      // Stated explicitly because the equality above is only as strong as the
      // extractor: the non-primary addresses exist on these contacts in the
      // fixture and are deliberately absent from the filed line. BACKLOG-2676
      // (deferred) widens the projection to every value a contact holds; when
      // it lands, the lists above must be edited — a VISIBLE change, not a
      // silent pass.
      const bothLines = partyLine(html, CHRIS.name) + partyLine(html, DANA.name);
      expect(bothLines).not.toContain(CHRIS.secondEmail);
      expect(bothLines).not.toContain(SHARED_EMAIL);
      expect(bothLines).not.toContain(CHRIS.phone);
      expect(bothLines).not.toContain(DANA.phone);
    });

    test("6a: no SQL the export executed filters on contacts.removed_at", () => {
      // Written policy (electron/services/db/contactTombstoneSql.ts:32-37):
      // name resolution for historical communications keeps resolving removed
      // contacts. The party query filters tc.removed_at (off-this-deal) and
      // deliberately does NOT filter c.removed_at; a "helpful cleanup" adding
      // that filter would silently drop every merged-away party from every
      // re-export. This leg is falsifiable: mutation C5 reds it.
      const partySql = fx.captured.filter((s) => s.sql.includes("FROM transaction_contacts tc"));
      expect(partySql.length).toBeGreaterThan(0);
      for (const s of partySql) {
        expect(s.sql).toContain("tc.removed_at IS NULL");
      }
      // `(?<![A-Za-z_])c\.` so `tc.removed_at IS NULL` (the junction filter,
      // which IS applied and correct) does not match as `…c.removed_at…`.
      const filteringStatements = fx.captured.filter((s) =>
        /(?<![A-Za-z_])(c|contacts)\.removed_at\s+IS\s+NULL/i.test(s.sql),
      );
      expect(filteringStatements.map((s) => s.sql)).toEqual([]);
    });

    test("A1: party names land in FILENAMES on disk — exact filename set, shared handle labels ONE of the two contacts", () => {
      const textFiles = fs.readdirSync(path.join(fx.outputDir, "texts")).sort();

      // Threads are keyed by DATE, not by the resolved name, so these
      // assertions cannot flake on the shared-handle winner (which is
      // row-order-arbitrary — no ORDER BY in either resolver stack).
      const sharedThreadFile = textFiles.filter((f) => f.endsWith("_2026-01-12.pdf"));
      const chrisThreadFile = textFiles.filter((f) => f.endsWith("_2026-01-13.pdf"));
      expect(sharedThreadFile).toHaveLength(1);
      expect(chrisThreadFile).toHaveLength(1);

      // The single-holder thread is DETERMINISTIC: Chris's own phone, Chris's
      // name in the filename on disk.
      expect(chrisThreadFile[0]).toBe("text_002_Chris_Alvarez_2026-01-13.pdf");

      // The shared-phone thread is labelled with ONE holder's CONTACT name —
      // never a person-style merged label, never the raw phone. Winner is
      // set-membership; the measured winner at this SHA is recorded in the PR
      // body as characterization, not asserted (asserting it would
      // manufacture a flake out of an order the code does not guarantee).
      const winner = ["Chris_Alvarez", "Dana_Alvarez"].filter((n) => sharedThreadFile[0].includes(n));
      expect(winner).toHaveLength(1);
      expect(sharedThreadFile[0]).toBe(`text_001_${winner[0]}_2026-01-12.pdf`);

      // Exact set: nothing else was written to texts/.
      expect(textFiles).toEqual([sharedThreadFile[0], chrisThreadFile[0]]);
    });

    test("A2: the attachment manifest resolves the party by NOTHING — raw handle, no contact name", () => {
      const manifestPath = path.join(fx.outputDir, "attachments", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        attachments: Array<Record<string, unknown>>;
      };
      const entries = manifest.attachments.filter((e) => String(e.originalMessage ?? "").length > 0);
      expect(entries.length).toBeGreaterThan(0);
      const originals = entries.map((e) => String(e.originalMessage));
      // The text attachment's originalMessage carries the RAW sender handle
      // (resolver C — no resolution at all). Pinned so that the day someone
      // wires a resolver into the manifest, this sweep sees it. Interaction
      // with BACKLOG-2488 ("Unknown" on export paths) noted there.
      expect(originals.some((o) => o.includes(SHARED_PHONE))).toBe(true);
      for (const o of originals) {
        expect(o).not.toContain(CHRIS.name);
        expect(o).not.toContain(DANA.name);
      }
    });

    test("A3: email thread PDFs carry RAW addresses, not contact names", () => {
      const emailHtml = mockCapturedHtml.filter((h) => h.includes("Inspection scheduling"));
      expect(emailHtml.length).toBeGreaterThan(0);
      for (const h of emailHtml) {
        // From-lines are the raw `emails.sender` column (resolver C). The
        // sender's contact display name must NOT appear as the From identity.
        expect(h).toContain(CHRIS.primaryEmail);
      }
      // The email-thread renderer performs no contacts lookup at all
      // (emailExportHelpers.ts) — so no email HTML names the sender's contact.
      const emailOnlyHtml = emailHtml.filter((h) => !h.includes("<h3>Contacts"));
      for (const h of emailOnlyHtml) {
        expect(h).not.toContain(CHRIS.name);
        expect(h).not.toContain(DANA.name);
      }
    });

    test("shared-handle characterization: thread grouping merges by phone tail — one thread, one winner label", () => {
      // Two contacts hold SHARED_PHONE. The thread key is the sorted set of
      // normalized participant phones (textExportHelpers.getThreadKey), so the
      // shared handle produces ONE conversation PDF under ONE winner's name —
      // a party collapse in the artifact that exists TODAY, with no person
      // layer involved. Pinned as-is; reported as a finding on BACKLOG-2612,
      // not fixed here.
      const textFiles = fs.readdirSync(path.join(fx.outputDir, "texts"));
      const sharedThreadFiles = textFiles.filter((f) => f.endsWith("_2026-01-12.pdf"));
      expect(sharedThreadFiles).toHaveLength(1);
    });
  });

  describe("tombstoned-but-attached party (control C5)", () => {
    let fx: ExportFixture;

    beforeAll(async () => {
      mockCapturedHtml.length = 0;
      fx = await createExportFixture();
      seedScenario(fx);
      // The REAL producer, not a hand-set removed_at: deleteContact writes the
      // tombstone and leaves every transaction role untouched (its docblock
      // states exactly this property).
      await deleteContact(DANA.id, "user_deleted");
      await runFolderExport(fx);
    }, 120_000);

    afterAll(async () => {
      await fx.cleanup();
    });

    test("C5: the tombstoned party exports COMPLETE — present in the exact party set with her own values", () => {
      const html = summaryHtml();
      expect(partyNames(html)).toEqual([CHRIS.name, DANA.name]);
      // Her OWN values, by exact rendered list — identical to the live case.
      // A tombstone changes visibility in Clients & Contacts; it does not
      // change what the audit says about a party who was on the deal.
      expect(partyDetailValues(html, DANA.name)).toEqual([DANA.primaryEmail, SHARED_PHONE]);
      expect(partyDetailValues(html, CHRIS.name)).toEqual([CHRIS.primaryEmail, SHARED_PHONE]);
    });

    test("C5: no marker distinguishes the tombstoned line — pinned CURRENT behaviour", () => {
      // The party query fetches `contact_removed_at` and the renderer never
      // reads it, so a tombstoned party's line is indistinguishable from a live
      // one. That is what this pins, and all it pins.
      //
      // Scope, stated honestly: this fixture is a PLAIN tombstone with no
      // merge-ledger row, and this transaction is 'active'. Founder decision O2
      // (a "merged into …" marker on a CLOSED deal) therefore cannot be
      // observed here at all. The marker is asserted absent at BOTH statuses in
      // the "PLAIN TOMBSTONE renders identically" block below — and even there,
      // only for a plain tombstone. BACKLOG-2369 must bring its own
      // merged-party fixture; neither assertion is a substitute for one.
      const html = summaryHtml();
      expect(html).not.toContain("merged into");
      expect(html).not.toContain("archived");
    });

    test("C5: her handles still resolve to her name in filenames (removal does not redact history)", () => {
      const textFiles = fs.readdirSync(path.join(fx.outputDir, "texts")).sort();
      expect(textFiles).toHaveLength(2);
      // Both threads still carry a resolved contact name, tombstone or not.
      for (const f of textFiles) {
        expect(f.includes("Chris_Alvarez") || f.includes("Dana_Alvarez")).toBe(true);
      }
    });
  });

  describe("a PLAIN TOMBSTONE renders identically at every transaction status", () => {
    // WHAT THIS PINS, stated at exactly the strength it has.
    //
    // The fixture's leftover party is a plain `deleteContact` tombstone with NO
    // MERGE-LEDGER ROW, because no merge mechanism exists on develop today.
    // So this block pins one thing: a tombstoned-but-attached contact renders
    // complete, unmarked, and byte-identically whether the deal is 'active' or
    // 'closed'.
    //
    // WHAT IT DOES NOT PIN. The founder's 13 Aug decisions (O1: the survivor
    // takes over on a non-closed deal; O2: the archived line on a closed deal
    // carries a "merged into …" marker) describe post-BACKLOG-2369 behaviour
    // keyed on a MERGED party. If 2369 branches on the merge-ledger row — the
    // natural implementation, and the only one that can distinguish "merged
    // away" from "deleted from the address book" — then a CORRECT 2369 leaves
    // this block green, legitimately, because this fixture has no ledger row.
    //
    // **BACKLOG-2369 must bring its own merged-party fixture.** This block is
    // not a substitute for one, and must not be read as covering O1 or O2.
    //
    // What IS caught here today: any change that makes a plain tombstone render
    // differently by status, or that starts marking a plain tombstone. The O1
    // half is separately caught by C5's exact party-name-set assertion above
    // (dropping the leftover's line reds it) — that is the assertion doing the
    // work, NOT this status comparison.
    let active: string;
    let closed: string;

    beforeAll(async () => {
      for (const status of ["active", "closed"] as const) {
        mockCapturedHtml.length = 0;
        const fx = await createExportFixture();
        seedScenario(fx, { txStatus: status });
        await deleteContact(DANA.id, "user_deleted");
        await runFolderExport(fx);
        // Whole section, and it throws rather than falling back — see
        // contactsSection's docblock for the control this replaces.
        const section = contactsSection(summaryHtml());
        if (status === "active") active = section;
        else closed = section;
        await fx.cleanup();
      }
    }, 240_000);

    test("the compared region actually contains BOTH parties (extractor self-check)", () => {
      // Without this, the comparison below is worth whatever the extractor
      // happened to capture. The shipped-and-rejected version captured 318 of
      // 5507 characters — the first party only — so the tombstoned party was
      // never in the compared region and no change to her line could fail it.
      for (const section of [active, closed]) {
        expect(section).toBeTruthy();
        expect(section).toContain(CHRIS.name);
        expect(section).toContain(DANA.name);
      }
    });

    test("the whole Contacts section is byte-identical at status='active' and status='closed'", () => {
      expect(active).toEqual(closed);
    });

    test("no merged-away marker on the tombstoned line at EITHER status", () => {
      // Asserted against the CLOSED section too, not only the open case.
      // 'closed' is the status under which founder decision O2 calls for the
      // marker, so an implementation that renders it there must red here.
      for (const section of [active, closed]) {
        expect(section).not.toContain("merged into");
        expect(section).not.toContain("archived");
      }
    });
  });
});
