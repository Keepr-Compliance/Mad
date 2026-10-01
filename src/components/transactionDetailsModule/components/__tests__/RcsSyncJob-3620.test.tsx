/**
 * BACKLOG-3620 — the Messages tab's Sync button and job status.
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  RcsImportPanel,
  useRcsImportSession,
  useRcsSyncJob,
} from "../RcsImportPanel";
import type { RcsJobInfo } from "../../../../services/rcsImportService";

type JobListener = (job: RcsJobInfo) => void;
let jobListener: JobListener | null = null;
// Several hooks subscribe (the panel's Sync hook and the shared Sync button,
// BACKLOG-3661): the test's jobListener reaches all of them.
const jobListeners = new Set<JobListener>();
const dispatchJob: JobListener = (j) => jobListeners.forEach((l) => l(j));
let clearedListener: ((e: { messagesDeleted: number }) => void) | null = null;
let changedListener: ((e: { reason: string }) => void) | null = null;

const mockStartJob = jest.fn();
const mockCancelJob = jest.fn();
const mockGetJob = jest.fn();

jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    startSession: jest.fn(),
    endSession: jest.fn(),
    getStatus: jest.fn(),
    onChatReceived: () => () => {},
    startJob: (...a: unknown[]) => mockStartJob(...a),
    cancelJob: (...a: unknown[]) => mockCancelJob(...a),
    getJob: (...a: unknown[]) => mockGetJob(...a),
    onJobProgress: (cb: JobListener) => {
      jobListeners.add(cb);
      jobListener = dispatchJob;
      return () => {
        jobListeners.delete(cb);
        if (jobListeners.size === 0) jobListener = null;
      };
    },
    onDataCleared: (cb: (e: { messagesDeleted: number }) => void) => {
      clearedListener = cb;
      return () => {
        clearedListener = null;
      };
    },
    onDataChanged: (cb: (e: { reason: string }) => void) => {
      changedListener = cb;
      return () => {
        changedListener = null;
      };
    },
  },
}));

function job(over: Partial<RcsJobInfo> = {}): RcsJobInfo {
  return {
    jobId: "11111111-2222-4333-8444-555555555555", // pii-allow-uuid: invented, not from any live row
    transactionId: "tx-1",
    state: "created",
    stage: "Waiting for Messages for Web to open in Chrome",
    progress: { listed: 0, candidates: 0, checked: 0, matched: 0, imported: 0, messages: 0, images: 0, reactions: 0, skipped: 0 },
    contactsWithoutPhone: [],
    createdAt: "2026-09-29T00:00:00.000Z",
    ...over,
  };
}

function Harness({ transactionId, onImported }: { transactionId: string; onImported?: () => void }) {
  const controller = useRcsImportSession(transactionId);
  const sync = useRcsSyncJob(transactionId, onImported);
  return <RcsImportPanel controller={controller} sync={sync} />;
}

beforeEach(() => {
  jest.clearAllMocks();
  jobListener = null;
  mockGetJob.mockResolvedValue({ success: true, data: null });
  mockCancelJob.mockResolvedValue({ success: true, data: null });
});

describe("Sync job (BACKLOG-3620)", () => {
  it("Sync starts a job for this transaction and shows its progress; a new import refreshes the messages", async () => {
    const onImported = jest.fn();
    mockStartJob.mockResolvedValue({ success: true, data: job() });
    render(<Harness transactionId="tx-1" onImported={onImported} />);

    fireEvent.click(screen.getByTestId("rcs-sync-button"));
    await waitFor(() => expect(mockStartJob).toHaveBeenCalledWith("tx-1"));
    expect(await screen.findByTestId("rcs-sync-job-status")).toHaveTextContent("Opening Messages for Web in Chrome");
    expect(screen.getByTestId("rcs-sync-button")).toBeDisabled();

    act(() => {
      jobListener?.(job({ state: "running", stage: "Checked 1 of 2 chats", progress: { ...job().progress, candidates: 2, checked: 1, imported: 1, messages: 5, images: 1 } }));
    });
    expect(screen.getByTestId("rcs-sync-job-status")).toHaveTextContent("imported 1 chat, 5 messages, 1 images");
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  // BACKLOG-3658 (SR S1): a cache Sync is saved + auto-linked after its
  // /finish. Mutation: drop the onDataChanged subscription → red.
  it("refetches the transaction's messages when a cache Sync was saved and linked", async () => {
    const onImported = jest.fn();
    render(<Harness transactionId="tx-1" onImported={onImported} />);
    await waitFor(() => expect(changedListener).not.toBeNull());
    act(() => {
      changedListener?.({ reason: "cache-saved" });
    });
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  // BACKLOG-3657. Mutation: drop the onDataCleared subscription → red.
  it("refetches the transaction's messages when Force re-import cleared the imported texts", async () => {
    const onImported = jest.fn();
    render(<Harness transactionId="tx-1" onImported={onImported} />);
    await waitFor(() => expect(clearedListener).not.toBeNull());
    act(() => {
      clearedListener?.({ messagesDeleted: 50 });
    });
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  // BACKLOG-3642. Mutation: put the job state back into the refetch key → the
  // created→running refetch returns and this goes red.
  it("does not refetch messages when the job goes created → running; refetches on an import and once on finish", async () => {
    const onImported = jest.fn();
    mockStartJob.mockResolvedValue({ success: true, data: job() });
    render(<Harness transactionId="tx-1" onImported={onImported} />);
    fireEvent.click(screen.getByTestId("rcs-sync-button"));
    await screen.findByTestId("rcs-sync-job");
    act(() => {
      jobListener?.(job({ state: "running", stage: "Checking chat 1 of 9" }));
    });
    expect(onImported).not.toHaveBeenCalled();
    act(() => {
      jobListener?.(job({ state: "running", progress: { ...job().progress, imported: 1, messages: 50 } }));
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    act(() => {
      jobListener?.(job({ state: "finished", stage: "Done", progress: { ...job().progress, imported: 1, messages: 50 } }));
    });
    expect(onImported).toHaveBeenCalledTimes(2);
  });

  // BACKLOG-3641 (founder): no summary in Keepr when the Sync is over — the
  // button returns from "Syncing…" to "Sync". Mutation: render the finished
  // or cancelled state again → red.
  it.each(["finished", "cancelled"] as const)("%s: no Sync panel, the button reads Sync again", async (state) => {
    mockStartJob.mockResolvedValue({ success: true, data: job() });
    render(<Harness transactionId="tx-1" />);
    fireEvent.click(screen.getByTestId("rcs-sync-button"));
    await screen.findByTestId("rcs-sync-job");
    expect(screen.getByTestId("rcs-sync-button")).toHaveTextContent("Syncing…");
    act(() => {
      jobListener?.(job({
        state,
        stage: "Done",
        progress: { ...job().progress, listed: 60, candidates: 2, checked: 2, matched: 1, imported: 1, messages: 50, notChecked: 58, removedNotRelinked: 7 },
        notReached: [{ name: "Sample Person", reason: "history_truncated" }],
      }));
    });
    expect(screen.queryByTestId("rcs-sync-job")).toBeNull();
    expect(screen.queryByText(/Scanned|Not fully imported|Close/)).toBeNull();
    expect(screen.getByTestId("rcs-sync-button")).toHaveTextContent(/^Sync$/);
    expect(screen.getByTestId("rcs-sync-button")).not.toBeDisabled();
  });

  // Mutation: no length cap on the failure line → red.
  it("a failure is one short line, and it can be dismissed", async () => {
    mockStartJob.mockResolvedValue({ success: true, data: job() });
    render(<Harness transactionId="tx-1" />);
    fireEvent.click(screen.getByTestId("rcs-sync-button"));
    await screen.findByTestId("rcs-sync-job");
    act(() => {
      jobListener?.(job({ state: "failed", error: { code: "scan_failed", message: "x".repeat(400) } }));
    });
    const line = screen.getByTestId("rcs-sync-job-status").textContent ?? "";
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.endsWith("…")).toBe(true);
    expect(screen.queryByTestId("rcs-sync-job-counts")).toBeNull();
    fireEvent.click(screen.getByTestId("rcs-sync-job-dismiss"));
    expect(screen.queryByTestId("rcs-sync-job")).toBeNull();
  });

  it("shows the not-signed-in message from the page", async () => {
    mockStartJob.mockResolvedValue({ success: true, data: job() });
    render(<Harness transactionId="tx-1" />);
    fireEvent.click(screen.getByTestId("rcs-sync-button"));
    await screen.findByTestId("rcs-sync-job");
    act(() => {
      jobListener?.(job({ state: "failed", error: { code: "not_signed_in", message: "Sign in to Google Messages, then click Sync in Keepr again" } }));
    });
    expect(screen.getByTestId("rcs-sync-job-status")).toHaveTextContent("Sign in to Google Messages, then click Sync in Keepr again");
    expect(screen.getByTestId("rcs-sync-job")).toHaveAttribute("data-state", "failed");
  });

  it("ignores a job for another transaction", async () => {
    render(<Harness transactionId="tx-1" />);
    await waitFor(() => expect(mockGetJob).toHaveBeenCalled());
    act(() => {
      jobListener?.(job({ transactionId: "tx-2", state: "running" }));
    });
    expect(screen.queryByTestId("rcs-sync-job")).toBeNull();
  });

  it("leaving the tab does not cancel the job; coming back shows it again", async () => {
    mockStartJob.mockResolvedValue({ success: true, data: job() });
    const { unmount } = render(<Harness transactionId="tx-1" />);
    fireEvent.click(screen.getByTestId("rcs-sync-button"));
    await screen.findByTestId("rcs-sync-job");
    unmount();
    expect(mockCancelJob).not.toHaveBeenCalled();

    mockGetJob.mockResolvedValue({ success: true, data: job({ state: "running", stage: "Checked 0 of 1 chats" }) });
    render(<Harness transactionId="tx-1" />);
    expect(await screen.findByTestId("rcs-sync-job")).toHaveAttribute("data-state", "running");
  });

  it("shows the start error", async () => {
    mockStartJob.mockResolvedValue({ success: false, error: "This transaction has no contacts to look for." });
    render(<Harness transactionId="tx-1" />);
    fireEvent.click(screen.getByTestId("rcs-sync-button"));
    expect(await screen.findByTestId("rcs-sync-error")).toHaveTextContent("This transaction has no contacts to look for.");
  });
});

// BACKLOG-3661 — one Sync at a time. Mutations that turn these red: the Sync
// button ignoring a job of ANOTHER transaction; no "Syncing: <name>" + Cancel.
describe("only one Sync at a time (BACKLOG-3661)", () => {
  it("while another transaction syncs: 'Syncing…' disabled, says what is syncing, and Cancel cancels THAT job", async () => {
    render(<Harness transactionId="tx-1" />);
    await waitFor(() => expect(jobListener).not.toBeNull());
    act(() => {
      jobListener?.(job({ jobId: "22222222-2222-4333-8444-555555555555", transactionId: "tx-2", state: "running", label: "2 Test Street" })); // pii-allow-uuid: invented
    });
    const button = screen.getByTestId("rcs-sync-button");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Syncing…");
    expect(screen.getByTestId("rcs-sync-active-elsewhere")).toHaveTextContent("Syncing: 2 Test Street");
    mockCancelJob.mockResolvedValue({ success: true, data: null });
    fireEvent.click(screen.getByTestId("rcs-sync-active-cancel"));
    expect(mockCancelJob).toHaveBeenCalledWith("22222222-2222-4333-8444-555555555555"); // pii-allow-uuid: invented

    act(() => {
      jobListener?.(job({ jobId: "22222222-2222-4333-8444-555555555555", transactionId: "tx-2", state: "cancelled", label: "2 Test Street" })); // pii-allow-uuid: invented
    });
    expect(screen.getByTestId("rcs-sync-button")).not.toBeDisabled();
    expect(screen.getByTestId("rcs-sync-button")).toHaveTextContent("Sync");
    expect(screen.queryByTestId("rcs-sync-active-elsewhere")).toBeNull();
  });

  // SR 2a optional (2). Mutation: let the late first read overwrite the
  // broadcast → the button stays "Syncing…" for a job that already ended.
  it("a late first read does not overwrite a newer broadcast", async () => {
    let answer: (v: unknown) => void = () => {};
    mockGetJob.mockReturnValue(new Promise((r) => {
      answer = r;
    }));
    render(<Harness transactionId="tx-1" />);
    await waitFor(() => expect(jobListener).not.toBeNull());
    act(() => {
      jobListener?.(job({ transactionId: "tx-2", state: "finished", label: "2 Test Street" }));
    });
    await act(async () => {
      answer({ success: true, data: job({ transactionId: "tx-2", state: "running", label: "2 Test Street" }) });
    });
    expect(screen.getByTestId("rcs-sync-button")).not.toBeDisabled();
    expect(screen.queryByTestId("rcs-sync-active-elsewhere")).toBeNull();
  });

  it("this transaction's own Sync: 'Syncing…' disabled, with no second 'Syncing:' line", async () => {
    mockStartJob.mockResolvedValue({ success: true, data: job() });
    render(<Harness transactionId="tx-1" />);
    fireEvent.click(screen.getByTestId("rcs-sync-button"));
    await screen.findByTestId("rcs-sync-job");
    act(() => {
      jobListener?.(job({ state: "running", label: "1 Test Street" }));
    });
    expect(screen.getByTestId("rcs-sync-button")).toBeDisabled();
    expect(screen.getByTestId("rcs-sync-button")).toHaveTextContent("Syncing…");
    expect(screen.queryByTestId("rcs-sync-active-elsewhere")).toBeNull();
  });
});
