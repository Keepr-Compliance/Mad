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
import { googleMessagesStep, syncCopyLine } from "../googleMessagesSyncSteps";

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
  it("install step: copies the extension to Downloads, copies the address, notices the install (G3, G4)", async () => {
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-step-install")).toBeInTheDocument();
    await waitFor(() => expect(mockPrepare).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("gm-step-install")).toHaveTextContent("Downloads folder (Downloads › Keepr Extension)"));
    fireEvent.click(screen.getByRole("button", { name: "Open Chrome (address copied)" }));
    expect(await screen.findByText(/address is copied/)).toBeInTheDocument();
    expect(screen.getByTestId("gm-detect")).toHaveTextContent("Waiting for the extension");
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

  it("copy line: one short line under the Sync button with the configured months (C2)", async () => {
    mockState = { ...INSTALLED, lookbackMonths: 6 };
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-copy-line")).toHaveTextContent(
      "Keepr copies your texts from the last 6 months to this computer, encrypted. Change this in Settings → Messages.",
    );
    expect(syncCopyLine(null)).toBe("Keepr copies all your texts to this computer, encrypted.");
    expect(syncCopyLine(12)).toContain("from the last year");
    expect(syncCopyLine(1.5)).toContain("from the last 1.5 months");
    expect(syncCopyLine(undefined)).toBe("Keepr copies your texts to this computer, encrypted.");
  });

  // Founder: "Change" opens Settings → Messages at the months control.
  // Mutation: the link not calling onOpenSettings → red.
  it("copy line: Change opens Settings at the months control (C3)", async () => {
    mockState = { ...INSTALLED, lookbackMonths: 3 };
    const onOpenSettings = jest.fn();
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} onOpenSettings={onOpenSettings} pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("connect → Sync now starts the cache job → progress → done with the counts (G5)", async () => {
    mockState = INSTALLED;
    const onClose = jest.fn();
    render(<GoogleMessagesSyncFlow onClose={onClose} pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Google Messages and sync" }));
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
    const progress = { listed: 21, candidates: 21, checked: 21, matched: 21, imported: 9, messages: 328, images: 0, reactions: 0, skipped: 0, noMessagesYet: 2, notText: 1 };
    act(() => {
      progressListener?.(job({ state: "finished", progress } as Partial<RcsJobInfo>));
    });
    // Finished, not saved yet: no staged counts on screen.
    expect(screen.getByTestId("gm-step-done")).toHaveTextContent("Saving your texts…");
    expect(screen.getByTestId("gm-done-summary")).not.toHaveTextContent("328");
    act(() => {
      progressListener?.(job({ state: "finished", progress, saved: { chats: 7, messages: 212, newMessages: 212, reactions: 9, newReactions: 4 } } as Partial<RcsJobInfo>));
    });
    // H4: what Keepr SAVED, not the 328 the page sent.
    const summary = screen.getByTestId("gm-done-summary");
    expect(summary).toHaveTextContent("Scanned 21 chats · saved 7 chats · 212 messages (212 new) · 9 reactions (4 new)");
    expect(summary).toHaveTextContent("2 chats with no messages yet");
    expect(summary).toHaveTextContent("1 not a text conversation (e.g. an AI chat) — skipped");
    expect(summary).not.toHaveTextContent("328");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("connect copy: the pairing instruction until both checks are ticked (G6)", async () => {
    mockState = INSTALLED;
    const view = render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-pair-instruction")).toHaveTextContent(
      "In Chrome, open Google Messages and sign in with your Google account or scan the QR code with your phone. Leave Remember this computer on.",
    );
    expect(screen.getByTestId("gm-step-connect")).toHaveTextContent("Keep that Chrome window visible until it is done.");
    view.unmount();
    mockState = { ...INSTALLED, pairedAt: "2026-10-01T10:05:00.000Z" };
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    expect(await screen.findByTestId("gm-sync-note")).toHaveTextContent("Keep that Chrome window visible until it is done.");
    expect(screen.queryByTestId("gm-pair-instruction")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Google Messages and sync" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Open Google Messages and sync" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {
      fail({ success: false, error: "ENOENT: copyfile" });
    });
    expect(screen.queryByText(/ENOENT/)).toBeNull();
  });

  // C1 (UX redesign): Connect shows the link panel until the extension is
  // linked with this Keepr; Sync stays off until then. Mutations: no link
  // panel, or Sync enabled while unlinked → red.
  it("unlinked: the link panel shows, Sync waits until linked", async () => {
    mockState = { ...INSTALLED, extensionPaired: false };
    render(<GoogleMessagesSyncFlow onClose={() => {}} />);
    expect(await screen.findByTestId("gm-link-panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Google Messages and sync" })).toBeDisabled();
  });

  /** Sync now, then the run ends as `over` (failed / cancelled). */
  async function failedRun(over: Partial<RcsJobInfo>): Promise<void> {
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Google Messages and sync" }));
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
    await failedRun({ state: "failed", error: { code: "keepr_lost", message: "Keepr closed or restarted." } } as Partial<RcsJobInfo>);
    const step = await screen.findByTestId("gm-step-failed");
    expect(step).toHaveTextContent("Sync failed");
    expect(step).toHaveTextContent("Keepr closed or restarted.");
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
