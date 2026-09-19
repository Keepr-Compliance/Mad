/**
 * BACKLOG-3156 stage E — THE FOUR SETTINGS SCREENS HAVE ONE BLOCK SHAPE.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * `settingsBlockOrder-3156` pins the ORDER of the blocks. It passed while the
 * screens looked like three different products, because order is not shape:
 * Messages wrapped every block in a panel card and Emails did not, each block's
 * label sat outside its card on one screen and there was no card at all on
 * another, and three cards opened with an `<h4>` repeating in different words
 * the label printed directly above them. The founder read the shipped screens
 * and reported exactly that. It was the third round of drift on these files.
 *
 * So this suite asserts the SHAPE, and — the part that matters — asserts it
 * through ONE function applied to every screen. A per-screen assertion can
 * drift per screen; a shared invariant cannot. If Emails and Messages diverge,
 * the divergent one fails `auditBlock`, and `it("uses one card style across
 * every screen")` fails on the pair.
 *
 * THE SHAPE (from the approved artifact):
 *
 *     Emails                          <- section title, on the page
 *     ┌──────────────────────────┐
 *     │ Sources                  │    <- the block's label, FIRST CHILD
 *     │ Choose where to import…  │    <- description, if the block has one
 *     │ …controls…               │
 *     └──────────────────────────┘
 *       Import Emails  Force…  ?      <- actions, BARE, outside every card
 *
 * CARD vs ROW. These files already used two chromes and this fixes the meaning
 * to them: a CARD is `rounded-lg` + `border` and holds a block; a ROW is
 * `rounded` + `border` and lives inside one (the radio options, the provider
 * connections, the stored-count cells). `isCard` below is the definition, and
 * `no card inside a card` is enforceable because of it.
 *
 * ===========================================================================
 * MUTATIONS RUN AGAINST THIS FILE (each planted, run, reverted with `sed`,
 * re-run green). 26 in total. This list is the durable record; the rest of the
 * detail lives in `pm_comments` on BACKLOG-3156.
 * ===========================================================================
 * SHAPE
 *   1. Card classes back on the `MacOSMessagesImportSettings` root
 *      -> "Messages (macOS) > has no panel card wrapping its blocks".
 *   2. `Sources` eyebrow swapped below the description, out of first position
 *      -> "Messages (the source picker) > has one card whose first line…".
 *   3. `<h4>Email History</h4>` back between the label and the description
 *      -> "Emails > has one card per block…"; also placed AFTER the description
 *         so check 3 passes and check 4 must be the one that fires.
 *   4. Email description deleted from its card -> same test.
 *   5. Contacts `Auto-discover` block stripped of its card -> "Contacts > has
 *      one card per block…".
 *   6. `<h4>Contacts</h4>` restored -> "Contacts > says Contacts once…".
 *  14. Android description deleted -> "Messages (Android) > has no panel card…".
 *  15. macOS description deleted -> "Messages (macOS) > has no panel card…".
 *
 * THE HEADING ALLOWLIST (check 4) — every one of these PASSED under the old
 * chrome-class exemption, which is why the exemption is now enumerated. SR
 * found the first two; the rest are the same trick on the other three screens.
 *   A. `<h5>Import Filters</h5>` back inside a `rounded border` sub-box on the
 *      macOS panel -> "Messages (macOS) > has no panel card wrapping…".
 *   B. The same on the Android panel -> "Messages (Android) > …".
 *   C. `<h4>Email History</h4>` inside a row on Emails -> "Emails > …".
 *   D. `<h4>Import Source</h4>` inside a row -> "Messages (the source picker)…".
 *   E. `<h4>Contacts</h4>` inside a row -> "Contacts > …".
 *   F. `<h4>Gmail</h4>` — a DECLARED name — moved out of its row onto the card
 *      -> reds too, so the allowlist is not identity-only.
 *
 * PANEL IDENTITY HEADERS (check 8)
 *  11. `<h4>macOS Messages</h4>` restored -> "the four screens agree > lets no
 *      screen carry a heading outside its cards", naming screen and heading.
 *  12. `<h4>Android Companion</h4>` restored -> same test.
 *   G. The same header restored as an `<h3>` -> same test. (It passed while the
 *      check exempted the TAG rather than the section title's TEXT.)
 *   H. A second `<h3>Emails</h3>` outside the cards -> same test.
 *
 * CROSS-SCREEN AGREEMENT
 *   5b. One screen given `p-3 bg-white rounded-lg` -> "uses one card style
 *       across every screen", and ONLY that test.
 *
 * THE macOS DISABLED CUES (the deleted `<h4>` greyed while inactive)
 *  16. `aria-disabled` off the root      -> "still says it is inactive three ways…".
 *  17. actions `opacity-60` removed      -> same test.
 *  18. disabled note rendered while active -> "is not muted when it is the
 *      active source", which is what keeps 16/17 from passing on a panel that
 *      is permanently greyed.
 *
 * ELSEWHERE (other suites, same change)
 *   9. Messages source description deleted -> `Settings.test` "makes the Sources
 *      block one card whose first line is its own label".
 *  10. Contacts `Sources` label renamed   -> `ContactsImportSettings` "should
 *      render toggle switches and import button on macOS".
 *  13. `<AndroidMessagesSettings/>` replaced with `<div/>` -> `Settings.test`
 *      "does NOT render the inline guided wizard for an Android user".
 *   8. BACKLOG-2986 alert moved back above the Sources card -> that suite's
 *      "renders above the toggle group, not above the whole section".
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";
import { ImportSourceSettings } from "../ImportSourceSettings";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import { AndroidMessagesSettings } from "../AndroidMessagesSettings";
import { ContactsSettings } from "../ContactsSettings";
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
   * BACKLOG-3208: the panel now asks whether Full Disk Access is usable before
   * it offers an import, through the same service abstraction it already uses
   * for preferences. Granted is this suite's premise — every case here is about
   * what the import does once Keepr CAN read Messages. The denied path has its
   * own suite (`MacOSMessagesImportSettings.fdaRecovery-3208.test.tsx`).
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

// ===========================================================================
// The shape, as code. Every screen below is held to THIS, not to a copy of it.
// ===========================================================================

/**
 * A CARD is a `<div>` carrying both `rounded-lg` and the bare `border` class.
 * Word-boundary matching matters: `border-gray-200` is not `border`, and
 * `rounded` is not `rounded-lg` — which is what separates a card from a row.
 */
