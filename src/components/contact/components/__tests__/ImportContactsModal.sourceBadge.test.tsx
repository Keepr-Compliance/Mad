/**
 * THE IMPORT PICKER'S SOURCE BADGE (BACKLOG-2483)
 *
 * ===========================================================================
 * THE BUG
 * ===========================================================================
 * The badge was a two-way ternary over a vocabulary of nine:
 *
 *     {contact.source === "contacts_app" ? "Contacts App" : "Outlook"}
 *
 * so every Android, Google and iPhone record in the picker announced itself as
 * **Outlook**. The founder found it while testing. A user with an Android phone
 * opens the picker, looks for their Android contacts, sees only "Outlook" and
 * "Contacts App", and concludes the import failed — while the records sit right
 * there wearing another provider's name.
 *
 * ===========================================================================
 * THE FIXTURE IS TRANSCRIBED FROM THE PRODUCER, NOT INVENTED
 * ===========================================================================
 * These rows reproduce what `contacts:get-available` actually pushes into its
 * `availableContacts` array. There are exactly TWO push sites in
 * `electron/handlers/contactHandlers.ts` and they do NOT agree, which is the
 * whole reason the reachable source set is wider than the ticket assumed:
 *
 *   STEP 1 (~:1372) — unimported rows from the local `contacts` table:
 *       source: dbContact.source || "contacts_app"
 *     The backing query is `SELECT c.* FROM contacts c WHERE c.user_id = ?
 *     AND c.is_imported = 0` — NO source restriction. So this path can emit ANY
 *     value the `contacts.source` CHECK admits, including `manual`, `email`,
 *     `sms` and `inferred`.
 *
 *   STEP 3 (~:1720) — rows from the `external_contacts` shadow table:
 *       source: toPersistedContactSource(extContact.source)
 *     which narrows the five `ExternalContactSource` values to `contacts_app`,
 *     `iphone`, `outlook`, `google_contacts`, `android_sync`.
 *
 * The external rows below therefore drive their `source` through the REAL
 * `toPersistedContactSource` rather than hard-coding what it returns. If that
 * mapping changes, this test changes with it instead of quietly describing a
 * translation the app no longer performs.
 *
 * ===========================================================================
 * SWEEP, DON'T SAMPLE
 * ===========================================================================
 * One input per branch cannot catch a mislabel: the OLD code returned the
 * correct string for `outlook` and for `contacts_app`, so any test built from
 * those two alone passes on the bug. Every source that can reach this component
 * is rendered in one go and the EXACT ordered list of badge texts is asserted —
 * identity, never counts. "Six badges rendered" is satisfied by six wrong words.
 *
 * Names are invented and every address is on `example.com`, the RFC 2606
 * reserved documentation domain. No phone numbers appear at all — the badge
 * reads `source` and nothing else, so a number here would be personal-looking
 * data carried for no reason.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ImportContactsModal from "../ImportContactsModal";
import { NetworkProvider } from "../../../../contexts/NetworkContext";
import {
  PERSISTED_CONTACT_SOURCES,
  toPersistedContactSource,
} from "../../../../../electron/utils/contactSourceVocabulary";

const USER_ID = "user-2483";

/**
 * A STEP 3 row — the shadow-table shape, transcribed from the push at
 * `contactHandlers.ts:~1720`.
 *
 * `externalSource` is an `ExternalContactSource` (the address book's own
 * vocabulary: `macos`, not `contacts_app`) and is translated by the same
 * function the handler calls.
 */
function externalRow(
  id: string,
  name: string,
  externalSource: string,
): Record<string, unknown> {
  return {
    id,
    name,
    phone: null,
    email: `${id}@example.com`,
    company: null,
    source: toPersistedContactSource(externalSource),
    allPhones: [],
    allEmails: [`${id}@example.com`],
    isFromDatabase: false,
    last_communication_at: null,
    externalRecordId: `rec-${id}`,
    externalSourceType: externalSource,
    externalUuid: null,
    collapsedSources: [],
  };
}

/**
 * A STEP 1 row — the local-table shape, transcribed from the push at
 * `contactHandlers.ts:~1372`. `source` is passed through raw, exactly as
 * `dbContact.source || "contacts_app"` does.
 */
function dbRow(id: string, name: string, source: string | null): Record<string, unknown> {
  return {
    id,
    name,
    phone: null,
    email: `${id}@example.com`,
    company: null,
    source: source || "contacts_app",
    isFromDatabase: true,
    allPhones: [],
    allEmails: [`${id}@example.com`],
    last_communication_at: null,
  };
}

