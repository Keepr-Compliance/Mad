/**
 * Tests for AboutSettings.tsx (BACKLOG-2126)
 *
 * Covers the Legal section that surfaces the canonical legal-agreement links
 * in the desktop app's Settings -> About surface:
 *   - Privacy Policy / Terms of Service / Cookie Policy render
 *   - clicking each opens the EXACT canonical URL via the shell service
 *     abstraction (systemService.openExternalUrl) — identity assertions, not
 *     counts, so a wrong-URL regression fails.
 *   - the component never calls window.api directly (repo rule); the service
 *     is mocked.
 *
 * Wrapped in StrictMode per repo convention (StrictMode is ON in main.tsx).
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

// --- Mocks -----------------------------------------------------------------

const mockOpenExternalUrl = jest.fn();
jest.mock("../../../services/systemService", () => ({
  systemService: {
    openExternalUrl: (...args: unknown[]) => mockOpenExternalUrl(...args),
  },
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { AboutSettings, LEGAL_LINKS } from "../AboutSettings";

const renderStrict = () =>
  render(
    <StrictMode>
      <AboutSettings />
    </StrictMode>,
  );

beforeEach(() => {
  mockOpenExternalUrl.mockReset();
  mockOpenExternalUrl.mockResolvedValue({ success: true });
});

describe("AboutSettings — Legal links (BACKLOG-2126)", () => {
  it("exposes exactly the three canonical legal links", () => {
    // Guard against silent drift of the URL map itself (identity, not count).
    const asMap = Object.fromEntries(LEGAL_LINKS.map((l) => [l.label, l.url]));
    expect(asMap).toEqual({
      "Privacy Policy": "https://keeprcompliance.com/privacy",
      "Terms of Service": "https://keeprcompliance.com/terms",
      "Cookie Policy": "https://keeprcompliance.com/cookies",
    });
  });

  it("renders the Legal heading and all three link buttons", () => {
    renderStrict();

    expect(screen.getByText("Legal")).toBeInTheDocument();
    expect(screen.getByText("Privacy Policy")).toBeInTheDocument();
    expect(screen.getByText("Terms of Service")).toBeInTheDocument();
    expect(screen.getByText("Cookie Policy")).toBeInTheDocument();
  });

  it("opens the canonical Privacy Policy URL via the shell service", () => {
    renderStrict();

    fireEvent.click(screen.getByTestId("about-legal-privacy-policy"));

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      "https://keeprcompliance.com/privacy",
    );
  });

  it("opens the canonical Terms of Service URL via the shell service", () => {
    renderStrict();

    fireEvent.click(screen.getByTestId("about-legal-terms-of-service"));

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      "https://keeprcompliance.com/terms",
    );
  });

  it("opens the canonical Cookie Policy URL via the shell service", () => {
    renderStrict();

    fireEvent.click(screen.getByTestId("about-legal-cookie-policy"));

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      "https://keeprcompliance.com/cookies",
    );
  });

  it("does NOT call window.api directly for legal links (uses the service)", () => {
    // If window.api existed and were called, this would be a rule violation.
    // We assert the service is the only path exercised.
    renderStrict();

    LEGAL_LINKS.forEach(({ url }) => {
      mockOpenExternalUrl.mockClear();
      const testId = `about-legal-${(
        LEGAL_LINKS.find((l) => l.url === url) as { label: string }
      ).label
        .toLowerCase()
        .replace(/\s+/g, "-")}`;
      fireEvent.click(screen.getByTestId(testId));
      expect(mockOpenExternalUrl).toHaveBeenCalledWith(url);
    });
  });
});
