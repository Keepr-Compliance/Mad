/**
 * BACKLOG-3956 — ContactSourceStep follows the sign-in provider.
 *
 * C5: a provider that arrives AFTER the step mounted updates the untouched
 *     cards; a card the user toggled keeps the user's choice.
 * C6: likely-wrong fixes. "Outlook always on" must red for a Google sign-in
 *     and for an unknown provider (null); Google is never on for null.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactSourceStep from "../ContactSourceStep";
import type { OnboardingContext } from "../../types";

jest.mock("../../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: false })),
}));

const ctx = (overrides: Partial<OnboardingContext> = {}): OnboardingContext => ({
  phoneType: "iphone",
  emailConnected: false,
  connectedEmail: null,
  emailSkipped: false,
  driverSkipped: false,
  driverSetupComplete: true,
  permissionsGranted: true,
  termsAccepted: true,
  emailProvider: null,
  authProvider: null,
  isNewUser: true,
  isDatabaseInitialized: true,
  platform: "windows",
  userId: "test-user-123",
  isUserVerifiedInLocalDb: true,
  isResumedFromFdaRelaunch: false,
  ...overrides,
});

async function continuePayload(): Promise<Record<string, boolean>> {
  fireEvent.click(screen.getByText("Continue"));
  await waitFor(() => expect(window.api.preferences.update).toHaveBeenCalled());
  const [, payload] = jest.mocked(window.api.preferences.update).mock.calls[0] as [
    string,
    { contactSources: { direct: Record<string, boolean> } },
  ];
  return payload.contactSources.direct;
}

describe("ContactSourceStep provider handling (BACKLOG-3956)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(window.api.preferences.update).mockResolvedValue({ success: true });
  });

  it("C5: provider arrives after mount, cards untouched -> Outlook ticked", async () => {
    const onAction = jest.fn();
    const { rerender } = render(
      <ContactSourceStep.Content context={ctx({ authProvider: null })} onAction={onAction} />,
    );
    rerender(
      <ContactSourceStep.Content context={ctx({ authProvider: "microsoft" })} onAction={onAction} />,
    );
    const direct = await continuePayload();
    expect(direct.outlookContacts).toBe(true);
    expect(direct.googleContacts).toBe(false);
  });

  it("C5: a card the user toggled keeps the user's choice when the provider arrives", async () => {
    const onAction = jest.fn();
    const { rerender } = render(
      <ContactSourceStep.Content context={ctx({ authProvider: null })} onAction={onAction} />,
    );
    // Outlook starts off for null; the user turns it on, then turns it off again.
    fireEvent.click(screen.getByText("Outlook / Microsoft 365"));
    fireEvent.click(screen.getByText("Outlook / Microsoft 365"));
    rerender(
      <ContactSourceStep.Content context={ctx({ authProvider: "microsoft" })} onAction={onAction} />,
    );
    const direct = await continuePayload();
    expect(direct.outlookContacts).toBe(false);
  });

  it("C5: one toggle on an untouched card flips its CURRENT default", async () => {
    // Microsoft sign-in: Outlook starts ticked; one click must untick it.
    render(
      <ContactSourceStep.Content context={ctx({ authProvider: "microsoft" })} onAction={jest.fn()} />,
    );
    fireEvent.click(screen.getByText("Outlook / Microsoft 365"));
    const direct = await continuePayload();
    expect(direct.outlookContacts).toBe(false);
  });

  it("C6: Google sign-in on Windows does not turn Outlook on", async () => {
    render(
      <ContactSourceStep.Content context={ctx({ authProvider: "google" })} onAction={jest.fn()} />,
    );
    const direct = await continuePayload();
    expect(direct.outlookContacts).toBe(false);
    expect(direct.googleContacts).toBe(true);
  });

  it("C6: unknown provider (null) turns neither Outlook nor Google on", async () => {
    render(
      <ContactSourceStep.Content context={ctx({ authProvider: null })} onAction={jest.fn()} />,
    );
    const direct = await continuePayload();
    expect(direct.outlookContacts).toBe(false);
    expect(direct.googleContacts).toBe(false);
    expect(direct.iphoneContacts).toBe(true);
  });
});
