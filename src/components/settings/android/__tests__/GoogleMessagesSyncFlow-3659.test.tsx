/**
 * BACKLOG-3659 — Dashboard → Sync Android → Google Messages: install the
 * extension (from Downloads), connect, Sync, back in Keepr.
 *
 * Mutations that turn this suite red:
 *   G1 the install step skipped before the extension said hello        → "steps"
 *   G2 a running job not shown as syncing / finished not "done"         → "steps"
 *   G3 the extension not copied to Downloads when install shows         → "install step"
 *   G4 detection not polled (an installed extension never noticed)       → "install step"
 *   G6 the pairing instruction shown with both checks ticked, or hidden before → "connect copy"
 *   H4 the done screen showing staged counts, not what Keepr saved      → "connect → sync → done"
 *   G5 the Sync button not starting the cache job, or another job's progress shown → "connect → sync → done"
 *   C1 a consent step shown again (founder: removed 2026-10-01)         → "steps", "no consent step"
 *   C2 the copy line not under the Sync button / wrong months            → "copy line"
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { RcsExtensionState, RcsJobInfo } from "../../../../../electron/types/ipc/window-api-rcs-import";
import { googleMessagesStep } from "../googleMessagesSyncSteps";

let mockState: RcsExtensionState;
let progressListener: ((j: RcsJobInfo) => void) | null = null;
const mockPrepare = jest.fn();
const mockStartCache = jest.fn();
const mockRetryCache = jest.fn();
const mockOpenChrome = jest.fn();
const mockConsent = jest.fn();
let mockCurrentJob: RcsJobInfo | null = null;
let mockLinkState = (): unknown => ({ success: true, data: { link: { state: "none", intrusion: false }, linked: false } });

jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    getExtensionState: async () => ({ success: true, data: mockState }),
    prepareExtension: (...a: unknown[]) => mockPrepare(...a),
    showExtensionFolder: async () => undefined,
    openChromeForExtension: (...a: unknown[]) => mockOpenChrome(...a),
    startCacheJob: (...a: unknown[]) => mockStartCache(...a),
    retryCacheJob: (...a: unknown[]) => mockRetryCache(...a),
    setCacheConsent: (...a: unknown[]) => mockConsent(...a),
    // C1: the reversed link panel (nothing pending).
    linkState: async () => mockLinkState(),
    linkEnterCode: async () => ({ success: true }),
    linkDismissWarning: async () => undefined,
    onOpenLinkScreen: () => () => undefined,
    takeLinkCodePrefill: () => null,
    cancelJob: async () => ({ success: true, data: null }),
    getJob: async () => ({ success: true, data: mockCurrentJob }),
    onJobProgress: (cb: (j: RcsJobInfo) => void) => {
      progressListener = cb;
      return () => {
        progressListener = null;
      };
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GoogleMessagesSyncFlow, LINKED_FLASH_MS, syncWindowNote } = require("../GoogleMessagesSyncFlow") as typeof import("../GoogleMessagesSyncFlow");

const NOT_INSTALLED: RcsExtensionState = { extensionVersion: null, extensionSeenAt: null, pairedAt: null, optedIn: false, lastCacheFinishedAt: null };
const INSTALLED_NO_CONSENT: RcsExtensionState = {
  ...NOT_INSTALLED, extensionVersion: "0.3.4", extensionSeenAt: "2026-10-01T10:00:00.000Z", consentVersion: null, consentRequired: 1,
};
const INSTALLED: RcsExtensionState = { ...INSTALLED_NO_CONSENT, consentVersion: 1, optedIn: true, extensionPaired: true };

function job(over: Partial<RcsJobInfo> = {}): RcsJobInfo {
  return {
    jobId: "job-1",
    transactionId: "",
    kind: "cache",
    state: "created",
    stage: "Waiting for Messages for Web to open in Chrome",
    progress: { listed: 0, candidates: 0, checked: 0, matched: 0, imported: 0, messages: 0, images: 0, reactions: 0, skipped: 0 },
    contactsWithoutPhone: [],
    createdAt: "2026-10-01T10:00:00.000Z",
    ...over,
  } as RcsJobInfo;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentJob = null;
  mockState = NOT_INSTALLED;
  mockPrepare.mockResolvedValue({ success: true, data: { folder: "C:\\Users\\u\\Downloads\\Keepr Extension", version: "0.3.4" } });
  mockOpenChrome.mockResolvedValue({ copied: true, opened: true });
  mockStartCache.mockResolvedValue({ success: true, data: job() });
  mockConsent.mockImplementation(async () => {
    mockState = INSTALLED;
    return { success: true };
  });
});

// Live (0.3.76): right after Keepr restarts, a SAVED link is unproven (the
// proof is in memory) — never the link step for it: "Checking the
// browser…", then the linked screen. The link step only with nothing saved,
// an extension saying "no link here", or Relink.
// Mutations: the saved pairing ignored (link step at once) → red; no
// timeout (checking forever) → red; "no link here" ignored → red.
describe("a saved link right after Keepr starts (0.3.76)", () => {
  const SAVED_UNPROVEN: RcsExtensionState = { ...INSTALLED, extensionPaired: false, pairingSaved: true, linkNotHere: false };

  it("checking first, never the link step; then the linked screen when the check window ends", async () => {
    mockState = SAVED_UNPROVEN;
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} linkCheckMs={150} />);
    expect(await screen.findByTestId("gm-link-checking-browser")).toHaveTextContent("Checking the browser…");
    expect(screen.queryByTestId("gm-link-panel")).toBeNull();
    expect(await screen.findByTestId("gm-linked-screen", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByTestId("gm-link-panel")).toBeNull();
    expect(screen.queryByTestId("gm-link-checking-browser")).toBeNull();
  });

  it("the extension proves the link during the check: the linked screen at once", async () => {
    mockState = SAVED_UNPROVEN;
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} linkCheckMs={60_000} />);
    await screen.findByTestId("gm-link-checking-browser");
    mockState = { ...SAVED_UNPROVEN, extensionPaired: true };
    expect(await screen.findByTestId("gm-linked-screen")).toBeInTheDocument();
  });

  it("nothing saved: the link step at once (no check)", async () => {
    mockState = { ...SAVED_UNPROVEN, pairingSaved: false };
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} linkCheckMs={60_000} />);
    expect(await screen.findByTestId("gm-link-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("gm-link-checking-browser")).toBeNull();
  });

  it("an extension said \"no link here\": the link step at once", async () => {
    mockState = { ...SAVED_UNPROVEN, linkNotHere: true };
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} linkCheckMs={60_000} />);
    expect(await screen.findByTestId("gm-link-panel")).toBeInTheDocument();
  });

  it("Relink (startAtLink): the link step, not the check", async () => {
    mockState = SAVED_UNPROVEN;
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} linkCheckMs={60_000} startAtLink />);
    expect(await screen.findByTestId("gm-link-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("gm-link-checking-browser")).toBeNull();
  });
});

describe("googleMessagesStep (G1, G2)", () => {
  it("steps", () => {
    expect(googleMessagesStep({ state: NOT_INSTALLED, job: null, continued: false })).toBe("install");
    expect(googleMessagesStep({ state: INSTALLED, job: null, continued: false })).toBe("connect");
    expect(googleMessagesStep({ state: INSTALLED_NO_CONSENT, job: null, continued: false })).toBe("connect");
    expect(googleMessagesStep({ state: { ...INSTALLED, consentRequired: 2 }, job: null, continued: false })).toBe("connect");
    expect(googleMessagesStep({ state: NOT_INSTALLED, job: null, continued: true })).toBe("connect");
    expect(googleMessagesStep({ state: INSTALLED, job: job({ state: "running" }), continued: false })).toBe("syncing");
    expect(googleMessagesStep({ state: INSTALLED, job: job({ state: "finished" }), continued: false })).toBe("done");
    expect(googleMessagesStep({ state: INSTALLED, job: job({ state: "cancelled" }), continued: false })).toBe("failed");
  });
});

describe("GoogleMessagesSyncFlow", () => {
  // Storyboard J01 (beta install; until the extension is published, everyone):
  // BETA, "Add the Keepr extension", 3 numbered lines, Open Chrome (address
  // copied), "Waiting for the extension…" — nothing else. Mutations: a
  // paragraph / warning / Show folder back; no auto-advance → red.
  it("install (J01, beta): the label, the title, 3 lines, Open Chrome, waiting — nothing else", async () => {
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    const step = await screen.findByTestId("gm-step-install");
    await waitFor(() => expect(mockPrepare).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("gm-beta-label")).toHaveTextContent("BETA");
    expect(screen.getByRole("heading")).toHaveTextContent("Add the Keepr extension");
    const lines = Array.from(screen.getByTestId("gm-install-steps").children).map((c) => c.textContent);
    expect(lines).toEqual([
      "1Open Chrome, paste the address, press Enter",
      "2Turn on Developer mode",
      "3Load unpacked › Downloads › Keepr Extension",
    ]);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Open Chrome (address copied)"]);
    expect(step.querySelectorAll("p")).toHaveLength(0);
    expect(step).not.toHaveTextContent("Developer-mode extensions");
    expect(step).not.toHaveTextContent("Show folder");
    fireEvent.click(screen.getByTestId("gm-open-chrome"));
    expect(mockOpenChrome).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("gm-detect")).toHaveTextContent("Waiting for the extension…");
    mockState = INSTALLED;
    // Installed: the flow moves on to Connect by itself.
    expect(await screen.findByTestId("gm-step-connect")).toBeInTheDocument();
  });

  it("no consent screen: never consented → straight to Connect, nothing recorded by opening it (C1)", async () => {
    mockState = INSTALLED_NO_CONSENT;
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-step-connect")).toBeInTheDocument();
    expect(screen.queryByText(/I agree/)).toBeNull();
    expect(mockConsent).not.toHaveBeenCalled();
  });

  // SR C7 (founder-approved copy): before the first Sync, ONE line and
  // [Agree and sync] — the consent recorded (its version), then the Sync.
  // Mutations: the line missing; Sync started without recording consent;
  // a failed save still starting the Sync → red.
  it("first Sync: the consent line and Agree and sync — consent recorded, then the Sync", async () => {
    mockState = { ...INSTALLED_NO_CONSENT, extensionPaired: true };
    const order: string[] = [];
    mockConsent.mockImplementation(async (v: unknown) => {
      order.push("consent:" + String(v));
      mockState = INSTALLED;
      return { success: true };
    });
    mockStartCache.mockImplementation(async () => {
      order.push("start");
      return { success: true, data: job() };
    });
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-consent-line")).toHaveTextContent(
      /^Keepr copies your texts from Google Messages into Keepr on this computer.$/,
    );
    expect(screen.getByTestId("gm-sync-now")).toHaveTextContent("Agree and sync");
    // Founder (2026-10-05): only the line, Agree and sync and the months note.
    // Mutation: the linked row shown before consent → red.
    expect(screen.queryByTestId("gm-linked-row")).toBeNull();
    expect(screen.getByTestId("gm-window-note")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Agree and sync"]);
    fireEvent.click(screen.getByTestId("gm-sync-now"));
    await waitFor(() => expect(order).toEqual(["consent:1", "start"]));
  });

  it("first Sync: the consent not saved → its error, no Sync", async () => {
    mockState = { ...INSTALLED_NO_CONSENT, extensionPaired: true };
    mockConsent.mockResolvedValue({ success: false, error: "Sign in to Keepr first." });
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    fireEvent.click(await screen.findByText("Agree and sync"));
    expect(await screen.findByText("Sign in to Keepr first.")).toBeInTheDocument();
    expect(mockStartCache).not.toHaveBeenCalled();
  });

  // Live (founder): Chrome runs the old unpacked copy until it is reloaded.
  // Mutations: the line not shown; shown for a store install → red.
  // Live (founder): the line on EVERY Connect screen — the check and the
  // link card too, not only the linked screen. Mutation: on the linked
  // screen only → red.
  it("\"update ready\" on the checking screen and on the link card too", async () => {
    mockState = { ...INSTALLED, extensionPaired: false, pairingSaved: true, linkNotHere: false, extensionUpdateReady: true };
    const { unmount } = render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} linkCheckMs={60_000} />);
    expect(await screen.findByTestId("gm-link-checking-browser")).toBeInTheDocument();
    expect(screen.getByTestId("gm-extension-update")).toBeInTheDocument();
    unmount();
    mockState = { ...INSTALLED, extensionPaired: false, pairingSaved: false, extensionUpdateReady: true };
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-extension-update")).toBeInTheDocument();
    expect(screen.queryByTestId("gm-linked-screen")).toBeNull();
  });

  it("an older extension seen: one \"update ready\" line (unpacked only)", async () => {
    mockState = { ...INSTALLED, extensionUpdateReady: true };
    const { unmount } = render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-extension-update")).toHaveTextContent("Extension update ready. In chrome://extensions, click ↻ on Keepr.");
    unmount();
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} published />);
    expect(await screen.findByTestId("gm-sync-now")).toBeInTheDocument();
    expect(screen.queryByTestId("gm-extension-update")).toBeNull();
  });

  it("consent current: no line, Sync now", async () => {
    mockState = INSTALLED;
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-sync-now")).toHaveTextContent("Sync now");
    expect(screen.queryByTestId("gm-consent-line")).toBeNull();
    expect(screen.queryByTestId("gm-extension-update")).toBeNull();
    // B2 again once consent is given: the linked row is back.
    expect(screen.getByTestId("gm-linked-row")).toHaveTextContent("Linked with your browser");
  });

  // Storyboard B02 / I02: linked — "Sync Android", "Linked with your browser
  // ✓", Sync now; nothing else. Then A11: ✓ "Your texts are synced", the one
  // count line, "Added to your transactions by phone number.", Done.
  // Mutations: the old checks / notes / copy line back; staged counts shown;
  // the summary not the storyboard line → red.
  it("linked (B02) → Sync now → progress → done (A11) with what Keepr saved", async () => {
    mockState = INSTALLED;
    const onClose = jest.fn();
    render(<GoogleMessagesSyncFlow onClose={onClose} pollMs={20} />);
    const connect = await screen.findByTestId("gm-step-connect");
    expect(screen.getByRole("heading")).toHaveTextContent("Sync Android");
    // Founder (B2): no trailing ✓ (the icon shows it).
    expect(screen.getByTestId("gm-linked-row").textContent).toBe("Linked with your browser");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Sync now"]);
    expect(connect).not.toHaveTextContent("STEP");
    expect(screen.queryByTestId("gm-copy-line")).toBeNull();
    fireEvent.click(screen.getByTestId("gm-sync-now"));
    await waitFor(() => expect(mockStartCache).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("gm-step-syncing")).toBeInTheDocument();
    act(() => {
      progressListener?.(job({ jobId: "other-job", state: "finished" })); // not ours
    });
    expect(screen.getByTestId("gm-step-syncing")).toBeInTheDocument();
    act(() => {
      progressListener?.(job({ state: "running", stage: "Chat 3 of 9" }));
    });
    expect(screen.getByTestId("gm-stage")).toHaveTextContent("Chat 3 of 9");
    expect(screen.getByTestId("gm-step-syncing")).toHaveTextContent("Keep the Google Messages tab open until it is done.");
    const progress = { listed: 21, candidates: 21, checked: 21, matched: 21, imported: 9, messages: 328, images: 0, reactions: 0, skipped: 0 };
    act(() => {
      progressListener?.(job({ state: "finished", progress } as Partial<RcsJobInfo>));
    });
    // Finished, not saved yet: no staged counts on screen.
    expect(screen.getByTestId("gm-step-done")).toHaveTextContent("Saving your texts…");
    expect(screen.getByTestId("gm-done-summary")).not.toHaveTextContent("328");
    act(() => {
      progressListener?.(job({ state: "finished", progress, saved: { chats: 20, messages: 412, newMessages: 38, reactions: 9, newReactions: 4, photos: 64 } } as Partial<RcsJobInfo>));
    });
    expect(screen.getByRole("heading")).toHaveTextContent("Your texts are synced");
    expect(screen.getByTestId("gm-done-summary")).toHaveTextContent(/^20 chats · 412 messages \(38 new\) · 64 photos$/);
    expect(screen.getByTestId("gm-step-done")).toHaveTextContent("Added to your transactions by phone number.");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // BACKLOG-3658: reopened from the dashboard indicator while a cache Sync
  // runs → that Sync's live progress, then its result. Mutation: the
  // running job not adopted on open → red.
  it("reopened while a cache Sync runs: shows its live progress and result", async () => {
    mockState = INSTALLED;
    mockCurrentJob = job({ jobId: "job-live", state: "running", stage: "Chat 4 of 21" });
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-stage")).toHaveTextContent("Chat 4 of 21");
    act(() => {
      progressListener?.(job({ jobId: "job-live", state: "running", stage: "Chat 5 of 21" }));
    });
    expect(screen.getByTestId("gm-stage")).toHaveTextContent("Chat 5 of 21");
  });

  it("reopened after a Sync ended (and was saved): the normal start, not the old run", async () => {
    mockState = INSTALLED;
    mockCurrentJob = job({ jobId: "job-old", state: "finished", saved: { chats: 1, messages: 1, newMessages: 1 } } as Partial<RcsJobInfo>);
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-step-connect")).toBeInTheDocument();
  });

  it("a refused start says why and stays on Connect", async () => {
    mockState = INSTALLED;
    mockStartCache.mockResolvedValue({ success: false, error: "Sign in to Keepr first." });
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in to Keepr first.");
    expect(screen.getByTestId("gm-step-connect")).toBeInTheDocument();
  });

  // Live ENOENT: the effect ran twice under StrictMode. Mutation: drop the
  // once-per-flow guard → red.
  it("StrictMode: the extension is prepared once per flow", async () => {
    render(
      <React.StrictMode>
        <GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />
      </React.StrictMode>,
    );
    await screen.findByTestId("gm-step-install");
    await new Promise((r) => setTimeout(r, 30));
    expect(mockPrepare).toHaveBeenCalledTimes(1);
  });

  it("a prepare error is not shown once the flow has left the install step", async () => {
    let fail: (v: unknown) => void = () => undefined;
    mockPrepare.mockReturnValue(new Promise((r) => {
      fail = r;
    }));
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    await screen.findByTestId("gm-step-install");
    mockState = INSTALLED; // the extension arrives: Connect
    await screen.findByTestId("gm-step-connect");
    await act(async () => {
      fail({ success: false, error: "ENOENT: copyfile" });
    });
    expect(screen.queryByText(/ENOENT/)).toBeNull();
  });

  // C1 (UX redesign): Connect shows the link panel until the extension is
  // linked with this Keepr; Sync stays off until then. Mutations: no link
  // panel, or Sync enabled while unlinked → red.
  // Founder (2026-10-04): not linked — the link card is the one thing to do;
  // the Sync button and its notice appear only once linked. Mutation: the
  // Sync shown (or its notice) while unlinked → red.
  // Storyboard D01: the link card IS the step — its own title, the two steps,
  // no card border (the modal frames it), no "STEP 2 OF 2", no checks list.
  it("unlinked (D01): the bare link card is the step; no Sync button or notice until linked", async () => {
    mockState = { ...INSTALLED, extensionPaired: false };
    render(<GoogleMessagesSyncFlow onClose={() => {}} />);
    const panel = await screen.findByTestId("gm-link-panel");
    expect(panel.className.split(" ")).not.toContain("border");
    expect(panel.className.split(" ")).toContain("gap-4");
    expect(screen.getByTestId("gm-step-connect").firstElementChild).toBe(panel);
    expect(screen.getByTestId("gm-link-title")).toHaveTextContent("Link your browser");
    expect(screen.getByTestId("gm-step-connect")).not.toHaveTextContent("STEP");
    expect(screen.queryByTestId("check-ok")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Google Messages and sync" })).toBeNull();
    expect(screen.queryByTestId("gm-sync-note")).toBeNull();
    expect(screen.queryByTestId("gm-pair-instruction")).toBeNull();
    expect(screen.queryByTestId("gm-copy-line")).toBeNull();
  });

  // Founder (2026-10-04): Settings' Link / Relink (and keepr://link) open this
  // flow at the link step — even when linked (Relink); the old link goes only
  // when the new code succeeds. Mutation: the request ignored → red.
  it("opened at the link step (Relink): the link card, even when linked", async () => {
    mockState = INSTALLED; // linked
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} startAtLink />);
    expect(await screen.findByTestId("gm-link-step-1")).toBeInTheDocument();
    expect(screen.getByTestId("gm-link-step-2")).toBeInTheDocument();
    expect(screen.queryByTestId("gm-sync-now")).toBeNull();
  });

  it("not asked: a linked flow opens at Sync now (B02)", async () => {
    mockState = INSTALLED;
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-sync-now")).toBeInTheDocument();
    expect(screen.queryByTestId("gm-link-step-1")).toBeNull();
  });

  /** Sync now, then the run ends as `over` (failed / cancelled). */
  async function failedRun(over: Partial<RcsJobInfo>): Promise<void> {
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    await screen.findByTestId("gm-step-syncing");
    mockStartCache.mockClear();
    act(() => {
      progressListener?.(job(over));
    });
    await screen.findByTestId("gm-step-failed");
  }

  // Founder (2026-10-04): a FAILED Sync's Try again starts the retry at once
  // (the chats it saved are skipped; Messages opened by Keepr). A cancelled
  // one goes back to the start. Mutations: Try again not calling the retry
  // → red; a cancelled Sync retried → red.
  it("failed: 'Sync failed', the reason, Try again starts the retry", async () => {
    mockState = INSTALLED;
    mockRetryCache.mockResolvedValue({ success: true, data: job({ jobId: "job-2", state: "created" }) });
    await failedRun({ state: "failed", error: { code: "connection_lost", message: "Keepr stopped: Messages for Web could not reconnect to your phone for 5 minutes." } } as Partial<RcsJobInfo>);
    const step = await screen.findByTestId("gm-step-failed");
    expect(step).toHaveTextContent("Sync failed");
    expect(step).toHaveTextContent("Lost the connection to your phone.");
    expect(step).not.toHaveTextContent("5 minutes");
    fireEvent.click(screen.getByTestId("gm-try-again"));
    await waitFor(() => expect(mockRetryCache).toHaveBeenCalledTimes(1));
    expect(mockStartCache).not.toHaveBeenCalled();
    expect(await screen.findByTestId("gm-step-syncing")).toBeInTheDocument();
  });

  it("cancelled: Try again goes back to the start (no retry)", async () => {
    mockState = INSTALLED;
    await failedRun({ state: "cancelled" });
    fireEvent.click(screen.getByTestId("gm-try-again"));
    expect(await screen.findByTestId("gm-step-connect")).toBeInTheDocument();
    expect(mockRetryCache).not.toHaveBeenCalled();
  });

  // Founder (B2): the linked screen — the row and Sync now centred in the
  // body (the modal keeps its size), the window note at the bottom with
  // Change. Mutations: not centred; the note's wording; Change not wired;
  // the note shown while a Sync runs → red.
  it("B2: row + Sync now centred; 'Syncs your last N months of texts. Change'", async () => {
    mockState = { ...INSTALLED, lookbackMonths: 1.5 };
    const onOpenSettings = jest.fn();
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} onOpenSettings={onOpenSettings} pollMs={20} />);
    const screenEl = await screen.findByTestId("gm-linked-screen");
    expect(screenEl.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-[360px]"]));
    const body = screen.getByTestId("gm-linked-body");
    expect(body.className.split(" ")).toEqual(expect.arrayContaining(["flex-1", "flex", "flex-col", "justify-center"]));
    expect(body.contains(screen.getByTestId("gm-linked-row"))).toBe(true);
    expect(body.contains(screen.getByTestId("gm-sync-now"))).toBe(true);
    expect(screen.getByTestId("gm-window-note")).toHaveTextContent("Syncs your last 1.5 months of texts. Change");
    expect(screenEl.lastElementChild).toBe(screen.getByTestId("gm-window-note"));
    fireEvent.click(screen.getByTestId("gm-window-change"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(syncWindowNote(3)).toBe("Syncs your last 3 months of texts.");
    expect(syncWindowNote(12)).toBe("Syncs your last year of texts.");
    expect(syncWindowNote(1)).toBe("Syncs your last month of texts.");
    expect(syncWindowNote(null)).toBe("Syncs all your texts.");
    // Hidden while the Sync runs.
    fireEvent.click(screen.getByTestId("gm-sync-now"));
    await screen.findByTestId("gm-step-syncing");
    expect(screen.queryByTestId("gm-window-note")).toBeNull();
  });

  // Founder (D05): after a correct code the field's green ✓ for ~1 s, then
  // the SAME linked screen as B2; at once under reduced motion. Mutations:
  // no switch; switching before the flash; a second linked component → red.
  it("D05: the green ✓ for 1 s, then the B2 screen (at once under reduced motion)", async () => {
    jest.useFakeTimers();
    try {
      mockState = { ...INSTALLED, extensionPaired: false };
      let linked = false;
      mockLinkState = () => ({
        success: true,
        data: { link: linked ? { state: "none", intrusion: false } : { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false }, linked },
      });
      render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
      await act(async () => {
        jest.advanceTimersByTime(50);
      });
      const input = await screen.findByTestId("gm-link-code");
      await act(async () => {
        fireEvent.change(input, { target: { value: "482913" } });
      });
      linked = true;
      await act(async () => {
        jest.advanceTimersByTime(1000); // the panel's poll sees the link
      });
      expect(screen.getByTestId("gm-link-ok")).toBeInTheDocument();
      expect(screen.queryByTestId("gm-linked-screen")).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(LINKED_FLASH_MS);
      });
      expect(screen.getByTestId("gm-linked-screen")).toBeInTheDocument();
      expect(screen.queryByTestId("gm-link-code")).toBeNull();
      expect(screen.getByTestId("gm-linked-row").textContent).toBe("Linked with your browser");
    } finally {
      jest.useRealTimers();
      mockLinkState = () => ({ success: true, data: { link: { state: "none", intrusion: false }, linked: false } });
    }
  });


  it("D05 under reduced motion: the linked screen at once (no flash)", async () => {
    jest.useFakeTimers();
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q })) as unknown as typeof window.matchMedia;
    try {
      mockState = { ...INSTALLED, extensionPaired: false };
      let linked = false;
      mockLinkState = () => ({
        success: true,
        data: { link: linked ? { state: "none", intrusion: false } : { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false }, linked },
      });
      render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
      await act(async () => {
        jest.advanceTimersByTime(50);
      });
      await act(async () => {
        fireEvent.change(await screen.findByTestId("gm-link-code"), { target: { value: "482913" } });
      });
      linked = true;
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId("gm-linked-screen")).toBeInTheDocument();
    } finally {
      window.matchMedia = mm;
      jest.useRealTimers();
      mockLinkState = () => ({ success: true, data: { link: { state: "none", intrusion: false }, linked: false } });
    }
  });

});
