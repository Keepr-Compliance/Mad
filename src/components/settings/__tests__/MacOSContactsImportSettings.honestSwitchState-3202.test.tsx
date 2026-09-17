/**
 * BACKLOG-3202 — A SOURCE SWITCH MAY NOT READ ON WHILE ITS OWN LABEL SAYS
 * "(not connected)".
 *
 * ===========================================================================
 * WHAT WAS WRONG
 * ===========================================================================
 * Each source row drove one control from two facts that never consulted each
 * other:
 *
 *     disabled={loadingPreferences || !isGoogleConnected}     // REACHABILITY
 *     className={... googleContactsEnabled ? "bg-blue-500" : "bg-gray-300"}
 *     aria-checked={googleContactsEnabled}                    // PREFERENCE
 *
 * Nothing forced them to agree. With a stored preference of `true` and no
 * connection — the default state of a never-configured source, since the UI
 * falls back to `true` for the direct keys — the row rendered a blue,
 * right-positioned, `aria-checked="true"` switch sitting next to the words
 * "(not connected)", greyed out so it could not be turned off.
 *
 * The sharper half is the screen reader, which announced "switch, checked" for
 * a source the user had never connected and could not uncheck.
 *
 * ===========================================================================
 * WHY THE 2x2 AND NOT JUST THE FAILING CELL
 * ===========================================================================
 * The single cell this item is about is (enabled, NOT connected) -> false. On
 * its own it is satisfied by a component that renders every switch off, and by
 * an `||` written where an `&&` belongs. So each row is swept across all four
 * combinations of preference and reachability:
 *
 *     enabled  + connected      -> on    (the positive control)
 *     enabled  + disconnected   -> OFF   (the defect; red before the fix)
 *     disabled + connected      -> off
 *     disabled + disconnected   -> off
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT ASSERTED
 * ===========================================================================
 * The stored preference itself. The fix changes how the switch is DRAWN, never
 * what is saved — an unreachable source keeps its preference so it comes back
 * when the connection does. The `disabled` state and the BACKLOG-2142 title
 * ("Connect email to enable import") are likewise untouched here; they are
 * already pinned by ContactsImportSettings.test.tsx, and this suite asserting
 * them again would only make that pair harder to change.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContactsImportSettings } from "../MacOSContactsImportSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";
import type { ContactInferenceStates } from "../../../hooks/useContactInferenceState";

const mockRequestSync = jest.fn();
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], isRunning: false, requestSync: mockRequestSync }),
}));

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

const originalApi = window.api;

/**
 * Every source flag is pinned to a value this suite does not vary, so the only
 * moving parts in each case are the one preference and the one connection flag
 * under test.
 */
const baseProps = {
  userId: "user-3202",
  outlookContactsEnabled: false,
  macosContactsEnabled: false,
  iphoneContactsEnabled: false,
  showIphoneContacts: false,
  androidContactsEnabled: false,
  androidContactsDeclared: false,
  androidCompanionActive: false,
  saveError: null,
  gmailContactsEnabled: false,
  googleContactsEnabled: false,
  outlookEmailsInferred: false,
  // BACKLOG-3349: the plan gate is a third term in this suite's own rule
  // (draw what is in effect). The base fixture states "allowed", so the cases
  // that predate the gate keep measuring the connection term alone; the three
  // cases that ARE about the plan override it.
  // BACKLOG-1717 added `gmail` here: the Gmail emails row is now plan-gated
  // the same way the Outlook one is, so the connection-gated rows below need
  // the plan to be allowed before "connected" is the only variable left.
  contactInference: { outlook: "allowed", gmail: "allowed" } as ContactInferenceStates,
  gmailEmailsInferred: false,
  messagesInferred: false,
  loadingPreferences: false,
  isMicrosoftConnected: false,
  isGoogleConnected: false,
  onToggleSource: jest.fn(),
};

function renderCard(overrides: Partial<typeof baseProps>): void {
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

  render(
    <PlatformProvider>
      <ContactsImportSettings {...baseProps} {...overrides} />
    </PlatformProvider>,
  );
}

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

