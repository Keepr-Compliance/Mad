/**
 * C1 (UX redesign) — Keepr's "Enter the code from your browser" panel. One
 * short line per state; the code is typed here (Keepr never makes one).
 * Mutations: the code not sent → red; a 5-digit code sent → red; the
 * intrusion warning not shown → red; "linked" not reported → red.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

type Link =
  | { state: "none"; intrusion: boolean }
  | { state: "waiting"; expiresAt: number; triesLeft: number; intrusion: boolean }
  | { state: "locked"; until: number; intrusion: boolean };
let mockLink: Link = { state: "none", intrusion: false };
let mockLinked = false;
const mockEnter = jest.fn(async (_code: string) => ({ success: true }) as { success: boolean; error?: string });
jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    linkState: async () => ({ success: true, data: { link: mockLink, linked: mockLinked } }),
    linkEnterCode: (code: string) => mockEnter(code),
    linkDismissWarning: async () => undefined,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LinkBrowserPanel, LINK_COPY, cleanLinkCode } = require("../LinkBrowserPanel") as typeof import("../LinkBrowserPanel");

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  mockLink = { state: "none", intrusion: false };
  mockLinked = false;
  mockEnter.mockClear();
});

describe("LinkBrowserPanel", () => {
  it("nothing pending: one line telling where to start", async () => {
    render(<LinkBrowserPanel />);
    await flush();
    expect(screen.getByTestId("gm-link-none")).toHaveTextContent(LINK_COPY.none);
    expect(screen.queryByTestId("gm-link-code")).toBeNull();
  });

  it("a code is waiting: the field; 6 digits are sent, fewer are refused here", async () => {
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    render(<LinkBrowserPanel />);
    await flush();
    expect(screen.getByText(LINK_COPY.enter)).toBeInTheDocument();
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12345" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("gm-link-submit"));
    });
    expect(mockEnter).not.toHaveBeenCalled();
    expect(screen.getByTestId("gm-link-error")).toHaveTextContent("Codes have 6 digits.");
    fireEvent.change(input, { target: { value: "123 456" } });
    expect(input.value).toBe("123456");
    await act(async () => {
      fireEvent.click(screen.getByTestId("gm-link-submit"));
    });
    expect(mockEnter).toHaveBeenCalledWith("123456");
  });

  it("a refused code says why", async () => {
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    mockEnter.mockResolvedValueOnce({ success: false, error: "That code expired. Click Link in the extension for a new one." });
    render(<LinkBrowserPanel />);
    await flush();
    fireEvent.change(screen.getByTestId("gm-link-code"), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("gm-link-submit"));
    });
    expect(screen.getByTestId("gm-link-error")).toHaveTextContent("That code expired.");
  });

  it("another app tried to link: said plainly", async () => {
    mockLink = { state: "locked", until: Date.now() + 60_000, intrusion: true };
    render(<LinkBrowserPanel />);
    await flush();
    expect(screen.getByTestId("gm-link-intrusion")).toHaveTextContent(LINK_COPY.locked);
  });

  it("linked: the parent is told", async () => {
    mockLinked = true;
    const onLinked = jest.fn();
    render(<LinkBrowserPanel onLinked={onLinked} />);
    await flush();
    expect(screen.getByTestId("gm-link-linked")).toHaveTextContent(LINK_COPY.linked);
    expect(onLinked).toHaveBeenCalledTimes(1);
  });

  // Live (B2): a code from the browser gets its field even when Keepr already
  // counts a link; "Link a browser" is always there. Mutations: linked
  // hiding the field → red; no "Link a browser" → red.
  it("linked AND a code waiting: the field is shown (a new link replaces the old)", async () => {
    mockLinked = true;
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    render(<LinkBrowserPanel />);
    await flush();
    expect(screen.getByTestId("gm-link-code")).toBeInTheDocument();
  });

  it("linked: 'Link a browser' tells where to start", async () => {
    mockLinked = true;
    render(<LinkBrowserPanel />);
    await flush();
    fireEvent.click(screen.getByTestId("gm-link-another"));
    expect(screen.getByTestId("gm-link-none")).toHaveTextContent(LINK_COPY.none);
  });

  it("cleanLinkCode: digits only, at most 6", () => {
    expect(cleanLinkCode("12-34 56789")).toBe("123456");
  });
});

// C4 (founder): Keepr never makes a pairing code any more. Mutation: the
// old IPC brought back → red.
describe("no Keepr-made codes (C4)", () => {
  it("no pair-code / pair-cancel IPC in the preload or the handlers", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const root = path.join(__dirname, "..", "..", "..", "..", "..");
    for (const f of ["electron/preload/rcsImportBridge.ts", "electron/handlers/rcsImportHandlers.ts", "src/services/rcsImportService.ts"]) {
      expect([f, /rcs-import:pair-(code|cancel)|pairCode\(/.test(fs.readFileSync(path.join(root, f), "utf8"))]).toEqual([f, false]);
    }
  });
});
