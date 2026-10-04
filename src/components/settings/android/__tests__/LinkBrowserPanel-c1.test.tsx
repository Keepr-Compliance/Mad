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
const mockLinkForget = jest.fn(async () => undefined);
const mockLinkCancel = jest.fn(async () => undefined);
jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    linkState: async () => ({ success: true, data: { link: mockLink, linked: mockLinked } }),
    linkEnterCode: (code: string) => mockEnter(code),
    linkDismissWarning: async () => undefined,
    linkForget: () => mockLinkForget(),
    linkCancel: () => mockLinkCancel(),
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

  // SR (B1): "Forget link" is Keepr's own way to delete a link.
  // Mutation: the button not calling linkForget → red.
  it("linked: 'Forget link' forgets it", async () => {
    mockLinked = true;
    render(<LinkBrowserPanel />);
    await flush();
    fireEvent.click(screen.getByTestId("gm-link-forget"));
    await flush();
    expect(mockLinkForget).toHaveBeenCalledTimes(1);
  });

  // The approved mockup (KeeprEnterCode, 2026-10-03): a 480 card, padding 32,
  // gap 18, "Link your browser" 22px bold, the field 56 high with a 2px brand
  // border, mono 28px, "000 000"; Cancel (outlined) then Link (brand) at the
  // right, both 44 high. Mutations: a token off the mockup, the buttons
  // swapped, Cancel not cancelling → red.
  it("matches the mockup: card, title, field, Cancel + Link at the bottom-right", async () => {
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    render(<LinkBrowserPanel />);
    await flush();
    const panel = screen.getByTestId("gm-link-panel");
    for (const c of ["max-w-[480px]", "p-8", "gap-[18px]", "rounded-2xl", "border-[#D6D9E4]", "bg-white"]) expect(panel.className.split(" ")).toContain(c);
    const title = screen.getByTestId("gm-link-title");
    expect(title).toHaveTextContent("Link your browser");
    for (const c of ["text-[22px]", "leading-7", "font-bold"]) expect(title.className.split(" ")).toContain(c);
    expect(screen.getByText(LINK_COPY.enter)).toBeInTheDocument();
    expect(LINK_COPY.enter).toBe("Enter the code shown in Chrome");
    const input = screen.getByTestId("gm-link-code");
    expect(input.getAttribute("placeholder")).toBe("000 000");
    for (const c of ["min-h-[56px]", "border-2", "border-[#4F46E5]", "rounded-[10px]", "font-mono", "text-[28px]", "tracking-[0.2em]"]) {
      expect(input.className.split(" ")).toContain(c);
    }
    const cancel = screen.getByTestId("gm-link-cancel");
    const submit = screen.getByTestId("gm-link-submit");
    expect(cancel.nextElementSibling).toBe(submit);
    expect(cancel.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["flex", "justify-end", "gap-3"]));
    for (const c of ["min-h-[44px]", "border-[#CDD1DE]", "rounded-[10px]", "font-semibold"]) expect(cancel.className.split(" ")).toContain(c);
    for (const c of ["min-h-[44px]", "bg-[#4F46E5]", "rounded-[10px]", "font-bold", "text-white"]) expect(submit.className.split(" ")).toContain(c);
    fireEvent.click(cancel);
    await flush();
    expect(mockLinkCancel).toHaveBeenCalledTimes(1);
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
