/**
 * @jest-environment node
 *
 * BACKLOG-2758 — WHAT THE TRANSACTION SCOPE ACTUALLY DOES, over a real database.
 *
 * ===========================================================================
 * THE DEFECT, AND WHY THE ASYMMETRY IS THE POINT
 * ===========================================================================
 * The scoping fix shipped on the EXPORT path only. The in-app path could not
 * carry a transaction id at all — the IPC contract had no parameter for one — so
 * `scope?.transactionId ?? null` was always null, nothing was ever marked
 * `is_transaction_linked`, and `namesForHandle`'s
 * `const scoped = linked.length > 0 ? linked : matches` always fell through to
 * ALL matches. A number held by two saved contacts kept reading "A or B" on the
 * Texts tab after the user unlinked one of them, while the export named only the
 * remaining party.
 *
 * This file pins what the scope MEANS: the same handle, the same database, the
 * same resolver, resolved with the argument tuples the three renderer call sites
 * now actually send — and it must produce DIFFERENT answers for the tab and for
 * the picker. That difference is deliberate and founder-ratified:
 *
 *   - The Texts tab and the removed-threads section show threads ALREADY on the
 *     deal. A linked contact is the party; an unlinked one is not entitled to a
 *     share of the label. They pass `{ transactionId }`.
 *   - The attach picker shows threads NOT yet on the deal. Preferring the deal's
 *     contact there would name a shared line after a party before anyone decided
 *     the thread belongs to the deal — a guess presented as fact, which is the
 *     same defect pointed the other way. It passes `userId` only.
 *
 * A "consistency fix" that threads the id into the picker must red here.
 *
 * ===========================================================================
 * WHAT THIS FILE DOES NOT COVER
 * ===========================================================================
 * That the HANDLER builds these tuples is a different seam, pinned in
 * `electron/handlers/__tests__/resolveHandlesScope-2758.test.ts`. This file
 * would stay green if the handler stopped sending the scope; that one would stay
 * green if the scope stopped meaning anything. Both are required.
 *
 * ===========================================================================
 * CONTROLS — MEASURED. `--bail=0` always; jest.config.js sets `bail: 1`, so any
 * count taken without it is a FLOOR and cannot be compared to another.
 * ===========================================================================
 *   S1  THE DEFECT ITSELF — resolve the tab's tuple with NO transactionId (what
 *       the in-app path did before this fix).
 *       -> Reds the tab legs: the unlinked contact takes a share of the label.
 *
 *   S2  THE ASYMMETRY — give the picker's tuple a transactionId (the "consistency
 *       fix" this file exists to forbid).
 *       -> Reds the picker leg.
 *
 *   Both counts are recorded in the PR body, measured with `--bail=0`.
 *
 * RUNNER — the real native sqlite driver; plain `npx jest` cannot load it:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/__tests__/inAppHandleScope-2758.test.ts
 */

jest.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const base = jest.requireActual("../../../tests/__mocks__/electron.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osInner = require("os");
  return {
    ...base,
    app: {
      ...base.app,
      getPath: (name: string) => (name === "temp" ? osInner.tmpdir() : base.app.getPath(name)),
    },
  };
});

// The macOS AddressBook must never answer here: stubbed EMPTY, so every name
// that appears below is proven to come from the sqlite `contacts` store and not
// from a machine-local address book that CI does not have.
jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(async () => ({ success: true, contactMap: {} })),
}));

import {
  createExportFixture,
  type ExportFixture,
} from "../folderExport/__tests__/helpers/exportCaptureFixture2612";
import { resolveHandles, nameForHandle, matchedNamesFor } from "../contactResolutionService";

// ---------------------------------------------------------------------------
// Identities — all invented (FICTIONAL_NAMES in scripts/ci/check-fixture-pii.mjs),
// example.com, reserved-for-fiction 555-01xx. None refers to anyone.
// ---------------------------------------------------------------------------
const USER_ID = "user-2758-inapp";
const OTHER_USER_ID = "user-2758-other";
const TX = "tx-2758-inapp";
const TX_OTHER = "tx-2758-other";

const CHRIS = { id: "c-2758-chris", name: "Chris Alvarez" };
const DANA = { id: "c-2758-dana", name: "Dana Alvarez" };
/** A party to a DIFFERENT deal — the "duplicate contact" of the founder's report. */
const PAT = { id: "c-2758-pat", name: "Pat Riverton" };
/** Belongs to another user entirely. */
const SAM = { id: "c-2758-sam", name: "Robin Marsh" };