/** The knob sits right only when the switch reads on. */
function knobIsRight(sw: HTMLElement): boolean {
  return (sw.querySelector("span")?.className ?? "").includes("translate-x-6");
}

/**
 * One reading of the control, from the three things a user can actually
 * perceive: what a screen reader announces, what colour the track is, and where
 * the knob sits. A fix that moved only `aria-checked` and left the switch blue
 * would still be a switch that lies to the eye, so all three are read.
 */
function switchState(name: string): { aria: string | null; blue: boolean; knobRight: boolean } {
  const sw = screen.getByRole("switch", { name });
  return {
    aria: sw.getAttribute("aria-checked"),
    blue: sw.className.includes("bg-blue-500"),
    knobRight: knobIsRight(sw),
  };
}

function expectReadsOn(name: string): void {
  const { aria, blue, knobRight } = switchState(name);
  expect(aria).toBe("true");
  expect(blue).toBe(true);
  expect(knobRight).toBe(true);
}

function expectReadsOff(name: string): void {
  const { aria, blue, knobRight } = switchState(name);
  expect(aria).toBe("false");
  expect(blue).toBe(false);
  expect(knobRight).toBe(false);
}

/**
 * The four rows whose enabled-ness is gated on a provider connection, each with
 * the preference prop that drives it and the connection prop that should now
 * also gate how it is drawn.
 *
 * The two Contacts rows are the founder-reported case: the UI falls back to
 * `true` for those preferences, so a never-configured machine shows them on.
 * The two auto-discover rows fall back to `false`, so they do not lie on a
 * fresh install — but they are the identical shape, and lie the moment someone
 * enables one and the connection later goes away.
 */
const CONNECTION_GATED_ROWS: Array<{
  label: string;
  switchName: string;
  preferenceProp: keyof typeof baseProps;
  connectionProp: "isGoogleConnected" | "isMicrosoftConnected";
}> = [
  {
    label: "Outlook Contacts",
    switchName: "Outlook Contacts import",
    preferenceProp: "outlookContactsEnabled",
    connectionProp: "isMicrosoftConnected",
  },
  {
    label: "Google Contacts",
    switchName: "Google Contacts import",
    preferenceProp: "googleContactsEnabled",
    connectionProp: "isGoogleConnected",
  },
  {
    label: "Outlook emails (auto-discover)",
    switchName: "Outlook emails auto-discover",
    preferenceProp: "outlookEmailsInferred",
    connectionProp: "isMicrosoftConnected",
  },
  {
    label: "Gmail emails (auto-discover)",
    switchName: "Gmail emails auto-discover",
    preferenceProp: "gmailEmailsInferred",
    connectionProp: "isGoogleConnected",
  },
];