function renderPicker(contacts: Array<Record<string, unknown>>) {
  (window.api.contacts.getAvailable as jest.Mock).mockResolvedValue({
    success: true,
    contacts,
  });

  // The REAL NetworkProvider, not a stub: the picker renders `OfflineNotice`,
  // which throws without it. Mocking the notice away would also mock away the
  // only thing proving these rows render inside the real modal tree.
  return render(
    <NetworkProvider>
      <ImportContactsModal
        userId={USER_ID}
        onClose={jest.fn()}
        onSuccess={jest.fn()}
        onAddManually={jest.fn()}
      />
    </NetworkProvider>,
  );
}

const badgeTexts = (): string[] =>
  screen.getAllByTestId("contact-source-badge").map((el) => el.textContent ?? "");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ImportContactsModal source badge", () => {
  /**
   * THE HEADLINE ASSERTION — the five address books a synced record can come
   * from, each named correctly, in one render.
   *
   * On the pre-fix code this returns
   *   ["Contacts App", "Outlook", "Outlook", "Outlook", "Outlook"]
   * which is the bug stated as data.
   */
  it("names every address book a synced record can come from", async () => {
    renderPicker([
      externalRow("c1", "Rosalind Vantreece", "macos"),
      externalRow("c2", "Peter Aldringham", "outlook"),
      externalRow("c3", "Nadia Oyelaran", "google_contacts"),
      externalRow("c4", "Tomas Brantley", "iphone"),
      externalRow("c5", "Ingrid Falkenrath", "android_sync"),
    ]);

    await waitFor(() => expect(screen.getByText("Rosalind Vantreece")).toBeInTheDocument());

    expect(badgeTexts()).toEqual([
      "Contacts App",
      "Outlook",
      "Gmail",
      "iPhone",
      "Android",
    ]);
  });

  /**
   * THE DIRECT NEGATION OF THE DEFECT.
   *
   * Exactly one row in the render above is an Outlook record, so exactly one
   * badge may read "Outlook". The old code produced four. Stated as its own
   * assertion because it is the sentence the bug report makes, and because a
   * count here is meaningful in a way it is not elsewhere: the claim is that
   * three specific non-Outlook records STOPPED claiming Outlook.
   */
  it("gives 'Outlook' to the Outlook record alone", async () => {
    renderPicker([
      externalRow("c1", "Rosalind Vantreece", "macos"),
      externalRow("c2", "Peter Aldringham", "outlook"),
      externalRow("c3", "Nadia Oyelaran", "google_contacts"),
      externalRow("c4", "Tomas Brantley", "iphone"),
      externalRow("c5", "Ingrid Falkenrath", "android_sync"),
    ]);

    await waitFor(() => expect(screen.getByText("Rosalind Vantreece")).toBeInTheDocument());

    expect(badgeTexts().filter((t) => t === "Outlook")).toEqual(["Outlook"]);
  });

  /**
   * STEP 1's wider vocabulary. `getUnimportedContactsByUserId` puts no
   * restriction on `source`, so a locally-held unimported row can carry any
   * value the CHECK admits — including the four the ticket did not account for.
   *
   * Swept against `PERSISTED_CONTACT_SOURCES` rather than a retyped list, so a
   * source added to the CHECK arrives here automatically.
   */
  it("names every persisted source a local unimported row can carry", async () => {
    renderPicker(
      PERSISTED_CONTACT_SOURCES.map((source, i) =>
        dbRow(`d${i}`, `Local Person ${i}`, source),
      ),
    );

    await waitFor(() => expect(screen.getByText("Local Person 0")).toBeInTheDocument());

    expect(badgeTexts()).toEqual([
      "Manual",
      "From Email",
      "From Texts",
      "Contacts App",
      "From Email",
      "Android",
      "iPhone",
      "Outlook",
      "Gmail",
    ]);
  });

  /**
   * An unrecognised or absent source must read "Other" — never a provider.
   *
   * Reachable in the field: BACKLOG-2478 removed the catch-all that used to drop
   * unrecognised shadow rows, so they now REACH this component, and
   * `contacts.source` is nullable on the STEP 1 path.
   */
  it("labels an unrecognised or missing source 'Other', not a provider", async () => {
    renderPicker([
      dbRow("u1", "Unknown Source Person", "yahoo_contacts"),
      dbRow("u2", "Null Source Person", null),
      externalRow("u3", "Unmapped External Person", "some_future_book"),
    ]);

    await waitFor(() =>
      expect(screen.getByText("Unknown Source Person")).toBeInTheDocument(),
    );

    // `null` and an unmapped EXTERNAL source both fold to `contacts_app` at the
    // producer (STEP 1's `|| "contacts_app"`, STEP 3's `toPersistedContactSource`
    // default), so only the genuinely unrecognised PERSISTED value reaches the
    // badge as unknown. Asserted as the real end-to-end result rather than the
    // one this test would prefer.
    expect(badgeTexts()).toEqual(["Other", "Contacts App", "Contacts App"]);
  });
});