function isCard(el: Element): boolean {
  const cls = typeof el.className === "string" ? el.className : "";
  return (
    el.tagName === "DIV" &&
    /(^|\s)rounded-lg(\s|$)/.test(cls) &&
    /(^|\s)border(\s|$)/.test(cls)
  );
}

/**
 * A ROW is the chrome one step down: `rounded` (not `-lg`) plus the bare
 * `border`. Rows live inside cards — the radio options, the Gmail/Outlook
 * connections, the stored-count cells.
 *
 * BEING A ROW IS NOT A LICENCE TO CARRY A HEADING. It was, in the first version
 * of this file, and SR proved the hole by restoring the exact element this
 * change deleted —
 *
 *     <div className="mb-3 p-3 bg-white rounded border border-gray-200">
 *       <h5 …>Import Filters</h5>
 *     </div>
 *
 * — inside the `Import Preferences` card. All 23 tests passed. A chrome class is
 * something anyone can type; a guard that exempts whatever wears it cannot see
 * the regression it exists to catch, and two of the five headings this change
 * removed had precisely that shape.
 *
 * So the exemption is now an ENUMERATED ALLOWLIST per block (`allowedHeadings`),
 * and being inside a row is an ADDITIONAL requirement on the few headings the
 * allowlist names — not an alternative to being named.
 */
function isRow(el: Element): boolean {
  const cls = typeof el.className === "string" ? el.className : "";
  return (
    /(^|\s)rounded(\s|$)/.test(cls) && /(^|\s)border(\s|$)/.test(cls)
  );
}

