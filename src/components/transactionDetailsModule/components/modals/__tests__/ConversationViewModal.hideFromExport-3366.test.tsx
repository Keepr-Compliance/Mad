/**
 * BACKLOG-3366 — Hide / Unhide a text from export inside the conversation view.
 *
 *   U2   "Hide from export" on bubble X calls (X's message id, true); reaction
 *        rows never get a control.
 *   U3   "Unhide" renders and works in EVERY entitlement state.
 *   U4   a hidden in-range bubble is rendered, gray (the BACKLOG-2295 classes),
 *        labelled, and explained by its own legend, with the toggle OFF.
 *   U4b  the marker 0 renders a normal bubble.
 *   U5   a click on the bubble itself never hides anything.
 *   and: no callback, no control — whatever the state or the marker.
 *
 * FIXTURES are transcribed from a real `getCommunicationsWithMessages` row
 * (dumped from the BACKLOG-3366 real-SQLite suite): the marker is the NUMBER
 * 1 or 0, never a boolean, and a text row carries `id === message_id`.
 */
import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ConversationViewModal } from "../ConversationViewModal";
import type { Communication } from "../../../types";
import type { HideFromExportState } from "../../../../../hooks/useHideFromExportState";

const mockGetMessageAttachmentsBatch = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: { messages: { getMessageAttachmentsBatch: mockGetMessageAttachmentsBatch } },
    writable: true,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMessageAttachmentsBatch.mockResolvedValue({});
});

/** One row as the shared conversation read returns it. */
function sharedReadRow(overrides: Record<string, unknown>): Communication {
  const id = overrides.id as string;
  return {
    id,
    communication_id: `comm-${id}`,
    user_id: "user-3366",
    transaction_id: "txn-3366",
    message_id: id,
    email_id: null,
    link_source: "manual",
    link_confidence: 0.9,
    match_reason: null,
    linked_at: "2026-01-10 10:00:00",
    created_at: "2026-01-10 10:00:00",
    channel: "imessage",
    communication_type: "imessage",
    body_text: "",
    body_plain: "",
    body: null,
    subject: null,
    sender: "+15550100",
    recipients: "me",
    sent_at: "2026-01-02T10:00:00",
    received_at: null,
    has_attachments: 0,
    thread_id: "macos-chat-1",
    participants: JSON.stringify({ from: "+15550100", to: ["me"] }),
    thread_display_name: null,
    direction: "inbound",
    external_id: `guid-${id}`,
    associated_message_type: null,
    associated_message_guid: null,
    hidden_from_export: 0,
    source: null,
    cc: null,
    bcc: null,
    attachment_count: null,
    ...overrides,
  } as unknown as Communication;
}

const VISIBLE = sharedReadRow({ id: "m1", body_text: "see you at closing", body_plain: "see you at closing" });
const HIDDEN = sharedReadRow({
  id: "m2",
  body_text: "personal note",
  body_plain: "personal note",
  sent_at: "2026-01-03T10:00:00",
  hidden_from_export: 1,
});
const OUTBOUND = sharedReadRow({
  id: "m3",
  body_text: "on my way",
  body_plain: "on my way",
  sent_at: "2026-01-04T10:00:00",
  direction: "outbound",
  participants: JSON.stringify({ from: "me", to: ["+15550100"] }),
});
// A tapback on m1, in the shape the importer stores: empty body, band type,
// parent guid.
const REACTION = sharedReadRow({
  id: "r1",
  sent_at: "2026-01-02T10:01:00",
  associated_message_type: 2000,
  associated_message_guid: "guid-m1",
});

const ALL_STATES: HideFromExportState[] = ["pending", "allowed", "blocked", "unknown"];

function renderModal(props: Partial<React.ComponentProps<typeof ConversationViewModal>> = {}) {
  return render(
    <ConversationViewModal
      messages={[VISIBLE, HIDDEN, OUTBOUND, REACTION]}
      phoneNumber="+15550100"
      onClose={jest.fn()}
      {...props}
    />,
  );
}

const controls = (): HTMLElement[] => screen.queryAllByTestId(/^hide-from-export-/);
const bubbleFor = (text: string): HTMLElement => {
  const el = screen.getByText(text).closest("[data-hidden-from-export]");
  if (!el) throw new Error(`No bubble for "${text}"`);
  return el as HTMLElement;
};

describe("BACKLOG-3366 — no callback, no control", () => {
  for (const state of ALL_STATES) {
    it(`state "${state}", a hidden bubble present: zero Hide/Unhide controls`, () => {
      renderModal({ hideFromExportState: state });
      expect(controls()).toHaveLength(0);
    });
  }
});

