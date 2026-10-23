/**
 * BACKLOG-4038 — the license-blocked screen: founder-approved wording per
 * reason, the three actions, and no trial/limit copy anywhere.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { UpgradeScreen, upgradeReasonFor, type UpgradeReason } from "../UpgradeScreen";

const COPY: Record<UpgradeReason, { title: string; body: string }> = {
  suspended: {
    title: "Your account is paused",
    body: "This usually follows a payment dispute or a request from support. Sign in on the Keepr website to review your billing, or contact support.",
  },
  ended: {
    title: "Your Keepr license has ended",
    body: "Sign in on the Keepr website to see your plan and billing.",
  },
  unknown: {
    title: "Your Keepr license isn't active",
    body: "Sign in on the Keepr website to see your plan and billing.",
  },
};

const REASONS = Object.keys(COPY) as UpgradeReason[];

// window.api.support is not in tests/setup.js; the dialog's hook calls all four.
// BACKLOG-4038: shape of support_categories rows as support:get-categories returns
// them (select("*"), SupportCategory in useSupportTicket.ts). Ids are deliberately
// not the seeded ids, so a hardcoded id cannot pass the slug test.
const CATEGORIES = [
  { id: "cat-technical", name: "Technical Issue", slug: "technical-issue", description: null, parent_id: null, sort_order: 1, is_active: true },
  { id: "cat-billing", name: "Billing & Subscription", slug: "billing-subscription", description: null, parent_id: null, sort_order: 3, is_active: true },
];

function installSupportApi(categories: unknown[] = CATEGORIES): { submitTicket: jest.Mock } {
  const submitTicket = jest.fn().mockResolvedValue({ success: true, ticket_id: "t1", ticket_number: 42 });
  (window.api as unknown as { support: Record<string, jest.Mock> }).support = {
    getCategories: jest.fn().mockResolvedValue({ success: true, categories }),
    collectDiagnostics: jest.fn().mockResolvedValue({ success: true, diagnostics: null }),
    captureScreenshot: jest.fn().mockResolvedValue({ success: true, screenshot: null }),
    submitTicket,
  };
  return { submitTicket };
}

let submitTicket: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  ({ submitTicket } = installSupportApi());
  jest.mocked(window.api.auth.getUserContact).mockResolvedValue({ success: false, name: "", email: "" });
});

describe("UpgradeScreen (BACKLOG-4038)", () => {
  it.each(REASONS)("%s renders its exact title and body", (reason) => {
    render(<UpgradeScreen reason={reason} onLogout={jest.fn()} />);
    expect(screen.getByRole("heading", { name: COPY[reason].title })).toBeInTheDocument();
    expect(screen.getByText(COPY[reason].body)).toBeInTheDocument();
  });

  it.each(REASONS)("%s shows no trial, 14-day or 5-transaction copy, and no feature list", (reason) => {
    const { container } = render(<UpgradeScreen reason={reason} onLogout={jest.fn()} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/trial/i);
    expect(text).not.toMatch(/14-day/i);
    expect(text).not.toMatch(/5 transactions/i);
    expect(text).not.toMatch(/With a paid plan/i);
  });

  it.each(REASONS)("%s has exactly the three approved buttons", (reason) => {
    render(<UpgradeScreen reason={reason} onLogout={jest.fn()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Manage billing on the website",
      "Contact support",
      "Sign out",
    ]);
  });

  it("Manage billing on the website calls billing:open-portal once, with no argument, and opens nothing else", async () => {
    render(<UpgradeScreen reason="ended" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Manage billing on the website" }));
    expect(window.api.billing.openPortal).toHaveBeenCalledTimes(1);
    expect(jest.mocked(window.api.billing.openPortal).mock.calls[0]).toEqual([]);
    expect(window.api.shell.openExternal).not.toHaveBeenCalled();
  });

  it("Contact support opens the in-app support form, presets the subject, and opens no mailto", async () => {
    render(<UpgradeScreen reason="suspended" onLogout={jest.fn()} />);
    expect(screen.queryByRole("heading", { name: "Contact Support" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
    expect(await screen.findByRole("heading", { name: "Contact Support" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Subject/)).toHaveValue("Account or billing: Your account is paused");
    expect(window.api.shell.openExternal).not.toHaveBeenCalled();
    expect(window.api.billing.openPortal).not.toHaveBeenCalled();
  });

  it("the support form pre-fills name and email from main for the blocked user id", async () => {
    jest.mocked(window.api.auth.getUserContact).mockResolvedValue({
      success: true,
      name: "Agent Name",
      email: "agent@example.com",
    });
    render(<UpgradeScreen reason="ended" userId="u1" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
    expect(await screen.findByLabelText(/Your Email/)).toHaveValue("agent@example.com");
    expect(screen.getByLabelText(/Your Name/)).toHaveValue("Agent Name");
    expect(window.api.auth.getUserContact).toHaveBeenCalledWith("u1");
  });

  it("with nothing to read, the form opens with empty, editable name and email", async () => {
    render(<UpgradeScreen reason="ended" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
    const email = await screen.findByLabelText(/Your Email/);
    expect(email).toHaveValue("");
    await userEvent.type(email, "typed@example.com");
    expect(email).toHaveValue("typed@example.com");
  });

  it.each(["suspended", "ended", "unknown"] as const)(
    "%s: priority starts High and the category resolves to Billing & Subscription by slug",
    async (reason) => {
      render(<UpgradeScreen reason={reason} onLogout={jest.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
      expect(await screen.findByLabelText(/Priority/)).toHaveValue("high");
      await waitFor(() => expect(screen.getByLabelText(/Category/)).toHaveValue("cat-billing"));
    },
  );

  it("a category list without the billing slug leaves the category unset", async () => {
    installSupportApi([CATEGORIES[0]]);
    render(<UpgradeScreen reason="suspended" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
    await screen.findByRole("option", { name: "Technical Issue" });
    expect(screen.getByLabelText(/Category/)).toHaveValue("");
    expect(screen.getByLabelText(/Priority/)).toHaveValue("high");
  });

  it("the user can change the preset priority and category", async () => {
    render(<UpgradeScreen reason="suspended" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
    await waitFor(() => expect(screen.getByLabelText(/Category/)).toHaveValue("cat-billing"));
    await userEvent.selectOptions(screen.getByLabelText(/Priority/), "low");
    await userEvent.selectOptions(screen.getByLabelText(/Category/), "cat-technical");
    expect(screen.getByLabelText(/Priority/)).toHaveValue("low");
    expect(screen.getByLabelText(/Category/)).toHaveValue("cat-technical");
  });

  it("submitting the support form calls support.submitTicket and shows the dialog's confirmation", async () => {
    render(<UpgradeScreen reason="ended" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
    await userEvent.type(await screen.findByLabelText(/Your Name/), "Agent Name");
    await userEvent.type(screen.getByLabelText(/Your Email/), "agent@example.com");
    await userEvent.type(screen.getByLabelText(/Description/), "My license shows as ended.");
    const submit = screen.getByRole("button", { name: "Submit Ticket" });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    expect(submitTicket).toHaveBeenCalledTimes(1);
    expect(submitTicket.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        subject: "Account or billing: Your Keepr license has ended",
        description: "My license shows as ended.",
        requester_email: "agent@example.com",
        requester_name: "Agent Name",
        priority: "high",
        category_id: "cat-billing",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Ticket Submitted" })).toBeInTheDocument();
  });

  it("a failed submit keeps the dialog's error and the support email stays visible as text", async () => {
    submitTicket.mockResolvedValue({ success: false, error: "Network unavailable" });
    render(<UpgradeScreen reason="unknown" onLogout={jest.fn()} />);
    expect(screen.getByTestId("upgrade-support-email")).toHaveTextContent("support@keeprcompliance.com");
    await userEvent.click(screen.getByRole("button", { name: "Contact support" }));
    await userEvent.type(await screen.findByLabelText(/Your Name/), "A");
    await userEvent.type(screen.getByLabelText(/Your Email/), "a@example.com");
    await userEvent.type(screen.getByLabelText(/Description/), "help");
    const submit = screen.getByRole("button", { name: "Submit Ticket" });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    expect(await screen.findByText("Network unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("upgrade-support-email")).toHaveTextContent("support@keeprcompliance.com");
  });

  it("Sign out runs the provided logout handler", async () => {
    const onLogout = jest.fn().mockResolvedValue(undefined);
    render(<UpgradeScreen reason="unknown" onLogout={onLogout} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("upgradeReasonFor (BACKLOG-4038)", () => {
  it.each([
    ["expired", "ended"],
    ["suspended", "suspended"],
    ["limit_reached", "unknown"],
    ["no_license", "unknown"],
    ["load_error", "unknown"],
    ["transaction_limit", "unknown"],
    ["", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ] as const)("%p -> %p", (input, expected) => {
    expect(upgradeReasonFor(input)).toBe(expected);
  });
});
