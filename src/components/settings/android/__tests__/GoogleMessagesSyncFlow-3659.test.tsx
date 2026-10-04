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
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const mockPairCode = jest.fn();
jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    getExtensionState: async () => ({ success: true, data: mockState }),
    prepareExtension: (...a: unknown[]) => mockPrepare(...a),
    showExtensionFolder: async () => undefined,
    openChromeForExtension: (...a: unknown[]) => mockOpenChrome(...a),
    startCacheJob: (...a: unknown[]) => mockStartCache(...a),
    retryCacheJob: (...a: unknown[]) => mockRetryCache(...a),
    // C1: the reversed link panel (nothing pending).
    linkState: async () => ({ success: true, data: { link: { state: "none", intrusion: false }, linked: false } }),
    linkEnterCode: async () => ({ success: true }),
    linkDismissWarning: async () => undefined,
    setCacheConsent: (...a: unknown[]) => mockConsent(...a),
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
const { GoogleMessagesSyncFlow } = require("../GoogleMessagesSyncFlow") as typeof import("../GoogleMessagesSyncFlow");

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

  it("no consent step: never consented → straight to Connect, nothing recorded by the screen (C1)", async () => {
    mockState = INSTALLED_NO_CONSENT;
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-step-connect")).toBeInTheDocument();
    expect(screen.queryByText(/I agree/)).toBeNull();
    expect(mockConsent).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("gm-linked-row")).toHaveTextContent("Linked with your browser ✓");
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
});