describe("BACKLOG-3366 U2 — Hide from export", () => {
  it("renders only on \"allowed\", on every non-hidden bubble, and never on a reaction row", () => {
    renderModal({ onSetHiddenFromExport: jest.fn(), hideFromExportState: "allowed" });

    expect(screen.getAllByRole("button", { name: "Hide from export" })).toHaveLength(2);
    expect(screen.getByTestId("hide-from-export-m1")).toHaveTextContent("Hide from export");
    expect(screen.getByTestId("hide-from-export-m3")).toHaveTextContent("Hide from export");
    expect(screen.queryByTestId("hide-from-export-r1")).not.toBeInTheDocument();
    // One control per rendered bubble: m1, m2 (Unhide), m3.
    expect(controls()).toHaveLength(3);
  });

  for (const state of ["pending", "blocked", "unknown"] as HideFromExportState[]) {
    it(`does not render on "${state}"`, () => {
      renderModal({ onSetHiddenFromExport: jest.fn(), hideFromExportState: state });
      expect(screen.queryByRole("button", { name: "Hide from export" })).not.toBeInTheDocument();
    });
  }

  it("clicking it on bubble X calls the callback once with (X's message id, true)", async () => {
    const onSet = jest.fn().mockResolvedValue(undefined);
    renderModal({ onSetHiddenFromExport: onSet, hideFromExportState: "allowed" });

    fireEvent.click(within(bubbleFor("on my way")).getByRole("button", { name: "Hide from export" }));

    expect(onSet).toHaveBeenCalledTimes(1);
    expect(onSet).toHaveBeenCalledWith("m3", true);
    await waitFor(() => expect(screen.getByTestId("hide-from-export-m3")).not.toBeDisabled());
  });

  it("uses the reference pill classes exactly", () => {
    renderModal({ onSetHiddenFromExport: jest.fn(), hideFromExportState: "allowed" });
    expect(screen.getByTestId("hide-from-export-m1")).toHaveClass(
      "inline-flex", "items-center", "px-3", "py-1.5", "bg-gray-200", "hover:bg-gray-300",
      "rounded-full", "text-xs", "font-medium", "text-gray-700", "transition-all",
    );
    // The wrapper matches EmailThreadViewModal's reference exactly: its `mt-2`
    // was removed on purpose (BACKLOG-2862 follow-up round 2), so none here.
    const wrapper = screen.getByTestId("hide-from-export-m1").parentElement;
    expect(wrapper?.className).toBe("flex justify-start");
  });
});

describe("BACKLOG-3366 U3 — Unhide is never gated", () => {
  for (const state of ALL_STATES) {
    it(`state "${state}": Unhide renders on the hidden bubble and calls (id, false)`, async () => {
      const onSet = jest.fn().mockResolvedValue(undefined);
      renderModal({ onSetHiddenFromExport: onSet, hideFromExportState: state });

      const unhide = within(bubbleFor("personal note")).getByRole("button", { name: "Unhide" });
      expect(unhide).toHaveAttribute("data-testid", "hide-from-export-m2");
      expect(unhide).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(unhide);

      expect(onSet).toHaveBeenCalledTimes(1);
      expect(onSet).toHaveBeenCalledWith("m2", false);
      await waitFor(() => expect(unhide).not.toBeDisabled());
    });
  }

  it("the Unhide pill on a gray bubble uses the white surface (the one deviation from the reference)", () => {
    renderModal({ onSetHiddenFromExport: jest.fn(), hideFromExportState: "blocked" });
    const unhide = screen.getByTestId("hide-from-export-m2");
    expect(unhide).toHaveClass("bg-white", "hover:bg-gray-50", "border", "border-gray-300");
    expect(unhide).not.toHaveClass("bg-gray-200");
  });
});

describe("BACKLOG-3366 U4 / U4b — how a hidden text looks", () => {
  it("U4 hidden, in range, toggle OFF: rendered gray with the 2295 classes, labelled, with its own legend", () => {
    renderModal({
      onSetHiddenFromExport: jest.fn(),
      hideFromExportState: "blocked",
      auditStartDate: "2026-01-01",
      auditEndDate: "2026-01-31",
    });

    expect(screen.getByTestId("audit-period-filter-checkbox")).not.toBeChecked();
    const bubble = bubbleFor("personal note");
    expect(bubble).toHaveAttribute("data-hidden-from-export", "true");
    // The out-of-range semantics are untouched: this bubble is IN range.
    expect(bubble).toHaveAttribute("data-out-of-range", "false");
    expect(bubble).toHaveAttribute("data-testid", "in-range-message");
    expect(bubble).toHaveClass("bg-gray-200", "text-gray-500", "border", "border-gray-300");
    expect(within(bubble).getByTestId("hidden-from-export-label")).toHaveTextContent("Hidden from export");

    const legend = screen.getByTestId("hidden-from-export-legend");
    expect(legend).toHaveTextContent(
      "Texts marked Hidden from export stay in this transaction but won’t be included in exports. Select Unhide to include them.",
    );
    expect(screen.queryByTestId("exclusion-legend")).not.toBeInTheDocument();
  });

  it("U4 a hidden OUTBOUND text is gray too, not green", () => {
    renderModal({
      messages: [sharedReadRow({ ...OUTBOUND, hidden_from_export: 1 })],
    });
    const bubble = bubbleFor("on my way");
    expect(bubble).toHaveClass("bg-gray-200", "text-gray-500");
    expect(bubble).not.toHaveClass("bg-green-500");
  });

  it("U4b the marker 0 renders a normal bubble: no gray, no label, no legend", () => {
    renderModal({ messages: [VISIBLE, OUTBOUND] });

    const inbound = bubbleFor("see you at closing");
    expect(inbound).toHaveAttribute("data-hidden-from-export", "false");
    expect(inbound).toHaveClass("bg-white");
    expect(inbound).not.toHaveClass("bg-gray-200");
    expect(bubbleFor("on my way")).toHaveClass("bg-green-500");
    expect(screen.queryByTestId("hidden-from-export-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hidden-from-export-legend")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3366 U5 — the bubble itself is not a control", () => {
  it("clicking the bubble text or the bubble calls nothing", () => {
    const onSet = jest.fn();
    renderModal({ onSetHiddenFromExport: onSet, hideFromExportState: "allowed" });

    fireEvent.click(screen.getByText("see you at closing"));
    fireEvent.click(bubbleFor("see you at closing"));
    fireEvent.click(screen.getByText("personal note"));
    fireEvent.click(bubbleFor("personal note"));

    expect(onSet).not.toHaveBeenCalled();
  });
});
