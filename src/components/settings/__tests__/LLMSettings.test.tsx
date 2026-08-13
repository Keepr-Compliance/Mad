/**
 * Tests for LLMSettings.tsx
 * Covers API key management, provider tabs, consent modal, and feature toggles
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { LLMSettings } from "../LLMSettings";
import type { LLMProvider, LLMUserConfig } from "../../../../electron/types/ipc/llm";

describe("LLMSettings", () => {
  const mockUserId = "user-123";

  const defaultConfig: LLMUserConfig = {
    hasOpenAI: false,
    hasAnthropic: false,
    // Cast: the IPC type declares preferredProvider as a non-nullable
    // LLMProvider, but the DB column and the renderer's own LLMUserConfig
    // (LLMSettings.tsx) both allow null — "no provider chosen yet" — which is
    // exactly the state this default fixture models.
    preferredProvider: null as unknown as LLMProvider,
    openAIModel: "gpt-4o",
    anthropicModel: "claude-sonnet-4-20250514",
    tokensUsed: 0,
    budgetLimit: 100000,
    platformAllowanceRemaining: 10000,
    usePlatformAllowance: true,
    autoDetectEnabled: false,
    roleExtractionEnabled: false,
    hasConsent: true,
  };

  const defaultUsage = {
    tokensThisMonth: 5000,
    budgetLimit: 100000,
    platformAllowance: 10000,
    platformUsed: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    jest.mocked(window.api.llm.getConfig).mockResolvedValue({
      success: true,
      data: defaultConfig,
    });
    jest.mocked(window.api.llm.getUsage).mockResolvedValue({
      success: true,
      data: defaultUsage,
    });
    jest.mocked(window.api.llm.validateKey).mockResolvedValue({
      success: true,
      data: true,
    });
    jest.mocked(window.api.llm.setApiKey).mockResolvedValue({ success: true });
    jest.mocked(window.api.llm.removeApiKey).mockResolvedValue({ success: true });
    jest.mocked(window.api.llm.updatePreferences).mockResolvedValue({ success: true });
    jest.mocked(window.api.llm.recordConsent).mockResolvedValue({ success: true });
  });

  describe("Rendering", () => {
    it("should render loading state initially", () => {
      jest.mocked(window.api.llm.getConfig).mockImplementation(
        () => new Promise(() => {}) // Never resolves to show loading
      );

      render(<LLMSettings userId={mockUserId} />);

      // Should show spinner
      const spinner = document.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();
    });

    it("should render provider tabs", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "OpenAI" })).toBeInTheDocument();
      });

      expect(screen.getByRole("button", { name: "Anthropic" })).toBeInTheDocument();
    });

    it("should show OpenAI tab as active by default", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        const openaiTab = screen.getByRole("button", { name: "OpenAI" });
        expect(openaiTab).toHaveClass("border-purple-500");
      });
    });

    it("should show usage display when usage data is available", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Usage This Month")).toBeInTheDocument();
      });

      expect(screen.getByText("5.0K")).toBeInTheDocument(); // 5000 tokens formatted
      expect(screen.getByText("tokens used")).toBeInTheDocument();
    });

    it("should show feature toggles", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("AI Features")).toBeInTheDocument();
      });

      expect(screen.getByText("Auto-Detect Transactions")).toBeInTheDocument();
      expect(screen.getByText("Role Extraction")).toBeInTheDocument();
    });

    it("should show platform allowance toggle", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Use Platform Allowance")).toBeInTheDocument();
      });
    });
  });

  describe("Provider Tabs", () => {
    it("should switch to Anthropic tab when clicked", async () => {
      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Anthropic" })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Anthropic" }));

      expect(screen.getByRole("button", { name: "Anthropic" })).toHaveClass("border-purple-500");
    });

    it("should show different model options for each provider", async () => {
      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("GPT-4o (Recommended)")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Anthropic" }));

      await waitFor(() => {
        expect(screen.getByText("Claude Sonnet 4 (Recommended)")).toBeInTheDocument();
      });
    });
  });

  describe("API Key Management", () => {
    it("should show API key input with placeholder", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        const input = screen.getByPlaceholderText(/enter your openai api key/i);
        expect(input).toBeInTheDocument();
      });
    });

    it("should show masked key when key exists", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasOpenAI: true },
      });

      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        const input = screen.getByPlaceholderText(/enter your openai api key/i);
        expect(input).toHaveValue("********************************");
      });
    });

    it("should toggle key visibility when show/hide button is clicked", async () => {
      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/enter your openai api key/i)).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/enter your openai api key/i);
      expect(input).toHaveAttribute("type", "password");

      // Find and click the show/hide button (first button with SVG that's in the input container)
      const toggleButton = screen.getByTitle("Show key");
      await user.click(toggleButton);

      expect(input).toHaveAttribute("type", "text");
    });

    it("should show validate button", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /validate key/i })).toBeInTheDocument();
      });
    });

    it("should call validateKey when validate button is clicked", async () => {
      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/enter your openai api key/i)).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/enter your openai api key/i);
      await user.type(input, "sk-test-key-123");

      const validateButton = screen.getByRole("button", { name: /validate key/i });
      await user.click(validateButton);

      expect(window.api.llm.validateKey).toHaveBeenCalledWith("openai", "sk-test-key-123");
    });

    it("should show valid status after successful validation", async () => {
      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/enter your openai api key/i)).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/enter your openai api key/i);
      await user.type(input, "sk-test-key-123");

      const validateButton = screen.getByRole("button", { name: /validate key/i });
      await user.click(validateButton);

      await waitFor(() => {
        expect(screen.getByText("API key is valid")).toBeInTheDocument();
      });
    });

    it("should show invalid status after failed validation", async () => {
      jest.mocked(window.api.llm.validateKey).mockResolvedValue({
        success: true,
        data: false,
      });

      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/enter your openai api key/i)).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/enter your openai api key/i);
      await user.type(input, "invalid-key");

      const validateButton = screen.getByRole("button", { name: /validate key/i });
      await user.click(validateButton);

      await waitFor(() => {
        expect(screen.getByText("Invalid API key")).toBeInTheDocument();
      });
    });

    it("should show save button after entering a new key and validating", async () => {
      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/enter your openai api key/i)).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/enter your openai api key/i);
      await user.type(input, "sk-test-key-123");

      const validateButton = screen.getByRole("button", { name: /validate key/i });
      await user.click(validateButton);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /save key/i })).toBeInTheDocument();
      });
    });

    it("should call setApiKey when save button is clicked", async () => {
      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/enter your openai api key/i)).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/enter your openai api key/i);
      await user.type(input, "sk-test-key-123");

      const validateButton = screen.getByRole("button", { name: /validate key/i });
      await user.click(validateButton);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /save key/i })).toBeInTheDocument();
      });

      const saveButton = screen.getByRole("button", { name: /save key/i });
      await user.click(saveButton);

      expect(window.api.llm.setApiKey).toHaveBeenCalledWith(
        mockUserId,
        "openai",
        "sk-test-key-123"
      );
    });

    it("should show remove button when key exists", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasOpenAI: true },
      });

      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /remove key/i })).toBeInTheDocument();
      });
    });

    it("should call removeApiKey when remove button is clicked", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasOpenAI: true },
      });

      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /remove key/i })).toBeInTheDocument();
      });

      const removeButton = screen.getByRole("button", { name: /remove key/i });
      await user.click(removeButton);

      expect(window.api.llm.removeApiKey).toHaveBeenCalledWith(mockUserId, "openai");
    });
  });

  describe("Consent Modal", () => {
    it("should show consent modal when consent not given", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasConsent: false },
      });

      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("AI Features - Data Processing Consent")).toBeInTheDocument();
      });
    });

    it("should not show consent modal when consent already given", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
      });

      expect(screen.queryByText("AI Features - Data Processing Consent")).not.toBeInTheDocument();
    });

    it("should require checkbox before accept button is enabled", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasConsent: false },
      });

      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("AI Features - Data Processing Consent")).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole("button", { name: /accept & continue/i });
      expect(acceptButton).toBeDisabled();
    });

    it("should enable accept button after checking acknowledgment", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasConsent: false },
      });

      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("AI Features - Data Processing Consent")).toBeInTheDocument();
      });

      const checkbox = screen.getByRole("checkbox");
      await user.click(checkbox);

      const acceptButton = screen.getByRole("button", { name: /accept & continue/i });
      expect(acceptButton).not.toBeDisabled();
    });

    it("should call recordConsent when accept is clicked", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasConsent: false },
      });

      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("AI Features - Data Processing Consent")).toBeInTheDocument();
      });

      const checkbox = screen.getByRole("checkbox");
      await user.click(checkbox);

      const acceptButton = screen.getByRole("button", { name: /accept & continue/i });
      await user.click(acceptButton);

      expect(window.api.llm.recordConsent).toHaveBeenCalledWith(mockUserId, true);
    });

    it("should close modal when cancel is clicked", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasConsent: false },
      });

      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("AI Features - Data Processing Consent")).toBeInTheDocument();
      });

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByText("AI Features - Data Processing Consent")).not.toBeInTheDocument();
      });
    });
  });

  describe("Feature Toggles", () => {
    it("should update preferences when platform allowance is toggled", async () => {
      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Use Platform Allowance")).toBeInTheDocument();
      });

      // Find the toggle button for platform allowance - it's a sibling in the parent div
      const platformLabel = screen.getByText("Use Platform Allowance");
      const container = platformLabel.closest(".flex.items-center.justify-between");
      const toggleButton = container?.querySelector("button");
      expect(toggleButton).toBeInTheDocument();

      if (toggleButton) {
        await user.click(toggleButton);
      }

      expect(window.api.llm.updatePreferences).toHaveBeenCalledWith(mockUserId, {
        usePlatformAllowance: false,
      });
    });

    it("should disable AI feature toggles when consent not given", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasConsent: false },
      });

      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      // Close consent modal first
      await waitFor(() => {
        expect(screen.getByText("AI Features - Data Processing Consent")).toBeInTheDocument();
      });
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      // Check that feature toggles are disabled - look for disabled class on the toggle
      await waitFor(() => {
        const autoDetectLabel = screen.getByText("Auto-Detect Transactions");
        const container = autoDetectLabel.closest(".flex.items-center.justify-between");
        const toggleButton = container?.querySelector("button");
        expect(toggleButton).toBeDisabled();
      });
    });
  });

  describe("Consent Status Display", () => {
    it("should show green consent status when consent given", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Data processing consent given")).toBeInTheDocument();
      });
    });

    it("should show warning when consent not given", async () => {
      jest.mocked(window.api.llm.getConfig).mockResolvedValue({
        success: true,
        data: { ...defaultConfig, hasConsent: false },
      });

      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      // Close consent modal first
      await waitFor(() => {
        expect(screen.getByText("AI Features - Data Processing Consent")).toBeInTheDocument();
      });
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      await waitFor(() => {
        expect(screen.getByText("Consent required to use AI features")).toBeInTheDocument();
      });
    });
  });

  describe("Error Handling", () => {
    it("should show error state when config load fails", async () => {
      jest.mocked(window.api.llm.getConfig).mockRejectedValue(new Error("Network error"));

      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Failed to load LLM settings")).toBeInTheDocument();
      });
    });

    it("should show try again button on error", async () => {
      jest.mocked(window.api.llm.getConfig).mockRejectedValue(new Error("Network error"));

      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
      });
    });

    it("should retry loading config when try again is clicked", async () => {
      jest.mocked(window.api.llm.getConfig)
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({ success: true, data: defaultConfig });

      const user = userEvent.setup();
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
      });

      const retryButton = screen.getByRole("button", { name: /try again/i });
      await user.click(retryButton);

      await waitFor(() => {
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
      });
    });
  });

  describe("API Integration", () => {
    it("should call getConfig on mount", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(window.api.llm.getConfig).toHaveBeenCalledWith(mockUserId);
      });
    });

    it("should call getUsage on mount", async () => {
      render(<LLMSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(window.api.llm.getUsage).toHaveBeenCalledWith(mockUserId);
      });
    });
  });
});
