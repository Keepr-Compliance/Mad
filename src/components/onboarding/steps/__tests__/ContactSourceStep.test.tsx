/**
 * Tests for ContactSourceStep (TASK-2098)
 *
 * Covers:
 * - Meta configuration (hideContinue, platforms, skip)
 * - Platform-specific rendering (both sources on macOS, only Outlook on Windows)
 * - Saving preferences on Continue click
 * - Skipping defaults to macOS Contacts enabled, others disabled
 *
 * @module onboarding/steps/__tests__/ContactSourceStep.test
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactSourceStep from "../ContactSourceStep";
import type { OnboardingContext } from "../../types";

// Mock the platform context
jest.mock("../../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

import { usePlatform } from "../../../../contexts/PlatformContext";

// Mock context for testing
const createMockContext = (
  overrides: Partial<OnboardingContext> = {}
): OnboardingContext => ({
  phoneType: null,
  emailConnected: false,
  connectedEmail: null,
  emailSkipped: false,
  driverSkipped: false,
  driverSetupComplete: false,
  permissionsGranted: false,
  termsAccepted: true,
  emailProvider: null,
  authProvider: "google",
  isNewUser: true,
  isDatabaseInitialized: false,
  platform: "macos",
  userId: "test-user-123",
  isUserVerifiedInLocalDb: false,
  isResumedFromFdaRelaunch: false,
  ...overrides,
});

describe("ContactSourceStep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: macOS platform
    (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

    // Default: preferences API mocks
    jest.mocked(window.api.preferences.update).mockResolvedValue({ success: true });
  });

  // =========================================================================
  // META TESTS
  // =========================================================================

  describe("meta", () => {
    it("has correct meta.id", () => {
      expect(ContactSourceStep.meta.id).toBe("contact-source");
    });

    it("supports both platforms", () => {
      expect(ContactSourceStep.meta.platforms).toContain("macos");
      expect(ContactSourceStep.meta.platforms).toContain("windows");
    });

    it("hides shell Continue button (custom Continue inside component)", () => {
      expect(ContactSourceStep.meta.navigation?.hideContinue).toBe(true);
    });

    it("shows back button", () => {
      expect(ContactSourceStep.meta.navigation?.showBack).toBe(true);
    });

    it("has skip enabled with descriptive label", () => {
      expect(ContactSourceStep.meta.skip?.enabled).toBe(true);
      expect(ContactSourceStep.meta.skip?.label).toBeDefined();
    });

    it("no longer promises that skipping enables everything (BACKLOG-2476)", () => {
      // The old copy — "All available sources will be enabled by default" —
      // was an accurate description of the bug. Shipping the fix while the
      // skip button still said that would just relocate the dishonesty.
      expect(ContactSourceStep.meta.skip?.description).toBe(
        "We'll use the recommended sources for your setup"
      );
      expect(ContactSourceStep.meta.skip?.description).not.toMatch(
        /all available/i
      );
    });

    it("declares an onSkip handler so skipping persists the defaults", () => {
      expect(typeof ContactSourceStep.meta.skip?.onSkip).toBe("function");
    });
  });

  // =========================================================================
  // PLATFORM RENDERING TESTS
  // =========================================================================

  describe("Content - macOS", () => {
    it("renders macOS Contacts and Outlook on macOS with Microsoft auth", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ authProvider: "microsoft" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("macOS Contacts App")).toBeInTheDocument();
      expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    });

    it("renders macOS Contacts and Outlook on macOS with Google auth (TASK-2305 universal visibility)", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ authProvider: "google" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("macOS Contacts App")).toBeInTheDocument();
      // TASK-2305: Outlook is now visible for ALL users regardless of auth provider
      expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    });

    it("renders heading text", () => {
      render(
        <ContactSourceStep.Content
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

      expect(
        screen.getByText("Where do you save your contacts?")
      ).toBeInTheDocument();
    });
  });

  describe("Content - Windows", () => {
    it("renders Outlook on Windows with Microsoft auth", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", authProvider: "microsoft" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.queryByText("macOS Contacts App")).not.toBeInTheDocument();
      expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    });

    it("renders Outlook on Windows with Google auth (TASK-2305 universal visibility)", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", authProvider: "google" })}
          onAction={jest.fn()}
        />
      );

      // TASK-2305: Outlook is now visible for ALL users regardless of auth provider
      expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    });

    it("renders iPhone Contacts when phone type is iPhone", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", phoneType: "iphone" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("iPhone Contacts")).toBeInTheDocument();
    });

    it("does not render iPhone Contacts when phone type is Android", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", phoneType: "android" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.queryByText("iPhone Contacts")).not.toBeInTheDocument();
    });

    it("renders Google Contacts as selectable for Google auth users (TASK-2303)", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", authProvider: "google" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("Google Contacts")).toBeInTheDocument();
      // TASK-2303: Google Contacts is no longer "Coming Soon" — it's a selectable source
      expect(screen.queryByText("Coming Soon")).not.toBeInTheDocument();
    });

    it("renders Google Contacts for Microsoft auth users (TASK-2305 removed authProvider filter)", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", authProvider: "microsoft" })}
          onAction={jest.fn()}
        />
      );

      // Google Contacts is now visible for ALL users regardless of auth provider
      expect(screen.getByText("Google Contacts")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // ANDROID-SPECIFIC RENDERING (BACKLOG-1466)
  // =========================================================================

  describe("Content - Android phone type", () => {
    it("renders Android Phone Contacts when phone type is android", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ phoneType: "android" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("Android Phone Contacts")).toBeInTheDocument();
    });

    it("hides macOS Contacts when phone type is android", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ phoneType: "android" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.queryByText("macOS Contacts App")).not.toBeInTheDocument();
    });

    it("does not render Android Phone Contacts when phone type is iphone", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ phoneType: "iphone" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.queryByText("Android Phone Contacts")).not.toBeInTheDocument();
    });

    it("pre-selects Android Contacts and Google Contacts for Android users", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext({ phoneType: "android", authProvider: "google" })}
          onAction={onAction}
        />
      );

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(window.api.preferences.update).toHaveBeenCalledWith(
          "test-user-123",
          {
            contactSources: {
              direct: {
                outlookContacts: false,
                googleContacts: true,
                androidContacts: true,
              },
            },
          }
        );
      });
    });
  });

  // =========================================================================
  // SAVE PREFERENCES TESTS
  // =========================================================================

  describe("Content - Continue saves preferences", () => {
    it("saves preferences on Continue click", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext({ authProvider: "microsoft" })}
          onAction={onAction}
        />
      );

      // Click Continue
      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        // SSO-aware defaults: Microsoft SSO -> outlookContacts: true, googleContacts: false
        // All sources visible regardless of auth provider (TASK-2305)
        expect(window.api.preferences.update).toHaveBeenCalledWith(
          "test-user-123",
          {
            contactSources: {
              direct: {
                macosContacts: true,
                outlookContacts: true,
                googleContacts: false,
              },
            },
          }
        );
      });

      // Should navigate next after saving
      await waitFor(() => {
        expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
      });
    });

    it("saves deselected source as false", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext({ authProvider: "microsoft" })}
          onAction={onAction}
        />
      );

      // Deselect macOS Contacts by clicking it (it starts selected)
      fireEvent.click(screen.getByText("macOS Contacts App"));

      // Click Continue
      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        // macOS Contacts deselected, but SSO-aware defaults keep outlookContacts: true (Microsoft SSO)
        expect(window.api.preferences.update).toHaveBeenCalledWith(
          "test-user-123",
          {
            contactSources: {
              direct: {
                macosContacts: false,
                outlookContacts: true,
                googleContacts: false,
              },
            },
          }
        );
      });
    });

    it("proceeds without saving when no userId in context", async () => {
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext({ userId: null })}
          onAction={onAction}
        />
      );

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
      });

      // Should NOT have called preferences.update
      expect(window.api.preferences.update).not.toHaveBeenCalled();
    });

    it("continues even if preferences save fails (fail-open)", async () => {
      jest.mocked(window.api.preferences.update).mockRejectedValue(
        new Error("Save failed")
      );
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext()}
          onAction={onAction}
        />
      );

      fireEvent.click(screen.getByText("Continue"));

      // Should still navigate next despite error
      await waitFor(() => {
        expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
      });
    });
  });

  // ===========================================================================
  // BACKLOG-2479 / BACKLOG-2476 — DEFAULT CONTACT SOURCES
  //
  // The founder onboarded every test user himself and reported that on macOS
  // iPhone Contacts came up already ticked alongside macOS Contacts. Because
  // the Mac address book already carries the iPhone's contacts via iCloud, the
  // default configuration read the same people out of two sources.
  //
  // Every assertion here pins the EXACT KEY SET first, then the values. A bare
  // toEqual on the payload passes silently when a key is missing from both the
  // actual object and the expectation.
  // ===========================================================================

  describe("default source selection (BACKLOG-2479)", () => {
    /**
     * Render, click through, and return the `contactSources.direct` object
     * actually handed to the preferences API.
     *
     * `usePlatform` and `context.platform` are always set TOGETHER. They are
     * two separate inputs in this test file, and setting only one could let a
     * "skip equals continue" assertion pass while the two paths were in fact
     * reading different platforms.
     */
    const captureContinuePayload = async (
      overrides: Partial<OnboardingContext>
    ): Promise<Record<string, boolean>> => {
      const isMacOS = (overrides.platform ?? "macos") === "macos";
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS });

      render(
        <ContactSourceStep.Content
          context={createMockContext(overrides)}
          onAction={jest.fn()}
        />
      );

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(window.api.preferences.update).toHaveBeenCalled();
      });

      const [, payload] = jest.mocked(window.api.preferences.update).mock
        .calls[0] as [string, { contactSources: { direct: Record<string, boolean> } }];
      return payload.contactSources.direct;
    };

    describe("macOS + iPhone", () => {
      it("ticks macOS Contacts and Outlook for a Microsoft login, and leaves iPhone unticked", async () => {
        const direct = await captureContinuePayload({
          platform: "macos",
          phoneType: "iphone",
          authProvider: "microsoft",
        });

        expect(Object.keys(direct).sort()).toEqual([
          "googleContacts",
          "iphoneContacts",
          "macosContacts",
          "outlookContacts",
        ]);
        expect(direct).toEqual({
          macosContacts: true,
          outlookContacts: true,
          googleContacts: false,
          iphoneContacts: false,
        });
      });

      it("ticks macOS Contacts and Google for a Google login, and leaves iPhone unticked", async () => {
        const direct = await captureContinuePayload({
          platform: "macos",
          phoneType: "iphone",
          authProvider: "google",
        });

        expect(Object.keys(direct).sort()).toEqual([
          "googleContacts",
          "iphoneContacts",
          "macosContacts",
          "outlookContacts",
        ]);
        expect(direct).toEqual({
          macosContacts: true,
          googleContacts: true,
          outlookContacts: false,
          iphoneContacts: false,
        });
      });

      it("keeps the iPhone card visible and selectable — it is the pre-selection that was wrong", () => {
        (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

        render(
          <ContactSourceStep.Content
            context={createMockContext({
              platform: "macos",
              phoneType: "iphone",
              authProvider: "microsoft",
            })}
            onAction={jest.fn()}
          />
        );

        // A user can run an iPhone with iCloud contact sync off, and for them
        // this is the only address book they have. Hiding it would strand them.
        expect(screen.getByText("iPhone Contacts")).toBeInTheDocument();
      });

      it("explains on the card why iPhone starts off, so enabling it is informed", () => {
        (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

        render(
          <ContactSourceStep.Content
            context={createMockContext({
              platform: "macos",
              phoneType: "iphone",
              authProvider: "microsoft",
            })}
            onAction={jest.fn()}
          />
        );

        expect(
          screen.getByText(/already includes iPhone contacts synced through iCloud/i)
        ).toBeInTheDocument();
      });

      it("drops the note once the user ticks iPhone", () => {
        (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

        render(
          <ContactSourceStep.Content
            context={createMockContext({
              platform: "macos",
              phoneType: "iphone",
              authProvider: "microsoft",
            })}
            onAction={jest.fn()}
          />
        );

        fireEvent.click(screen.getByText("iPhone Contacts"));

        expect(
          screen.queryByText(/already includes iPhone contacts synced through iCloud/i)
        ).not.toBeInTheDocument();
      });

      it("still writes iphoneContacts: true when the user ticks it", async () => {
        (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

        render(
          <ContactSourceStep.Content
            context={createMockContext({
              platform: "macos",
              phoneType: "iphone",
              authProvider: "microsoft",
            })}
            onAction={jest.fn()}
          />
        );

        fireEvent.click(screen.getByText("iPhone Contacts"));
        fireEvent.click(screen.getByText("Continue"));

        await waitFor(() => {
          expect(window.api.preferences.update).toHaveBeenCalledWith("test-user-123", {
            contactSources: {
              direct: {
                macosContacts: true,
                outlookContacts: true,
                googleContacts: false,
                iphoneContacts: true,
              },
            },
          });
        });
      });
    });

    describe("Windows + iPhone", () => {
      it("ticks iPhone — there is no macOS address book to cover it", async () => {
        const direct = await captureContinuePayload({
          platform: "windows",
          phoneType: "iphone",
          authProvider: "microsoft",
        });

        expect(Object.keys(direct).sort()).toEqual([
          "googleContacts",
          "iphoneContacts",
          "outlookContacts",
        ]);
        expect(direct).toEqual({
          iphoneContacts: true,
          outlookContacts: true,
          googleContacts: false,
        });
      });

      it("shows no iCloud note, because the source is not off by default there", () => {
        (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

        render(
          <ContactSourceStep.Content
            context={createMockContext({
              platform: "windows",
              phoneType: "iphone",
              authProvider: "microsoft",
            })}
            onAction={jest.fn()}
          />
        );

        expect(screen.getByText("iPhone Contacts")).toBeInTheDocument();
        expect(
          screen.queryByText(/already includes iPhone contacts synced through iCloud/i)
        ).not.toBeInTheDocument();
      });
    });

    describe("Android is unchanged on both platforms", () => {
      it("writes Android + Google on macOS", async () => {
        const direct = await captureContinuePayload({
          platform: "macos",
          phoneType: "android",
          authProvider: "google",
        });

        expect(Object.keys(direct).sort()).toEqual([
          "androidContacts",
          "googleContacts",
          "outlookContacts",
        ]);
        expect(direct).toEqual({
          androidContacts: true,
          googleContacts: true,
          outlookContacts: false,
        });
      });

      it("writes Android + Google on Windows", async () => {
        const direct = await captureContinuePayload({
          platform: "windows",
          phoneType: "android",
          authProvider: "google",
        });

        expect(Object.keys(direct).sort()).toEqual([
          "androidContacts",
          "googleContacts",
          "outlookContacts",
        ]);
        expect(direct).toEqual({
          androidContacts: true,
          googleContacts: true,
          outlookContacts: false,
        });
      });

      it("never offers iPhone Contacts to an Android user", () => {
        (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

        render(
          <ContactSourceStep.Content
            context={createMockContext({
              platform: "macos",
              phoneType: "android",
            })}
            onAction={jest.fn()}
          />
        );

        expect(screen.queryByText("iPhone Contacts")).not.toBeInTheDocument();
      });
    });
  });

  // ===========================================================================
  // BACKLOG-2476 — SKIPPING MUST NOT UNDO THE DEFAULTS
  // ===========================================================================

  describe("skipping writes the same preferences as continuing (BACKLOG-2476)", () => {
    /** What `meta.skip.onSkip` persists for this user. */
    const captureSkipPayload = async (
      overrides: Partial<OnboardingContext>
    ): Promise<Record<string, boolean>> => {
      await ContactSourceStep.meta.skip!.onSkip!(createMockContext(overrides));

      const [, payload] = jest.mocked(window.api.preferences.update).mock
        .calls[0] as [string, { contactSources: { direct: Record<string, boolean> } }];
      return payload.contactSources.direct;
    };

    /** What Continue persists when the user changes nothing. */
    const captureContinuePayload = async (
      overrides: Partial<OnboardingContext>
    ): Promise<Record<string, boolean>> => {
      const isMacOS = (overrides.platform ?? "macos") === "macos";
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS });

      render(
        <ContactSourceStep.Content
          context={createMockContext(overrides)}
          onAction={jest.fn()}
        />
      );
      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(window.api.preferences.update).toHaveBeenCalled();
      });

      const [, payload] = jest.mocked(window.api.preferences.update).mock
        .calls[0] as [string, { contactSources: { direct: Record<string, boolean> } }];
      return payload.contactSources.direct;
    };

    // The populations this protects: anyone who skips, anyone who onboarded
    // before the step existed, and anyone whose best-effort write failed. Before
    // this, all three got the backend's "every source is on" answer — which
    // switched iPhone back on and undid BACKLOG-2479 entirely.
    const CASES: Array<{ name: string; ctx: Partial<OnboardingContext> }> = [
      {
        name: "macOS + iPhone + Microsoft",
        ctx: { platform: "macos", phoneType: "iphone", authProvider: "microsoft" },
      },
      {
        name: "macOS + iPhone + Google",
        ctx: { platform: "macos", phoneType: "iphone", authProvider: "google" },
      },
      {
        name: "Windows + iPhone + Microsoft",
        ctx: { platform: "windows", phoneType: "iphone", authProvider: "microsoft" },
      },
      {
        name: "macOS + Android + Google",
        ctx: { platform: "macos", phoneType: "android", authProvider: "google" },
      },
      {
        name: "Windows + Android + Microsoft",
        ctx: { platform: "windows", phoneType: "android", authProvider: "microsoft" },
      },
    ];

    for (const { name, ctx } of CASES) {
      it(`produces an identical enabled set for ${name}`, async () => {
        const skipped = await captureSkipPayload(ctx);
        jest.mocked(window.api.preferences.update).mockClear();
        const continued = await captureContinuePayload(ctx);

        // Key set first — two objects that are both missing a key would
        // otherwise compare equal and prove nothing.
        expect(Object.keys(skipped).sort()).toEqual(
          Object.keys(continued).sort()
        );
        expect(skipped).toEqual(continued);
      });
    }

    it("leaves iPhone off on macOS when skipped — the 2479 fix survives a skip", async () => {
      const direct = await captureSkipPayload({
        platform: "macos",
        phoneType: "iphone",
        authProvider: "microsoft",
      });

      expect(direct.iphoneContacts).toBe(false);
      expect(direct.macosContacts).toBe(true);
    });

    it("writes the full envelope, not a bare direct object", async () => {
      await ContactSourceStep.meta.skip!.onSkip!(
        createMockContext({ platform: "macos", phoneType: "iphone" })
      );

      expect(window.api.preferences.update).toHaveBeenCalledWith("test-user-123", {
        contactSources: {
          direct: expect.objectContaining({ iphoneContacts: false }),
        },
      });
    });

    it("writes nothing when there is no user to write for", async () => {
      await ContactSourceStep.meta.skip!.onSkip!(
        createMockContext({ userId: null })
      );

      expect(window.api.preferences.update).not.toHaveBeenCalled();
    });
  });
});