describe("A source switch tells the truth about reachability (BACKLOG-3202)", () => {
  describe.each(CONNECTION_GATED_ROWS)(
    "$label",
    ({ switchName, preferenceProp, connectionProp }) => {
      it("PRECONDITION: the switch is on the page and readable", () => {
        // Without this, every assertion below would throw rather than fail on
        // the thing under test, and a renamed aria-label would look like the
        // defect being fixed.
        renderCard({ [preferenceProp]: true, [connectionProp]: true });

        const sw = screen.getByRole("switch", { name: switchName });
        expect(sw).toBeInTheDocument();
        expect(sw.querySelector("span")).not.toBeNull();
      });

      it("reads ON when the preference is on and the provider is connected", () => {
        // The positive control. A component that drew every switch off would
        // satisfy the defect case below and fail here.
        renderCard({ [preferenceProp]: true, [connectionProp]: true });

        expectReadsOn(switchName);
      });

      it("reads OFF when the preference is on but the provider is NOT connected", () => {
        // THE DEFECT. Red before the fix: aria-checked is "true", the track is
        // blue and the knob is right, on a row that says "(not connected)" and
        // cannot be clicked.
        renderCard({ [preferenceProp]: true, [connectionProp]: false });

        expectReadsOff(switchName);
      });

      it("reads OFF when the preference is off and the provider is connected", () => {
        renderCard({ [preferenceProp]: false, [connectionProp]: true });

        expectReadsOff(switchName);
      });

      it("reads OFF when the preference is off and the provider is NOT connected", () => {
        renderCard({ [preferenceProp]: false, [connectionProp]: false });

        expectReadsOff(switchName);
      });
    },
  );

  it("the label and the switch agree: '(not connected)' never sits beside a switch that reads on", () => {
    // The founder's report, stated as he saw it rather than per-prop: turn on
    // every connection-gated preference, connect nothing, and check that no row
    // shows the contradiction. This is the assertion that would still hold if
    // the rows were renamed or re-ordered.
    renderCard({
      outlookContactsEnabled: true,
      googleContactsEnabled: true,
      outlookEmailsInferred: true,
      gmailEmailsInferred: true,
      isGoogleConnected: false,
      isMicrosoftConnected: false,
    });

    const notConnectedRows = screen
      .getAllByText("(not connected)")
      .map((label) => label.closest("div.flex.items-center.justify-between"))
      .filter((row): row is HTMLElement => row !== null);

    // Four rows carry the label; if that ever drops to zero the loop below
    // would pass vacuously.
    expect(notConnectedRows).toHaveLength(4);

    for (const row of notConnectedRows) {
      const sw = row.querySelector('[role="switch"]');
      expect(sw).not.toBeNull();
      expect(sw).toHaveAttribute("aria-checked", "false");
      expect(sw?.className).not.toContain("bg-blue-500");
    }
  });

  it("a switch with no connection to gate on still follows its preference", () => {
    // Messages / SMS has no provider behind it, so it must keep reading its
    // stored preference. This is what stops the fix from being over-applied to
    // every switch in the component.
    renderCard({ messagesInferred: true, isGoogleConnected: false, isMicrosoftConnected: false });

    expectReadsOn("Messages SMS auto-discover");
  });
});

/**
 * BACKLOG-3349 — the plan is a third term in the same rule.
 *
 * `disabled` on this row was UNASSERTED before these cases: removing
 * `|| !isMicrosoftConnected` from the Outlook-emails toggle left all 75 tests
 * of the 13 settings suites green. So each case below asserts the disabled
 * attribute as well as the drawn state, or it would be measuring nothing.
 */
