/**
 * BACKLOG-3659 — Dashboard → Sync Android → Google Messages: install the
 * extension (from Downloads), connect, Sync, back in Keepr.
 *
 * Mutations that turn this suite red:
 *   G1 the install step skipped before the extension said hello        → "steps"
 *   G2 a running job not shown as syncing / finished not "done"         → "steps"
 *   G3 the extension not copied to Downloads when install shows         → "install step"
 *   G4 detection not polled (an installed extension never noticed)       → "install step"
 *   G5 Sync now not starting the cache job, or another job's progress shown → "connect → sync → done"
 *   C1 (P3b) Sync reachable without the current consent                 → "steps", "consent"
 *   C2 (P3b) Agree not recording the version shown                      → "consent"
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
const mockOpenChrome = jest.fn();
const mockConsent = jest.fn();

jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    getExtensionState: async () => ({ success: true, data: mockState }),
    prepareExtension: (...a: unknown[]) => mockPrepare(...a),
    showExtensionFolder: async () => undefined,
    openChromeForExtension: (...a: unknown[]) => mockOpenChrome(...a),
    startCacheJob: (...a: unknown[]) => mockStartCache(...a),
    setCacheConsent: (...a: unknown[]) => mockConsent(...a),
    cancelJob: async () => ({ success: true, data: null }),
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
const INSTALLED: RcsExtensionState = { ...INSTALLED_NO_CONSENT, consentVersion: 1, optedIn: true };

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
    expect(googleMessagesStep({ state: INSTALLED_NO_CONSENT, job: null, continued: false })).toBe("consent");
    expect(googleMessagesStep({ state: { ...INSTALLED, consentRequired: 2 }, job: null, continued: false })).toBe("consent");
    expect(googleMessagesStep({ state: { ...NOT_INSTALLED, consentVersion: 1 }, job: null, continued: true })).toBe("connect");
    expect(googleMessagesStep({ state: NOT_INSTALLED, job: null, continued: true })).toBe("consent");
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

  it("consent: shown before any Sync; Agree records the version shown, then Connect (C1, C2)", async () => {
    mockState = INSTALLED_NO_CONSENT;
    const onClose = jest.fn();
    render(<GoogleMessagesSyncFlow onClose={onClose} pollMs={20} />);
    expect(await screen.findByTestId("gm-step-consent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
    expect(screen.getByTestId("gm-consent-text")).toHaveTextContent("ALL your Google Messages conversations");
    fireEvent.click(screen.getByRole("button", { name: "I agree, sync my texts" }));
    await waitFor(() => expect(mockConsent).toHaveBeenCalledWith(1));
    expect(await screen.findByTestId("gm-step-connect")).toBeInTheDocument();
    expect(mockStartCache).not.toHaveBeenCalled();
  });

  it("consent: Not now closes without recording anything", async () => {
    mockState = INSTALLED_NO_CONSENT;
    const onClose = jest.fn();
    render(<GoogleMessagesSyncFlow onClose={onClose} pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockConsent).not.toHaveBeenCalled();
  });

  it("connect → Sync now starts the cache job → progress → done with the counts (G5)", async () => {
    mockState = INSTALLED;
    const onClose = jest.fn();
    render(<GoogleMessagesSyncFlow onClose={onClose} pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
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
    act(() => {
      progressListener?.(job({ state: "finished", progress: { listed: 9, candidates: 9, checked: 9, matched: 9, imported: 7, messages: 175, images: 0, reactions: 0, skipped: 0 } } as Partial<RcsJobInfo>));
    });
    expect(screen.getByTestId("gm-step-done")).toBeInTheDocument();
    expect(screen.getByTestId("gm-chats")).toHaveTextContent("7");
    expect(screen.getByTestId("gm-messages")).toHaveTextContent("175");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a refused start says why and stays on Connect", async () => {
    mockState = INSTALLED;
    mockStartCache.mockResolvedValue({ success: false, error: "Sign in to Keepr first." });
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in to Keepr first.");
    expect(screen.getByTestId("gm-step-connect")).toBeInTheDocument();
  });
});
