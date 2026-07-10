import React from "react";
import { render, screen } from "@testing-library/react";
import {
  SourcePill,
  ContactSource,
  mapToSourcePillSource,
} from "./SourcePill";

describe("SourcePill", () => {
  describe("variant mapping", () => {
    it('renders "Contacts App" for source="imported"', () => {
      render(<SourcePill source="imported" />);
      expect(screen.getByText("Contacts App")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it('renders "Manual" for source="manual"', () => {
      render(<SourcePill source="manual" />);
      expect(screen.getByText("Manual")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-manual")).toBeInTheDocument();
    });

    it('renders "Contacts App" for source="contacts_app"', () => {
      render(<SourcePill source="contacts_app" />);
      expect(screen.getByText("Contacts App")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it('renders "Contacts App" for source="external"', () => {
      render(<SourcePill source="external" />);
      expect(screen.getByText("Contacts App")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it('renders "Message" for source="sms"', () => {
      render(<SourcePill source="sms" />);
      expect(screen.getByText("Message")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-message")).toBeInTheDocument();
    });

    it('renders "Outlook" for source="outlook"', () => {
      render(<SourcePill source="outlook" />);
      expect(screen.getByText("Outlook")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-outlook")).toBeInTheDocument();
    });

    it('renders "iPhone" for source="iphone"', () => {
      render(<SourcePill source="iphone" />);
      expect(screen.getByText("iPhone")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-iphone")).toBeInTheDocument();
    });

    it('renders "Android" for source="android_sync"', () => {
      render(<SourcePill source="android_sync" />);
      expect(screen.getByText("Android")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-android")).toBeInTheDocument();
    });

    it('renders "Google" for source="google_contacts"', () => {
      render(<SourcePill source="google_contacts" />);
      expect(screen.getByText("Google")).toBeInTheDocument();
      expect(screen.getByTestId("source-pill-google")).toBeInTheDocument();
    });
  });

  describe("size variants", () => {
    it("applies sm size by default", () => {
      render(<SourcePill source="contacts_app" />);
      const pill = screen.getByTestId("source-pill-contacts_app");
      expect(pill).toHaveClass("px-2", "py-0.5", "text-xs");
    });

    it("applies md size when specified", () => {
      render(<SourcePill source="contacts_app" size="md" />);
      const pill = screen.getByTestId("source-pill-contacts_app");
      expect(pill).toHaveClass("px-2.5", "py-1", "text-sm");
    });
  });

  describe("styling", () => {
    it("applies violet styles for contacts_app variant", () => {
      render(<SourcePill source="contacts_app" />);
      const pill = screen.getByTestId("source-pill-contacts_app");
      expect(pill).toHaveClass("bg-violet-100", "text-violet-700");
    });

    it("applies violet styles for external variant", () => {
      render(<SourcePill source="external" />);
      const pill = screen.getByTestId("source-pill-contacts_app");
      expect(pill).toHaveClass("bg-violet-100", "text-violet-700");
    });

    it("applies amber styles for message variant", () => {
      render(<SourcePill source="sms" />);
      const pill = screen.getByTestId("source-pill-message");
      expect(pill).toHaveClass("bg-amber-100", "text-amber-700");
    });

    it("applies green styles for manual variant", () => {
      render(<SourcePill source="manual" />);
      const pill = screen.getByTestId("source-pill-manual");
      expect(pill).toHaveClass("bg-green-100", "text-green-700");
    });

    it("applies indigo styles for outlook variant", () => {
      render(<SourcePill source="outlook" />);
      const pill = screen.getByTestId("source-pill-outlook");
      expect(pill).toHaveClass("bg-indigo-100", "text-indigo-700");
    });

    it("applies slate styles for iphone variant", () => {
      render(<SourcePill source="iphone" />);
      const pill = screen.getByTestId("source-pill-iphone");
      expect(pill).toHaveClass("bg-slate-100", "text-slate-700");
    });

    it("applies emerald styles for android variant", () => {
      render(<SourcePill source="android_sync" />);
      const pill = screen.getByTestId("source-pill-android");
      expect(pill).toHaveClass("bg-emerald-100", "text-emerald-700");
    });

    it("applies red styles for google variant", () => {
      render(<SourcePill source="google_contacts" />);
      const pill = screen.getByTestId("source-pill-google");
      expect(pill).toHaveClass("bg-red-100", "text-red-700");
    });

    it("applies custom className", () => {
      render(<SourcePill source="contacts_app" className="custom-class" />);
      const pill = screen.getByTestId("source-pill-contacts_app");
      expect(pill).toHaveClass("custom-class");
    });
  });

  describe("accessibility", () => {
    it("renders as a span element", () => {
      render(<SourcePill source="contacts_app" />);
      const pill = screen.getByTestId("source-pill-contacts_app");
      expect(pill.tagName).toBe("SPAN");
    });

    it("has correct test IDs for each variant", () => {
      const sources: ContactSource[] = ["contacts_app", "external", "sms"];
      const expectedTestIds = [
        "source-pill-contacts_app",
        "source-pill-contacts_app",
        "source-pill-message",
      ];

      sources.forEach((source, index) => {
        const { unmount } = render(<SourcePill source={source} />);
        expect(screen.getByTestId(expectedTestIds[index])).toBeInTheDocument();
        unmount();
      });
    });
  });

  // BACKLOG-1900 P0.3: distinct model sources must map to distinct pills
  // instead of falling through to the generic "email" / "Contacts App" pills.
  describe("mapToSourcePillSource", () => {
    it('maps model "iphone" to distinct "iphone" pill (not email)', () => {
      expect(mapToSourcePillSource("iphone", false)).toBe("iphone");
    });

    it('maps model "android_sync" to distinct "android_sync" pill (not email)', () => {
      expect(mapToSourcePillSource("android_sync", false)).toBe("android_sync");
    });

    it('maps model "google_contacts" to distinct "google_contacts" pill (not email)', () => {
      expect(mapToSourcePillSource("google_contacts", false)).toBe(
        "google_contacts"
      );
    });

    it('maps model "outlook" to "outlook" pill', () => {
      expect(mapToSourcePillSource("outlook", false)).toBe("outlook");
    });

    it("keeps distinct provider/device origins even when external (not imported)", () => {
      // Regression: previously isExternal collapsed these to "contacts_app".
      expect(mapToSourcePillSource("iphone", true)).toBe("iphone");
      expect(mapToSourcePillSource("android_sync", true)).toBe("android_sync");
      expect(mapToSourcePillSource("google_contacts", true)).toBe(
        "google_contacts"
      );
      expect(mapToSourcePillSource("outlook", true)).toBe("outlook");
    });

    it("preserves existing mappings", () => {
      expect(mapToSourcePillSource("manual", false)).toBe("manual");
      expect(mapToSourcePillSource("contacts_app", false)).toBe("contacts_app");
      expect(mapToSourcePillSource("email", false)).toBe("email");
      expect(mapToSourcePillSource("inferred", false)).toBe("email");
      expect(mapToSourcePillSource("sms", false)).toBe("sms");
      expect(mapToSourcePillSource("messages", false)).toBe("messages");
      // isExternal without a distinct origin still collapses to contacts_app
      expect(mapToSourcePillSource(undefined, true)).toBe("contacts_app");
      // Unknown/undefined without external falls back to email
      expect(mapToSourcePillSource(undefined, false)).toBe("email");
    });
  });
});