describe("C9-C11 — the Outlook emails row and the plan (BACKLOG-3349)", () => {
  /** The row that owns this switch, for reading its inline label. */
  function outlookEmailsRow(): HTMLElement {
    const sw = screen.getByRole("switch", { name: "Outlook emails auto-discover" });
    const row = sw.closest("div.flex.items-center.justify-between");
    if (!row) throw new Error("Outlook emails row not found");
    return row as HTMLElement;
  }

  it("C9: blocked — disabled, drawn off, labelled and explained, even with the preference ON", () => {
    renderCard({
      outlookEmailsInferred: true,
      isMicrosoftConnected: true,
      contactInference: { outlook: "blocked", gmail: "allowed" },
    });

    const sw = screen.getByRole("switch", { name: "Outlook emails auto-discover" });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw.className).not.toContain("bg-blue-500");
    expect(sw).toHaveAttribute("title", "Not available on your current plan");
    expect(outlookEmailsRow()).toHaveTextContent("(not in your plan)");
  });

  it("C9b: blocked wins over not-connected, because connecting cannot fix it", () => {
    renderCard({
      outlookEmailsInferred: true,
      isMicrosoftConnected: false,
      contactInference: { outlook: "blocked", gmail: "allowed" },
    });

    const row = outlookEmailsRow();
    expect(row).toHaveTextContent("(not in your plan)");
    expect(row).not.toHaveTextContent("(not connected)");
    expect(screen.getByRole("switch", { name: "Outlook emails auto-discover" })).toHaveAttribute(
      "title",
      "Not available on your current plan"
    );
  });

  it("C10: allowed, connected, preference on — enabled and drawn on", () => {
    // Without this, every case above passes against a row that is permanently
    // disabled and always off.
    renderCard({
      outlookEmailsInferred: true,
      isMicrosoftConnected: true,
      contactInference: { outlook: "allowed", gmail: "allowed" },
    });

    const sw = screen.getByRole("switch", { name: "Outlook emails auto-discover" });
    expect(sw).toBeEnabled();
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw.className).toContain("bg-blue-500");
    expect(sw).not.toHaveAttribute("title");
    expect(outlookEmailsRow()).not.toHaveTextContent("(not in your plan)");
  });

  it("C11: unknown — disabled and off, but it makes NO claim about the plan", () => {
    // An offline but entitled user must not be told he did not pay for this.
    renderCard({
      outlookEmailsInferred: true,
      isMicrosoftConnected: true,
      contactInference: { outlook: "unknown", gmail: "allowed" },
    });

    const sw = screen.getByRole("switch", { name: "Outlook emails auto-discover" });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveAttribute("title", "Can't check your plan right now");
    expect(outlookEmailsRow()).not.toHaveTextContent("(not in your plan)");
  });

  it("C11b: unknown with no connection — the actionable reason wins", () => {
    renderCard({
      outlookEmailsInferred: true,
      isMicrosoftConnected: false,
      contactInference: { outlook: "unknown", gmail: "allowed" },
    });

    const row = outlookEmailsRow();
    expect(row).toHaveTextContent("(not connected)");
    expect(row).not.toHaveTextContent("(not in your plan)");
    expect(screen.getByRole("switch", { name: "Outlook emails auto-discover" })).toHaveAttribute(
      "title",
      "Connect email to enable import"
    );
  });

  it("C11c: pending — disabled and off, and silent", () => {
    renderCard({
      outlookEmailsInferred: true,
      isMicrosoftConnected: true,
      contactInference: { outlook: "pending", gmail: "allowed" },
    });

    const sw = screen.getByRole("switch", { name: "Outlook emails auto-discover" });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).not.toHaveAttribute("title");
    expect(outlookEmailsRow()).not.toHaveTextContent("(not in your plan)");
  });

  /**
   * BACKLOG-1717 CHANGED WHAT THIS CONTROL ASSERTS, DELIBERATELY.
   *
   * It read "the plan gate reaches ONLY this row — Gmail and Messages are
   * untouched", and that was right while Outlook was the only mailbox the
   * feature covered. It is now wrong: both mailboxes are ONE paid feature on
   * ONE plan key, so a customer without it must see both rows greyed.
   *
   * Leaving the old assertion standing would have pinned the interim state SR
   * measured on BACKLOG-3349 and named the trust cost of — the Outlook row
   * greyed beside a live Gmail row, which reads as "Gmail is included and
   * Outlook is not". This item closes that.
   *
   * What has NOT changed, and is still asserted: the gate does not reach the
   * Messages row. Text people are a different feature.
   */
  it("C11d: the plan gate reaches both mail rows and NOT Messages", () => {
    renderCard({
      outlookEmailsInferred: true,
      gmailEmailsInferred: true,
      messagesInferred: true,
      isMicrosoftConnected: true,
      isGoogleConnected: true,
      contactInference: { outlook: "blocked", gmail: "blocked" },
    });

    const gmail = screen.getByRole("switch", { name: "Gmail emails auto-discover" });
    expect(gmail).toBeDisabled();
    expect(gmail).toHaveAttribute("aria-checked", "false");
    expect(gmail).toHaveAttribute("title", "Not available on your current plan");

    const outlook = screen.getByRole("switch", { name: "Outlook emails auto-discover" });
    expect(outlook).toBeDisabled();

    // Texts are a different feature and this gate must not reach them.
    expect(screen.getByRole("switch", { name: "Messages SMS auto-discover" })).toBeEnabled();
  });
});
