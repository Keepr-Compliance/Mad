/**
 * BACKLOG-3763 — the conversation view loads an image's bytes only when the
 * image comes into view.
 *
 * The metadata reply lists every attachment; no bytes are requested until the
 * image's placeholder intersects. The IntersectionObserver here is HELD: it
 * records what it observes and fires only when the test says so. Without that,
 * jsdom (which has no IntersectionObserver) takes the load-immediately
 * fallback and a component that bulk-loads every image on open would pass.
 *
 * Fixture provenance: the metadata reply is the shape `messages:get-attachments-batch`
 * returns after BACKLOG-3763 (id, message_id, filename, mime_type,
 * file_size_bytes); the data reply is `messages:get-attachment-data`'s
 * success / refusal union (electron/types/ipc/common.ts).
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { ConversationViewModal } from "../ConversationViewModal";
import type { Message } from "../../../types";

const mockGetMessageAttachmentsBatch = jest.fn();
const mockGetMessageAttachmentData = jest.fn();

interface HeldObserver {
  callback: IntersectionObserverCallback;
  targets: Element[];
  disconnected: boolean;
}
let observers: HeldObserver[] = [];

class HeldIntersectionObserver {
  private held: HeldObserver;
  constructor(callback: IntersectionObserverCallback) {
    this.held = { callback, targets: [], disconnected: false };
    observers.push(this.held);
  }
  observe(target: Element): void {
    this.held.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.held.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function pendingFor(attachmentId: string): Element {
  const el = document.querySelector(`[data-attachment-id="${attachmentId}"]`);
  if (!el) throw new Error(`No pending image for ${attachmentId}`);
  return el;
}

/** Fire "now visible" for the observer watching `target`. */
function scrollIntoView(target: Element): void {
  const held = observers.find((o) => !o.disconnected && o.targets.includes(target));
  if (!held) throw new Error("No live observer for target");
  act(() => {
    held.callback(
      [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

const N = 50;
const MSG_IDS = Array.from({ length: N }, (_, i) => `macos-3763-${i}`);

const messages: Message[] = MSG_IDS.map((mid, i) => ({
  id: `msg-3763-${i}`,
  user_id: "user-3763",
  channel: "imessage",
  body_text: "",
  sent_at: new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString(),
  direction: "inbound" as const,
  has_attachments: true,
  message_id: mid,
  participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
  is_false_positive: false,
  created_at: "2026-09-01T12:00:00Z",
}));

const metadata = Object.fromEntries(
  MSG_IDS.map((mid, i) => [
    mid,
    [
      {
        id: `att-3763-${i}`,
        message_id: mid,
        filename: `IMG_${i}.jpg`,
        mime_type: "image/jpeg",
        file_size_bytes: 2 * 1024 * 1024,
      },
    ],
  ]),
);

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      messages: {
        getMessageAttachmentsBatch: mockGetMessageAttachmentsBatch,
        getMessageAttachmentData: mockGetMessageAttachmentData,
      },
    },
    writable: true,
  });
});

const realIO = (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;

beforeEach(() => {
  jest.clearAllMocks();
  observers = [];
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    HeldIntersectionObserver;
  mockGetMessageAttachmentsBatch.mockResolvedValue(metadata);
  mockGetMessageAttachmentData.mockImplementation(async (id: string) => ({
    success: true,
    data: `BYTES-${id}`,
    mime_type: "image/jpeg",
  }));
});

afterAll(() => {
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIO;
});

function renderModal() {
  return render(
    <ConversationViewModal
      messages={messages}
      phoneNumber="+14155550100"
      contactName="Test Contact"
      onClose={jest.fn()}
    />,
  );
}

describe("ConversationViewModal lazy attachment bytes (BACKLOG-3763)", () => {
  it("requests no image bytes on open, only the metadata", async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getAllByTestId("attachment-image-pending")).toHaveLength(N),
    );
    // Give any eager loader a chance to run.
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetMessageAttachmentsBatch).toHaveBeenCalledTimes(1);
    expect(mockGetMessageAttachmentData).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("loads exactly the image that scrolls into view, and renders it", async () => {
    renderModal();
    const pending = await screen.findAllByTestId("attachment-image-pending");
    expect(pending).toHaveLength(N);

    scrollIntoView(pendingFor("att-3763-7"));

    const img = await screen.findByAltText("IMG_7.jpg");
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,BYTES-att-3763-7");
    expect(mockGetMessageAttachmentData).toHaveBeenCalledTimes(1);
    expect(mockGetMessageAttachmentData).toHaveBeenCalledWith("att-3763-7");
    expect(screen.getAllByTestId("attachment-image-pending")).toHaveLength(N - 1);
  });

  it("shows the existing placeholder when the bytes are refused", async () => {
    mockGetMessageAttachmentData.mockResolvedValue({ success: false, reason: "too_large" });
    renderModal();
    await screen.findAllByTestId("attachment-image-pending");

    scrollIntoView(pendingFor("att-3763-0"));

    expect(await screen.findByText("[Image: IMG_0.jpg]")).toBeInTheDocument();
  });

  it("shows a busy placeholder with a spinner until the bytes arrive, then the image", async () => {
    let resolve!: (v: unknown) => void;
    mockGetMessageAttachmentData.mockImplementation(
      () => new Promise((r) => { resolve = r; }),
    );
    renderModal();
    await screen.findAllByTestId("attachment-image-pending");
    const slot = pendingFor("att-3763-3");
    expect(slot).toHaveAttribute("aria-busy", "true");
    expect(slot.querySelector('[data-testid="attachment-image-spinner"]')).not.toBeNull();

    scrollIntoView(slot);
    await waitFor(() => expect(mockGetMessageAttachmentData).toHaveBeenCalledTimes(1));
    // Bytes still outstanding: spinner placeholder still there, no image.
    expect(document.querySelector('[data-attachment-id="att-3763-3"]')).not.toBeNull();
    expect(screen.queryByAltText("IMG_3.jpg")).toBeNull();

    await act(async () => {
      resolve({ success: true, data: "X", mime_type: "image/jpeg" });
    });
    expect(await screen.findByAltText("IMG_3.jpg")).toBeInTheDocument();
    expect(document.querySelector('[data-attachment-id="att-3763-3"]')).toBeNull();
  });

  it("replaces the spinner with a failed state (no busy flag) when loading fails", async () => {
    mockGetMessageAttachmentData.mockResolvedValue({ success: false, reason: "too_large" });
    renderModal();
    await screen.findAllByTestId("attachment-image-pending");
    scrollIntoView(pendingFor("att-3763-1"));
    expect(await screen.findByText("[Image: IMG_1.jpg]")).toBeInTheDocument();
    expect(document.querySelector('[data-attachment-id="att-3763-1"]')).toBeNull();
    expect(screen.getAllByTestId("attachment-image-failed")).toHaveLength(1);
  });
});
