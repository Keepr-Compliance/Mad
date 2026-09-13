/**
 * BACKLOG-3156 stage B — WHAT THE "?" SAYS IS A CLAIM ABOUT BEHAVIOUR.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * This exact popup, on this exact panel, has already shipped a falsehood.
 * BACKLOG-3029: the Contacts button tooltip, its confirmation dialog and its
 * info popover all said the re-import cleared EVERY source. That stopped being
 * true when the wipe was scoped to the sources that would actually be refilled,
 * and nothing went red — because no test read any of them.
 *
 * Stage B puts the same popup on two more sections, which triples the surface
 * that can drift. So every factual claim in the new copy is pinned here.
 *
 * ===========================================================================
 * IT PINS THE CLAIMS, NOT THE PROSE
 * ===========================================================================
 * Following `reimportCopy-3029` and `recacheCopy-3056`: asserting whole
 * sentences freezes the wording and gets rewritten to match whatever the code
 * now says, which protects nothing. Each section below asserts
 *
 *   - the things that must be SAYABLE (what survives, what is destroyed),
 *   - the things that must be ABSENT (a promise the code does not keep, and a
 *     DERIVED LIST OF SOURCES where the rule belongs),
 *   - that the popup opens and closes from its own `?`,
 *   - and that each heading is the label of the button it explains — asserted
 *     structurally against the rendered buttons, not against a literal, so a
 *     rename that forgets the popup goes red.
 *
 * The last one matters tonight specifically: the approved design renames the
 * Emails destructive button to `Force Re-import` and Contacts' to
 * `Re-download Contacts` in a LATER stage. When those land, this suite fails
 * until the popup follows them.
 *
 * ===========================================================================
 * MUTATIONS (each verified red before this suite was trusted)
 * ===========================================================================
 *   - Drop "and loses review decisions on them" from the Emails force copy
 *     -> the Emails claim test reds.
 *   - Change the Messages primary copy to name macOS/iPhone/Android instead of
 *     "your selected source" -> the Messages rule test reds.
 *   - Restore "every source" in the Contacts force copy -> the Contacts test reds.
 *   - Restore "Deletes the messages stored on this computer" in the Messages
 *     force copy -> the Messages scope test reds. This is the one the suite
 *     originally MISSED: it pinned the false sentence, and SR caught it against
 *     the SQL rather than against the design.
 *   - Remove the second `mouseDown` handler so the popup cannot be shut
 *     -> all three toggle tests red.
 */

import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import { ContactsImportSettings } from "../MacOSContactsImportSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";

jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], isRunning: false, requestSync: jest.fn() }),
}));