/** Held by CHRIS (a party to TX) and PAT (not a party to TX). THE case. */
const CONTESTED_PHONE = "+15035550155";
/** Held by CHRIS and DANA, BOTH parties to TX — ambiguity the scope cannot reduce. */
const SHARED_PHONE = "+15035550152";
/** Held only by SAM, who belongs to another user. */
const OTHER_USER_PHONE = "+15035550156";
/** Held by nobody. */
const ORPHAN_PHONE = "+15035550154";

/**
 * The argument tuples the renderer call sites send, named after the surface that
 * sends them. Transcribed from the call sites, and each is asserted against the
 * handler's construction in resolveHandlesScope-2758.test.ts.
 */
const TEXTS_TAB_SCOPE = { userId: USER_ID, transactionId: TX };
/** RemovedMessagesSection sends the same shape — same deal, same rule. */
const REMOVED_SECTION_SCOPE = { userId: USER_ID, transactionId: TX };
/** AttachMessagesModal: the hard filter, and deliberately NO transaction. */
const ATTACH_PICKER_SCOPE = { userId: USER_ID, transactionId: null };

describe("BACKLOG-2758 — in-app handle resolution is transaction-scoped", () => {
  let fx: ExportFixture;

  beforeAll(async () => {
    fx = await createExportFixture();

    fx.seedUser(USER_ID, "owner-2758@example.com", "Test User");
    fx.seedUser(OTHER_USER_ID, "other-2758@example.com", "Test Contact");
    fx.seedTransaction({ id: TX, userId: USER_ID, address: "1 Shared Line Rd" });
    fx.seedTransaction({ id: TX_OTHER, userId: USER_ID, address: "2 Other Deal Ave" });

    // PAT is seeded FIRST and CHRIS second. The pre-2757 resolver returned rows
    // in rowid order and let the last one win, so this ordering is the one that
    // would have produced the WRONG name — it keeps this fixture honest about
    // which property is under test.
    fx.seedContact({
      id: PAT.id,
      userId: USER_ID,
      displayName: PAT.name,
      phones: [{ phone: CONTESTED_PHONE, isPrimary: true }],
    });
    fx.seedContact({
      id: CHRIS.id,
      userId: USER_ID,
      displayName: CHRIS.name,
      phones: [
        { phone: CONTESTED_PHONE, isPrimary: true },
        { phone: SHARED_PHONE },
      ],
    });
    fx.seedContact({
      id: DANA.id,
      userId: USER_ID,
      displayName: DANA.name,
      phones: [{ phone: SHARED_PHONE, isPrimary: true }],
    });
    fx.seedContact({
      id: SAM.id,
      userId: OTHER_USER_ID,
      displayName: SAM.name,
      phones: [{ phone: OTHER_USER_PHONE, isPrimary: true }],
    });

    // Parties to THIS deal: Chris and Dana. Pat is a party to the OTHER deal —
    // i.e. Pat is a real, live contact, just not one of this deal's people. That
    // is the founder's "duplicate contact, unlinked from the deal".
    fx.attachContact({ transactionId: TX, contactId: CHRIS.id, createdAt: "2026-01-01 00:00:00" });
    fx.attachContact({ transactionId: TX, contactId: DANA.id, createdAt: "2026-01-01 00:00:01" });
    fx.attachContact({
      transactionId: TX_OTHER,
      contactId: PAT.id,
      createdAt: "2026-01-01 00:00:02",
    });
  }, 120_000);

  afterAll(async () => {
    await fx.cleanup();
  });

  // -------------------------------------------------------------------------
  // The Texts tab — threads already on the deal.
  // -------------------------------------------------------------------------
  describe("Texts tab (TransactionMessagesTab)", () => {
    it("names ONLY the linked contact when one of two holders is a party", async () => {
      // THE FOUNDER'S CASE. Asserted as the exact NAME SET, not as "Pat is
      // absent": a resolver that returned nobody would satisfy an absence check.
      const r = await resolveHandles([CONTESTED_PHONE], USER_ID, TEXTS_TAB_SCOPE);
      expect(matchedNamesFor(r, CONTESTED_PHONE)).toEqual([CHRIS.name]);
      expect(nameForHandle(r, CONTESTED_PHONE)).toBe(CHRIS.name);
    });

    it("keeps the honest 'or' when BOTH holders are parties", async () => {
      // The scope is a PREFERENCE, not a silencer. Where both contacts really
      // are on the deal there is no basis to choose, and the card must say so.
      // Without this leg, a fix that just returned the first row would pass the
      // leg above.
      const r = await resolveHandles([SHARED_PHONE], USER_ID, TEXTS_TAB_SCOPE);
      expect(matchedNamesFor(r, SHARED_PHONE)).toEqual([CHRIS.name, DANA.name]);
      expect(nameForHandle(r, SHARED_PHONE)).toBe(`${CHRIS.name} or ${DANA.name}`);
    });

    it("still names a handle whose only holder is NOT a party", async () => {
      // The preference must not become a hard filter: most message participants
      // are not formal `transaction_contacts` parties, and stripping their names
      // would empty the tab. Resolved against the OTHER deal, where Pat is the
      // party and Chris is not, Pat alone must still answer.
      const r = await resolveHandles([CONTESTED_PHONE], USER_ID, {
        userId: USER_ID,
        transactionId: TX_OTHER,
      });
      expect(matchedNamesFor(r, CONTESTED_PHONE)).toEqual([PAT.name]);
    });

    it("resolves a handle nobody holds to nothing", async () => {
      const r = await resolveHandles([ORPHAN_PHONE], USER_ID, TEXTS_TAB_SCOPE);
      expect(matchedNamesFor(r, ORPHAN_PHONE)).toEqual([]);
      expect(nameForHandle(r, ORPHAN_PHONE)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // The removed-threads section — same deal, same rule.
  // -------------------------------------------------------------------------
  describe("Removed threads (RemovedMessagesSection)", () => {
    it("names removed threads the way the deal names them", async () => {
      // These threads were removed FROM this deal, not from the world. The card
      // still names them, so it must name them as the deal does — otherwise
      // restoring a thread would silently change what it is called.
      const r = await resolveHandles([CONTESTED_PHONE], USER_ID, REMOVED_SECTION_SCOPE);
      expect(matchedNamesFor(r, CONTESTED_PHONE)).toEqual([CHRIS.name]);
    });

    it("never names a thread with ANOTHER USER's contact", async () => {
      // This section passed NO userId at all before BACKLOG-2758, so the hard
      // filter was simply absent here.
      const r = await resolveHandles([OTHER_USER_PHONE], USER_ID, REMOVED_SECTION_SCOPE);
      expect(matchedNamesFor(r, OTHER_USER_PHONE)).toEqual([]);
      expect(nameForHandle(r, OTHER_USER_PHONE)).toBeUndefined();
    });

    it("resolves that same handle for the user who DOES own it", async () => {
      // Anti-vacuity for the leg above: without it, deleting the contact from
      // the fixture would make the cross-user assertion pass for the wrong reason.
      const r = await resolveHandles([OTHER_USER_PHONE], OTHER_USER_ID, {
        userId: OTHER_USER_ID,
        transactionId: null,
      });
      expect(matchedNamesFor(r, OTHER_USER_PHONE)).toEqual([SAM.name]);
    });
  });

  // -------------------------------------------------------------------------
  // The attach picker — threads NOT yet on the deal. THE DELIBERATE DIFFERENCE.
  // -------------------------------------------------------------------------
  describe("Attach picker (AttachMessagesModal) — deliberately NOT transaction-scoped", () => {
    it("shows BOTH names for a shared line, even though one holder is a party", async () => {
      // Founder-ratified 2026-08-27. This is the SAME handle and the SAME
      // database as the Texts tab leg that returns one name; only the scope
      // differs. The picker is choosing whether to attach these threads at all,
      // so naming the line after this deal's party would present a guess as a
      // fact and hide the existence of the other contact.
      const r = await resolveHandles([CONTESTED_PHONE], USER_ID, ATTACH_PICKER_SCOPE);
      expect(matchedNamesFor(r, CONTESTED_PHONE)).toEqual([CHRIS.name, PAT.name]);
      expect(nameForHandle(r, CONTESTED_PHONE)).toBe(`${CHRIS.name} or ${PAT.name}`);
    });

    it("still applies the USER hard filter", async () => {
      // Withholding the transaction id must not be mistaken for withholding
      // scope altogether. The user filter is never in question.
      const r = await resolveHandles([OTHER_USER_PHONE], USER_ID, ATTACH_PICKER_SCOPE);
      expect(matchedNamesFor(r, OTHER_USER_PHONE)).toEqual([]);
    });

    it("differs from the Texts tab on the SAME handle — stated as one assertion", async () => {
      // The asymmetry itself, so it cannot be lost by editing one of the two
      // legs above in isolation.
      const tab = await resolveHandles([CONTESTED_PHONE], USER_ID, TEXTS_TAB_SCOPE);
      const picker = await resolveHandles([CONTESTED_PHONE], USER_ID, ATTACH_PICKER_SCOPE);
      expect(matchedNamesFor(tab, CONTESTED_PHONE)).toEqual([CHRIS.name]);
      expect(matchedNamesFor(picker, CONTESTED_PHONE)).toEqual([CHRIS.name, PAT.name]);
    });
  });
});