function cardAncestor(el: Element): Element | null {
  let node = el.parentElement;
  while (node) {
    if (isCard(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function allCards(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll("div")).filter(isCard);
}

/** The eyebrow's class signature, as written in all five components. */
const EYEBROW_SELECTOR =
  "p.text-xs.font-medium.text-gray-500.uppercase.tracking-wide";

interface BlockSpec {
  /** `data-testid` of the block. The block IS its card. */
  testId: string;
  /** The label printed on the card's first line. */
  label: string;
  /** The line under the label, or null where the block has none. */
  description: string | null;
  /**
   * The exact text of every heading this card is allowed to contain. Enumerated
   * from the live tree, not inferred from chrome: across all five components
   * there are exactly two such headings — `Gmail` (EmailSettings :658) and
   * `Outlook` (:707) — and they name WHICH connection each row is, which the
   * `Sources` label above cannot say. Every other block declares none, so every
   * other in-card heading reds wherever it is nested.
   */
  allowedHeadings?: string[];
}

/**
 * Asserts one block against the shared shape. Every message names the screen
 * and the block, so a red says which of the four diverged and how.
 */
function auditBlock(screenName: string, block: BlockSpec): string {
  const card = screen.getByTestId(block.testId);
  const where = `${screenName} / ${block.label}`;

  // 1. The block IS a card — nothing wraps it, and it is not a bare div.
  expect(`${where}: block is a card = ${isCard(card)}`).toBe(
    `${where}: block is a card = true`,
  );

  // 2. The label is the card's FIRST CHILD, inside it.
  //    (Computed value in `expect`, constant in `toBe`, so jest prints the
  //    inverted pair the right way round: Expected = the shape, Received = what
  //    the DOM actually did.)
  const label = within(card).getByText(block.label);
  expect(
    card.firstElementChild === label
      ? `${where}: label is the card's first child`
      : `${where}: label is NOT the card's first child (first child is ${
          card.firstElementChild?.tagName ?? "nothing"
        }: "${card.firstElementChild?.textContent?.slice(0, 40) ?? ""}")`,
  ).toBe(`${where}: label is the card's first child`);

  // 3. The description, where the block has one, is the very next line — the
  //    slot the deleted <h4> headings used to occupy.
  if (block.description !== null) {
    const description = within(card).getByText(block.description);
    expect(
      label.nextElementSibling === description
        ? `${where}: description follows the label`
        : `${where}: description does NOT follow the label (next is "${
            label.nextElementSibling?.textContent?.slice(0, 40) ?? "nothing"
          }")`,
    ).toBe(`${where}: description follows the label`);
  }

  // 4. The card carries no heading beyond the ones this block declares. The
  //    label above IS the card's heading; an <h4>/<h5> beneath it is the
  //    doubling this stage removed (`Import Source`, `Email History`,
  //    `Contacts`, `Import Filters` x2).
  //
  //    A declared heading must ALSO sit inside a row, because the two that are
  //    declared are row identities. Both conditions, so neither alone lets a
  //    heading through: an undeclared heading reds however deeply it is nested,
  //    and a declared name reds if it escapes its row to sit on the card.
  const allowed = block.allowedHeadings ?? [];
  const offenders = Array.from(card.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .map((h) => {
      const text = (h.textContent ?? "").trim();
      let node: Element | null = h.parentElement;
      let inRow = false;
      while (node !== null && node !== card) {
        if (isRow(node)) inRow = true;
        node = node.parentElement;
      }
      if (allowed.includes(text) && inRow) return null;
      return allowed.includes(text) ? `${text} (declared, but not inside a row)` : text;
    })
    .filter((t): t is string => t !== null);
  expect(`${where}: headings the card may not carry = ${JSON.stringify(offenders)}`).toBe(
    `${where}: headings the card may not carry = []`,
  );

  return typeof card.className === "string" ? card.className : "";
}

/** Screen-wide invariants that no single block can carry. */
function auditScreen(
  screenName: string,
  container: HTMLElement,
  blocks: BlockSpec[],
  actionsTestId: string | null,
  /**
   * The screen's own section title, where the component under test renders one.
   * `null` for the three panels whose `<h3>` is rendered by `Settings.tsx`.
   * Named rather than typed-exempted for the reason SR found in check 4: a rule
   * that exempts a TAG lets anything wearing that tag through, so a panel header
   * reintroduced as an `<h3>` would have passed.
   */
  sectionTitle: string | null,
): string[] {
  const classNames = blocks.map((b) => auditBlock(screenName, b));

  // 5. No card inside a card. This is the panel-card regression: one wrapper
  //    around every block puts each block's card inside it.
  const nested = allCards(container)
    .filter((c) => cardAncestor(c) !== null)
    .map((c) => `${(c.textContent ?? "").slice(0, 40)}`);
  expect(`${screenName}: cards nested inside other cards = ${JSON.stringify(nested)}`).toBe(
    `${screenName}: cards nested inside other cards = []`,
  );

  // 6. Every eyebrow on the screen belongs to a card and opens it. Catches an
  //    eyebrow that escaped its card, and a second eyebrow added mid-card.
  const strays = Array.from(container.querySelectorAll(EYEBROW_SELECTOR))
    .filter((p) => {
      const owner = cardAncestor(p);
      return owner === null || owner.firstElementChild !== p;
    })
    .map((p) => (p.textContent ?? "").trim());
  expect(`${screenName}: labels not opening a card = ${JSON.stringify(strays)}`).toBe(
    `${screenName}: labels not opening a card = []`,
  );

  // 7. The actions stay bare: outside every card, and with no heading.
  if (actionsTestId !== null) {
    const actions = screen.getByTestId(actionsTestId);
    expect(`${screenName}: actions inside a card = ${cardAncestor(actions) !== null}`).toBe(
      `${screenName}: actions inside a card = false`,
    );
    expect(actions.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
  }

  // 8. NO PANEL IDENTITY HEADER. Outside the cards, the only heading a screen
  //    may carry is its own section title, BY TEXT and as an `<h3>`. Anything
  //    else out there is a panel header, which Messages had (`macOS Messages`,
  //    `Android Companion`) and Emails and Contacts did not. Recorded as well
  //    as asserted, so the cross-screen test below reds on it by name.
  let sectionTitleSeen = false;
  const panelHeadings = Array.from(
    container.querySelectorAll("h1,h2,h3,h4,h5,h6"),
  )
    .filter((h) => cardAncestor(h) === null)
    .map((h) => (h.textContent ?? "").trim())
    .filter((text) => {
      // Exactly one section title is forgiven, so a SECOND <h3> with the same
      // words is still reported.
      if (!sectionTitleSeen && sectionTitle !== null && text === sectionTitle) {
        sectionTitleSeen = true;
        return false;
      }
      return true;
    });
  headersOutsideCards.set(screenName, panelHeadings);
  expect(`${screenName}: headings outside its cards = ${JSON.stringify(panelHeadings)}`).toBe(
    `${screenName}: headings outside its cards = []`,
  );

  return classNames;
}

/**
 * Collected across every screen. The suite's last tests assert these agree —
 * the assertions that red when the four screens diverge, which is the failure
 * this whole item is about.
 */
const cardStyles = new Map<string, string>();
const headersOutsideCards = new Map<string, string[]>();

function recordStyles(screenName: string, classNames: string[]): void {
  classNames.forEach((cls, i) => cardStyles.set(`${screenName} #${i}`, cls));
}

const originalApi = window.api;

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

describe("BACKLOG-3156 stage E — Emails", () => {
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

  it("has one card per block, each opening with its own label", async () => {
    const { container } = render(
      <EmailSettings userId="u" initialPreferences={undefined as never} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("emails-block-actions")).toBeInTheDocument(),
    );

    recordStyles(
      "Emails",
      auditScreen(
        "Emails",
        container,
        [
          {
            testId: "emails-block-sources",
            label: "Sources",
            description: null,
            // The only two in-card headings on any of these screens. They name
            // WHICH connection each row is — something `Sources` cannot say.
            allowedHeadings: ["Gmail", "Outlook"],
          },
          {
            testId: "emails-block-preferences",
            label: "Import Preferences",
            description:
              "How much email to keep cached locally for fast search and auto-linking.",
          },
        ],
        "emails-block-actions",
        "Emails",
      ),
    );
  });

  /**
   * The provider connections are ROWS inside the Sources card, not cards. They
   * were cards, which is why the eyebrow could not move inside without creating
   * a card-in-card. Their own `<h4>Gmail</h4>` / `<h4>Outlook</h4>` do not
   * repeat the label above them — they say WHICH source each row is — so this
   * asserts they are still there and still name the providers, rather than
   * being swept up by the heading rule.
   */
  it("keeps Gmail and Outlook as named rows inside the Sources card", async () => {
    render(<EmailSettings userId="u" initialPreferences={undefined as never} />);
    const card = await screen.findByTestId("emails-block-sources");

    const gmail = within(card).getByText("Gmail");
    const outlook = within(card).getByText("Outlook");
    expect(gmail.closest("div[class*='rounded']")).not.toBeNull();
    expect(isCard(gmail.closest("div[class*='rounded']")!)).toBe(false);
    expect(isCard(outlook.closest("div[class*='rounded']")!)).toBe(false);
  });
});

describe("BACKLOG-3156 stage E — Messages (the source picker)", () => {
  it("has one card whose first line is Sources, description beneath", async () => {
    const { container } = render(
      <PlatformProvider>
        <ImportSourceSettings userId="u" />
      </PlatformProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("messages-block-sources")).toBeInTheDocument(),
    );
    // The radio options only render once the preference has loaded; auditing
    // the loading state would audit a spinner.
    await screen.findByText("iPhone Sync");

    recordStyles(
      "Messages (sources)",
      auditScreen(
        "Messages (sources)",
        container,
        [
          {
            testId: "messages-block-sources",
            label: "Sources",
            description: "Choose where to import your text messages from.",
          },
        ],
        null,
        null,
      ),
    );
  });
});

describe("BACKLOG-3156 stage E — Messages (macOS)", () => {
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

  it("has no panel card wrapping its blocks", async () => {
    const { container } = render(
      <PlatformProvider>
        <MacOSMessagesImportSettings userId="u" enabled />
      </PlatformProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("messages-block-actions")).toBeInTheDocument(),
    );

    recordStyles(
      "Messages (macOS)",
      auditScreen(
        "Messages (macOS)",
        container,
        [
          {
            testId: "messages-block-preferences",
            label: "Import Preferences",
            description:
              "Import messages from the macOS Messages app to enable linking with your transactions.",
          },
        ],
        "messages-block-actions",
        null,
      ),
    );
  });

  /**
   * THE DISABLED CUES THAT OUTLIVED THE DELETED HEADING.
   *
   * That `<h4>macOS Messages</h4>` was not plain: it greyed to `text-gray-400`
   * when another message source was active, so deleting it removed one visual
   * signal that the panel is inactive. It was safe to delete only because three
   * stronger signals remain, and "remain" is a claim a comment cannot carry —
   * so each is asserted here, in the disabled state.
   *
   * The note is `{!enabled && ...}` with a `?? ` fallback for `disabledReason`,
   * so there is no disabled path on which it fails to render; that is asserted
   * with no reason passed, which is the path that used the fallback.
   */
  it("still says it is inactive three ways with the greyed heading gone", async () => {
    render(
      <PlatformProvider>
        <MacOSMessagesImportSettings userId="u" enabled={false} />
      </PlatformProvider>,
    );
    const root = await screen.findByTestId("macos-messages-import");

    // 1. The root is marked disabled — BACKLOG-2335 semantics, whole panel.
    expect(root).toHaveAttribute("aria-disabled", "true");

    // 2. The reason is stated in words, not just colour.
    expect(screen.getByTestId("macos-import-disabled-note")).toHaveTextContent(
      /not your active message source/i,
    );

    // 3. The controls are muted, and the muting reaches BOTH the preferences
    //    block and the actions — not one of them.
    const preferences = screen.getByTestId("messages-block-preferences");
    const actions = screen.getByTestId("messages-block-actions");
    expect(preferences.closest(".opacity-60")).not.toBeNull();
    expect(actions.closest(".opacity-60")).not.toBeNull();

    // …and the panel is still one stack, not a card.
    expect(isCard(root)).toBe(false);
    expect(root.contains(preferences)).toBe(true);
    expect(root.contains(actions)).toBe(true);
  });

  /**
   * The panel is NOT muted when it is the active source — otherwise the check
   * above would pass against a panel that is permanently greyed.
   */
  it("is not muted when it is the active source", async () => {
    render(
      <PlatformProvider>
        <MacOSMessagesImportSettings userId="u" enabled />
      </PlatformProvider>,
    );
    const preferences = await screen.findByTestId("messages-block-preferences");

    expect(preferences.closest(".opacity-60")).toBeNull();
    expect(screen.queryByTestId("macos-import-disabled-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("macos-messages-import")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });

  /**
   * `SyncStatusIndicator` links to `#settings-import-filters`. Merging the
   * filters card into the Import Preferences block could have deleted the
   * anchor and left a dead link that no type or lint check would notice.
   */
  it("keeps the settings-import-filters anchor, now on the block itself", async () => {
    render(
      <PlatformProvider>
        <MacOSMessagesImportSettings userId="u" enabled />
      </PlatformProvider>,
    );
    const block = await screen.findByTestId("messages-block-preferences");
    expect(block).toHaveAttribute("id", "settings-import-filters");
  });
});

describe("BACKLOG-3156 stage E — Messages (Android)", () => {
  it("has no panel card wrapping its blocks", async () => {
    const { container } = render(<AndroidMessagesSettings userId="u" />);
    await waitFor(() =>
      expect(screen.getByTestId("android-block-actions")).toBeInTheDocument(),
    );

    recordStyles(
      "Messages (Android)",
      auditScreen(
        "Messages (Android)",
        container,
        [
          {
            testId: "android-block-preferences",
            label: "Import Preferences",
            description:
              "Sync SMS messages from your Android phone over WiFi using the Keepr Companion app.",
          },
        ],
        "android-block-actions",
        null,
      ),
    );
  });

  it("keeps the settings-android-companion anchor on the root", async () => {
    const { container } = render(<AndroidMessagesSettings userId="u" />);
    await screen.findByTestId("android-block-actions");

    const root = container.querySelector("#settings-android-companion");
    expect(root).not.toBeNull();
    expect(isCard(root!)).toBe(false);
    expect(root!.contains(screen.getByTestId("android-block-preferences"))).toBe(true);
  });
});

describe("BACKLOG-3156 stage E — Contacts", () => {
  beforeEach(() => {
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
          getSourceStats: jest.fn().mockResolvedValue({ success: true, stats: {} }),
        },
      },
      writable: true,
      configurable: true,
    });
  });

  it("has one card per block, each opening with its own label", async () => {
    const { container } = render(
      <PlatformProvider>
        <ContactsSettings
          userId="u"
          initialPreferences={
            { phone_type: "iphone", contactSources: { direct: {} } } as never
          }
          isMicrosoftConnected={true}
          isGoogleConnected={false}
        />
      </PlatformProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("contacts-block-actions")).toBeInTheDocument(),
    );

    recordStyles(
      "Contacts",
      auditScreen(
        "Contacts",
        container,
        [
          {
            testId: "contacts-block-sources",
            label: "Sources",
            description:
              "Manage contact sources and import contacts for transaction assignment.",
          },
          {
            testId: "contacts-block-autodiscover",
            label: "Auto-discover from conversations",
            description: null,
          },
          {
            testId: "contacts-block-stored",
            label: "Stored on this computer",
            description: null,
          },
        ],
        "contacts-block-actions",
        "Contacts",
      ),
    );
  });

  /**
   * The panel's `<h4>Contacts</h4>` repeated the section's own `<h3>Contacts</h3>`
   * one line above it. Asserted as a COUNT rather than an absence, because the
   * section heading legitimately says the word and a bare `queryByText` would
   * red on the wrong thing — or, scoped too tightly, pass with the h4 restored
   * under a different tag.
   */
  it("says Contacts once, as the section heading", async () => {
    render(
      <PlatformProvider>
        <ContactsSettings
          userId="u"
          initialPreferences={
            { phone_type: "iphone", contactSources: { direct: {} } } as never
          }
          isMicrosoftConnected={true}
          isGoogleConnected={false}
        />
      </PlatformProvider>,
    );
    await screen.findByTestId("contacts-block-actions");

    const headings = screen.getAllByRole("heading", { name: "Contacts" });
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe("H3");
  });
});

describe("BACKLOG-3156 stage E — the four screens agree", () => {
  /**
   * THE POINT OF THE SUITE. Every block card collected above must carry the
   * same class string. A screen that keeps its own padding, its own fill, or
   * its own corner radius fails HERE, naming both sides, even though each
   * screen passed its own audit.
   *
   * It runs last and reads what the earlier tests recorded, so a red here means
   * the screens disagree — not that any one of them is malformed.
   */
  it("uses one card style across every screen", () => {
    // Enumerated, not counted: a screen whose audit never ran would otherwise
    // let this pass by agreeing with itself.
    expect([...cardStyles.keys()].sort()).toEqual([
      "Contacts #0",
      "Contacts #1",
      "Contacts #2",
      "Emails #0",
      "Emails #1",
      "Messages (Android) #0",
      "Messages (macOS) #0",
      "Messages (sources) #0",
    ]);

    const distinct = new Map<string, string[]>();
    for (const [where, cls] of cardStyles) {
      distinct.set(cls, [...(distinct.get(cls) ?? []), where]);
    }

    expect(
      `card styles in use: ${JSON.stringify(
        Object.fromEntries(distinct),
        null,
        1,
      )}`,
    ).toBe(
      `card styles in use: ${JSON.stringify(
        { "p-4 bg-gray-50 rounded-lg border border-gray-200": [...cardStyles.keys()] },
        null,
        1,
      )}`,
    );
  });

  /**
   * THE SECOND WAY THESE SCREENS DIVERGED. Messages opened each of its two
   * panels with an icon and an `<h4>` naming it — `macOS Messages`,
   * `Android Companion` — while Emails and Contacts opened straight onto their
   * first card. On macOS the `<h4>` also printed the same words as the radio
   * option selected in the Sources card directly above it.
   *
   * Neither header held anything a reader could not get elsewhere: the only
   * state in the macOS one was its `enabled` colouring, which the
   * `macos-import-disabled-note` states in a sentence and the `opacity-60`
   * muting shows on every control.
   *
   * A screen growing one back fails HERE, naming the screen and the heading —
   * which is what the per-screen audits alone could not do, since each screen
   * would only be measured against itself.
   */
  it("lets no screen carry a heading outside its cards", () => {
    expect([...headersOutsideCards.keys()].sort()).toEqual([
      "Contacts",
      "Emails",
      "Messages (Android)",
      "Messages (macOS)",
      "Messages (sources)",
    ]);

    const offenders = Object.fromEntries(
      [...headersOutsideCards].filter(([, hs]) => hs.length > 0),
    );
    expect(`screens carrying a panel header: ${JSON.stringify(offenders)}`).toBe(
      "screens carrying a panel header: {}",
    );
  });
});