jest.mock("../../../services", () => ({
  /**
   * BACKLOG-3208: the macOS Messages panel now asks whether Full Disk Access is
   * usable before it offers an import, through the same service abstraction it
   * already uses for preferences. Granted is this suite's premise — nothing
   * here is about the permission notice. Its own suite is
   * `MacOSMessagesImportSettings.fdaRecovery-3208.test.tsx`.
   */
  systemService: {
    checkMessagesPermission: jest
      .fn()
      .mockResolvedValue({ success: true, data: { hasPermission: true } }),
    openFullDiskAccessSettings: jest.fn().mockResolvedValue({ success: true }),
    relaunchApp: jest
      .fn()
      .mockResolvedValue({ success: true, data: { relaunched: true } }),
  },
  settingsService: {
    getPreferences: jest.fn().mockResolvedValue({ success: true, data: {} }),
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
  authService: {
    googleConnectMailbox: jest.fn(),
    microsoftConnectMailbox: jest.fn(),
    googleDisconnectMailbox: jest.fn(),
    microsoftDisconnectMailbox: jest.fn(),
    onMailboxConnected: jest.fn(() => () => {}),
  },
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const originalApi = window.api;

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

/**
 * The promises that stopped being true on the Contacts popover in BACKLOG-3029.
 * Each is a phrase a reader would take as "nothing survives this button".
 * Applied to every section, not only Contacts: the failure shape is the copy
 * over-claiming what a destructive run reaches, and it is available to all three.
 */
const EVERY_SOURCE_CLAIMS = [
  /every\s+(synced\s+)?source/i,
  /all\s+cached\s+contacts/i,
  /from\s+every\s+source/i,
  /all\s+sources/i,
];

/**
 * The SAME failure, caught by SR on a string written the same day as this suite
 * (review `972e37ea`) — and this suite had pinned the false version, which is
 * how a test can make a falsehood harder to correct instead of easier.
 *
 * The Messages force copy first read "Deletes the messages stored on this
 * computer". The wipe is SCOPED: `forceSetMessages`
 * (`electron/services/db/macosForceSetSql.ts`) predicates the only bulk
 * `DELETE FROM messages` on the force path with
 * `json_extract(metadata, '$.source') = 'macos_messages'`, so iPhone-sync and
 * Android-companion rows and their transaction links survive. BACKLOG-2796
 * scoped it deliberately.
 *
 * The error over-warned, so nothing was at risk — but "false in the safe
 * direction" is still false, and it is the direction that teaches people to
 * discount the warning. These are the phrasings that claim an unscoped wipe.
 */
const UNSCOPED_WIPE_CLAIMS = [
  /messages stored on this computer/i,
  /all\s+(your\s+)?messages/i,
  /every\s+message/i,
  /entire\s+message\s+history/i,
];

/**
 * Open a section's popup and hand back its panel.
 *
 * The trigger is found by TESTID, not by its `aria-label`: all three carry the
 * same "Import info" label, so on a page rendering more than one section a
 * label query would be ambiguous — and, worse, could silently read a different
 * section's copy in a suite that renders one panel today and two tomorrow.
 */
async function openPopup(section: string): Promise<HTMLElement> {
  fireEvent.mouseDown(await screen.findByTestId(`${section}-import-info-button`));
  return screen.getByTestId(`${section}-import-info-panel`);
}

/**
 * The popup's headings and bodies, read off the panel's own child order:
 * `ImportInfoPopover` renders heading, body, heading, body… as direct children.
 * Position rather than class, so restyling the panel cannot quietly turn these
 * assertions vacuous.
 */
function entriesOf(panel: HTMLElement): { heading: string; body: string }[] {
  const kids = Array.from(panel.children);
  const out: { heading: string; body: string }[] = [];
  for (let i = 0; i + 1 < kids.length; i += 2) {
    out.push({
      heading: (kids[i].textContent ?? "").trim(),
      body: (kids[i + 1].textContent ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/**
 * Control (a), applied identically to all three sections: the panel is absent
 * at rest, the `?` opens it, and the same `?` shuts it again.
 *
 * Deliberately NOT asserted via `fireEvent.blur`: in jsdom a blur event fires
 * whether or not the element ever held focus, so a blur-closes test would go
 * green without discriminating anything.
 */
async function expectOpensAndCloses(section: string): Promise<void> {
  expect(screen.queryByTestId(`${section}-import-info-panel`)).not.toBeInTheDocument();

  const trigger = await screen.findByTestId(`${section}-import-info-button`);
  fireEvent.mouseDown(trigger);
  const panel = screen.getByTestId(`${section}-import-info-panel`);
  // Not vacuous: a panel that rendered empty would satisfy every "does not
  // say X" assertion in this file.
  expect((panel.textContent ?? "").length).toBeGreaterThan(120);

  fireEvent.mouseDown(trigger);
  expect(screen.queryByTestId(`${section}-import-info-panel`)).not.toBeInTheDocument();
}

// ===========================================================================
// EMAILS
// ===========================================================================

describe("BACKLOG-3156 stage B — the Emails popup", () => {
  beforeEach(() => {
    Object.defineProperty(window, "api", {
      value: {
        ...originalApi,
        system: {
          ...originalApi?.system,
          checkAllConnections: jest.fn().mockResolvedValue({
            success: true,
            google: { connected: true, email: "agent@example.com" },
            microsoft: { connected: false },
          }),
        },
        transactions: {
          precacheEmails: jest.fn(),
          cancelPrecacheEmails: jest.fn(),
          onPrecacheProgress: () => () => {},
        },
      },
      writable: true,
      configurable: true,
    });
  });

  const renderEmails = () =>
    render(<EmailSettings userId="u" initialPreferences={undefined as never} />);

  it("opens and closes from its own ?", async () => {
    renderEmails();
    await waitFor(() =>
      expect(screen.getByTestId("emails-block-actions")).toBeInTheDocument(),
    );

    await expectOpensAndCloses("emails");
  });

  it("heads each paragraph with the button it explains, as that button reads today", async () => {
    renderEmails();
    const panel = await openPopup("emails");

    // Read off the rendered buttons, so the pair cannot drift apart in a later
    // rename. `Force Re-cache` is the name on the button TONIGHT; the approved
    // rename to `Force Re-import` is a later stage, and when it lands this
    // fails until the popup follows it.
    const primary = screen.getByTestId("recache-emails");
    const destructive = screen.getByTestId("force-recache-emails");
    expect(entriesOf(panel).map((e) => e.heading)).toEqual([
      (primary.textContent ?? "").trim(),
      (destructive.textContent ?? "").trim(),
    ]);
  });

  it("says the ordinary import brings older mail and keeps links, and does not promise newer-only", async () => {
    renderEmails();
    const [ordinary] = entriesOf(await openPopup("emails"));

    // The claim BACKLOG-3056 falsified, in any phrasing.
    expect(ordinary.body).not.toMatch(/only[^.]*newer/i);
    // Older mail arrives, tied to the setting by name — "older mail sometimes
    // arrives" with no stated condition is a different and misleading promise.
    expect(ordinary.body).toMatch(/older/i);
    expect(ordinary.body).toMatch(/email history/i);
    expect(ordinary.body).toMatch(/stay linked|nothing is unlinked|does not unlink/i);
  });

  it("says the force run unlinks and loses review decisions", async () => {
    renderEmails();
    const [, force] = entriesOf(await openPopup("emails"));

    // Both are true at source: the swap deletes the force set with an ordinary
    // DELETE so every ON DELETE CASCADE fires — the transaction-link table AND
    // its pending-review sibling (`electron/services/emailForceStaging.ts`,
    // `deleteLiveForceSet`). The confirmation dialog says the same.
    expect(force.body).toMatch(/unlinks your emails from their transactions/i);
    expect(force.body).toMatch(/review decisions/i);
  });

  it("states the rule and does not name the providers it reaches", async () => {
    renderEmails();
    const panel = await openPopup("emails");
    const text = panel.textContent ?? "";

    // BACKLOG-3029's lesson, applied here: a list of providers read off this
    // component's connection flags disagrees with what the run actually
    // rebuilds, so the copy says "your connected providers" instead.
    expect(text).not.toMatch(/\bGmail\b/);
    expect(text).not.toMatch(/\bOutlook\b/);
    for (const claim of EVERY_SOURCE_CLAIMS) {
      expect(text).not.toMatch(claim);
    }
  });

  it("is the only place the description now lives", async () => {
    renderEmails();
    await waitFor(() =>
      expect(screen.getByTestId("emails-block-actions")).toBeInTheDocument(),
    );

    // Stage B deleted the card. If it were left behind, the prose would be on
    // the page twice — which is the duplication this stage exists to remove.
    expect(screen.queryByText(/Fetches new mail/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Force re-cache\./)).not.toBeInTheDocument();

    const panel = await openPopup("emails");
    expect(panel.textContent).toMatch(/Fetches new mail/i);
  });
});

// ===========================================================================
// MESSAGES
// ===========================================================================

describe("BACKLOG-3156 stage B — the Messages popup", () => {
  beforeEach(() => {
    (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
      success: true,
      messageCount: 0,
      lastImportAt: null,
    });
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: null,
      source: "lookback-pref",
      lookbackMonths: 3,
    });
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      success: true,
      count: 10,
      filteredCount: 10,
    });
  });

  const renderMessages = () =>
    render(
      <PlatformProvider>
        <MacOSMessagesImportSettings userId="u" enabled />
      </PlatformProvider>,
    );

  it("opens and closes from its own ?", async () => {
    renderMessages();
    await waitFor(() =>
      expect(screen.getByTestId("messages-block-actions")).toBeInTheDocument(),
    );

    await expectOpensAndCloses("messages");
  });

  it("heads each paragraph with the button it explains, as that button reads today", async () => {
    renderMessages();
    const panel = await openPopup("messages");

    const primary = screen.getByRole("button", { name: "Import Messages" });
    const destructive = screen.getByRole("button", { name: "Force Re-import" });
    expect(entriesOf(panel).map((e) => e.heading)).toEqual([
      (primary.textContent ?? "").trim(),
      (destructive.textContent ?? "").trim(),
    ]);
  });

  it("says the ordinary import leaves existing messages and their links alone", async () => {
    renderMessages();
    const [ordinary] = entriesOf(await openPopup("messages"));

    expect(ordinary.body).toMatch(/left alone|untouched|not (removed|deleted)/i);
    expect(ordinary.body).toMatch(/link/i);
  });

  it("says the force run deletes what is stored and unlinks attached conversations", async () => {
    renderMessages();
    const [, force] = entriesOf(await openPopup("messages"));

    // BACKLOG-2331: the clear + re-import cascade-deletes the
    // conversation<->transaction junction, so attached conversations become
    // unlinked. The confirmation dialog carries the same claim; if one is
    // reworded to disagree with the other, this reds.
    expect(force.body).toMatch(/unlinks/i);
    expect(force.body).toMatch(/conversations/i);
    expect(force.body).toMatch(/delet/i);
  });

  it("scopes what the force run deletes, and does not claim an unscoped wipe", async () => {
    renderMessages();
    const [, force] = entriesOf(await openPopup("messages"));

    // The rule, stated: what Keepr imported from the source you selected. Not
    // the unscoped total, and not a list of sources.
    expect(force.body).toMatch(/from your selected source/i);
    for (const claim of UNSCOPED_WIPE_CLAIMS) {
      expect(force.body).not.toMatch(claim);
    }
  });

  it("names the RULE, not the sources — which source runs is decided outside this panel", async () => {
    renderMessages();
    const text = (await openPopup("messages")).textContent ?? "";

    // The active source is chosen in `Settings.tsx`, not here. A list written
    // into this panel's copy would be exactly the derived-list failure
    // BACKLOG-3029 filed against its sibling: read off one place, decided in
    // another.
    expect(text).toMatch(/selected source/i);
    expect(text).not.toMatch(/\bmacOS\b/i);
    expect(text).not.toMatch(/\biPhone\b/i);
    expect(text).not.toMatch(/\bAndroid\b/i);
    for (const claim of EVERY_SOURCE_CLAIMS) {
      expect(text).not.toMatch(claim);
    }
  });
});

// ===========================================================================
// CONTACTS — the copy is unchanged; what is new is that it moved into a shared
// component, so its claims are re-pinned from the outside.
// ===========================================================================

describe("BACKLOG-3156 stage B — the Contacts popup", () => {
  const contactsProps = {
    userId: "u",
    outlookContactsEnabled: true,
    macosContactsEnabled: true,
    iphoneContactsEnabled: false,
    showIphoneContacts: false,
    androidContactsEnabled: true,
    androidContactsDeclared: true,
    androidCompanionActive: true,
    saveError: null,
    gmailContactsEnabled: true,
    googleContactsEnabled: true,
    outlookEmailsInferred: false,
    gmailEmailsInferred: false,
    messagesInferred: false,
    loadingPreferences: false,
    onToggleSource: jest.fn(),
  };

  const renderContacts = () => {
    Object.defineProperty(window, "api", {
      value: {
        ...originalApi,
        system: { ...originalApi?.system, platform: "darwin" },
        contacts: {
          getExternalSyncStatus: jest
            .fn()
            .mockResolvedValue({ success: true, lastSyncAt: null, contactCount: 0 }),
          syncOutlookContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
          syncGoogleContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
          syncExternal: jest.fn().mockResolvedValue({ success: true }),
          forceReimport: jest.fn().mockResolvedValue({ success: true, cleared: 0 }),
          getSourceStats: jest
            .fn()
            .mockResolvedValue({ success: true, stats: { macos: 10, outlook: 7 } }),
        },
      },
      writable: true,
      configurable: true,
    });

    return render(
      <PlatformProvider>
        <ContactsImportSettings {...contactsProps} />
      </PlatformProvider>,
    );
  };

  it("opens and closes from its own ?", async () => {
    renderContacts();
    await waitFor(() =>
      expect(screen.getByTestId("contacts-block-actions")).toBeInTheDocument(),
    );

    await expectOpensAndCloses("contacts");
  });

  it("heads each paragraph with the button it explains, as that button reads today", async () => {
    renderContacts();
    const panel = await openPopup("contacts");

    // By ROLE: the popup is open, so its heading also reads "Import Contacts".
    const primary = screen.getByRole("button", { name: "Import Contacts" });
    const destructive = screen.getByRole("button", { name: "Force Re-import" });
    expect(entriesOf(panel).map((e) => e.heading)).toEqual([
      (primary.textContent ?? "").trim(),
      (destructive.textContent ?? "").trim(),
    ]);
  });

  it("survived the move into the shared component with its claims intact", async () => {
    renderContacts();
    const [ordinary, force] = entriesOf(await openPopup("contacts"));

    expect(ordinary.body).toMatch(/adds new contacts/i);
    expect(ordinary.body).toMatch(/removes contacts deleted from the source/i);

    // The two facts BACKLOG-3029 turned on: the wipe is scoped by the RULE
    // (what you switched on), and the phone's contacts survive.
    expect(force.body).toMatch(/switched on/i);
    expect(force.body).toMatch(/phone/i);
    for (const claim of EVERY_SOURCE_CLAIMS) {
      expect(force.body).not.toMatch(claim);
    }
  });
});
