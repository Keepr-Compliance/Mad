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
  contactInference: { outlook: "allowed" } as const,
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
