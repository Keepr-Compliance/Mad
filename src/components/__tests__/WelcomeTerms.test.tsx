/**
 * Tests for WelcomeTerms.tsx (BACKLOG-2126)
 *
 * The onboarding consent step surfaces the canonical Terms of Service and
 * Privacy Policy links. These tests assert:
 *   - both links render
 *   - clicking each opens the EXACT canonical URL via the shell service
 *     abstraction (systemService.openExternalUrl) — identity assertions.
 *   - the acceptance logic is untouched: the Accept button stays disabled
 *     until the checkbox is ticked, then invokes onAccept.
 *
 * Wrapped in StrictMode per repo convention (StrictMode is ON in main.tsx).
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

// --- Mocks -----------------------------------------------------------------

const mockOpenExternalUrl = jest.fn();
jest.mock("../../services/systemService", () => ({
  systemService: {
    openExternalUrl: (...args: unknown[]) => mockOpenExternalUrl(...args),
  },
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import WelcomeTerms, {
  WELCOME_TERMS_URL,
  WELCOME_PRIVACY_URL,
} from "../WelcomeTerms";

const mockUser = { display_name: "Dana", email: "dana@example.com" };

const renderStrict = (onAccept = jest.fn().mockResolvedValue(undefined)) => {
  render(
    <StrictMode>
      <WelcomeTerms user={mockUser} onAccept={onAccept} />
    </StrictMode>,
  );
  return { onAccept };
};

beforeEach(() => {
  mockOpenExternalUrl.mockReset();
  mockOpenExternalUrl.mockResolvedValue({ success: true });
});

describe("WelcomeTerms — legal links (BACKLOG-2126)", () => {
  it("exports the canonical Terms and Privacy URLs", () => {
    expect(WELCOME_TERMS_URL).toBe("https://keeprcompliance.com/terms");
    expect(WELCOME_PRIVACY_URL).toBe("https://keeprcompliance.com/privacy");
  });

  it("renders both legal links", () => {
    renderStrict();
    expect(screen.getByText("Terms of Service")).toBeInTheDocument();
    expect(screen.getByText("Privacy Policy")).toBeInTheDocument();
  });

  it("opens the canonical Terms URL via the shell service", () => {
    renderStrict();
    fireEvent.click(screen.getByText("Terms of Service"));
    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      "https://keeprcompliance.com/terms",
    );
  });

  it("opens the canonical Privacy URL via the shell service", () => {
    renderStrict();
    fireEvent.click(screen.getByText("Privacy Policy"));
    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      "https://keeprcompliance.com/privacy",
    );
  });
});

describe("WelcomeTerms — acceptance logic unchanged (BACKLOG-2126)", () => {
  it("keeps Accept disabled until the checkbox is ticked, then calls onAccept", () => {
    const { onAccept } = renderStrict();

    const acceptButton = screen.getByRole("button", {
      name: /accept & continue/i,
    });
    expect(acceptButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(acceptButton).toBeEnabled();

    fireEvent.click(acceptButton);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
