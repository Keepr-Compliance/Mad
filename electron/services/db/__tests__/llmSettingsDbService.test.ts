/**
 * @jest-environment node
 */

/**
 * Unit tests for LLM Settings Database Service
 * Tests CRUD operations, token usage tracking, and consent management
 */


// Mock crypto
jest.mock("crypto", () => ({
  randomUUID: jest.fn(() => "test-llm-settings-uuid"),
}));

// Mock the dbConnection module
const mockDbGet = jest.fn();
const mockDbRun = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: (...args: unknown[]) => mockDbRun(...args),
}));

// Import after mocking
import {
  getLLMSettingsByUserId,
  createLLMSettings,
  getOrCreateLLMSettings,
  updateLLMSettings,
  incrementTokenUsage,
  incrementPlatformAllowanceUsage,
  resetMonthlyUsage,
  setLLMDataConsent,
  deleteLLMSettings,
} from "../llmSettingsDbService";

describe("llmSettingsDbService", () => {
  const TEST_USER_ID = "test-user-123";

  const mockLLMSettingsRow = {
    id: "test-llm-settings-uuid",
    user_id: TEST_USER_ID,
    openai_api_key_encrypted: null,
    anthropic_api_key_encrypted: null,
    preferred_provider: "openai",
    openai_model: "gpt-4o-mini",
    anthropic_model: "claude-3-haiku-20240307",
    tokens_used_this_month: 0,
    budget_limit_tokens: null,
    budget_reset_date: null,
    platform_allowance_tokens: 0,
    platform_allowance_used: 0,
    use_platform_allowance: 0,
    enable_auto_detect: 1,
    enable_role_extraction: 1,
    llm_data_consent: 0,
    llm_data_consent_at: null,
    created_at: "2025-12-17T00:00:00.000Z",
    updated_at: "2025-12-17T00:00:00.000Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getLLMSettingsByUserId", () => {
    it("should return null when no settings exist", () => {
      mockDbGet.mockReturnValue(undefined);

      const result = getLLMSettingsByUserId(TEST_USER_ID);

      expect(result).toBeNull();
      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM llm_settings"),
        [TEST_USER_ID]
      );
    });

    it("should return settings when they exist", () => {
      mockDbGet.mockReturnValue(mockLLMSettingsRow);

      const result = getLLMSettingsByUserId(TEST_USER_ID);

      expect(result).not.toBeNull();
      expect(result?.id).toBe("test-llm-settings-uuid");
      expect(result?.user_id).toBe(TEST_USER_ID);
      expect(result?.preferred_provider).toBe("openai");
    });

    it("should convert SQLite integers to booleans", () => {
      mockDbGet.mockReturnValue({
        ...mockLLMSettingsRow,
        use_platform_allowance: 1,
        enable_auto_detect: 0,
        enable_role_extraction: 1,
        llm_data_consent: 1,
      });

      const result = getLLMSettingsByUserId(TEST_USER_ID);

      expect(result?.use_platform_allowance).toBe(true);
      expect(result?.enable_auto_detect).toBe(false);
      expect(result?.enable_role_extraction).toBe(true);
      expect(result?.llm_data_consent).toBe(true);
    });
  });

  describe("createLLMSettings", () => {
    it("should create settings with default values", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
      mockDbGet.mockReturnValue(mockLLMSettingsRow);

      const result = createLLMSettings(TEST_USER_ID);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO llm_settings"),
        ["test-llm-settings-uuid", TEST_USER_ID]
      );
      expect(result.id).toBe("test-llm-settings-uuid");
      expect(result.user_id).toBe(TEST_USER_ID);
    });

    it("should throw error if creation fails", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 0 });
      mockDbGet.mockReturnValue(undefined);

      expect(() => createLLMSettings(TEST_USER_ID)).toThrow(
        `Failed to create LLM settings for user ${TEST_USER_ID}`
      );
    });
  });

  describe("getOrCreateLLMSettings", () => {
    it("should return existing settings if they exist", () => {
      mockDbGet.mockReturnValue(mockLLMSettingsRow);

      const result = getOrCreateLLMSettings(TEST_USER_ID);

      expect(result.id).toBe("test-llm-settings-uuid");
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it("should create settings if they do not exist", () => {
      mockDbGet
        .mockReturnValueOnce(undefined) // First call: check if exists
        .mockReturnValue(mockLLMSettingsRow); // Second call: after creation

      mockDbRun.mockReturnValue({ lastInsertRowid: 1, changes: 1 });

      const result = getOrCreateLLMSettings(TEST_USER_ID);

      expect(result.id).toBe("test-llm-settings-uuid");
      expect(mockDbRun).toHaveBeenCalled();
    });
  });

  describe("updateLLMSettings", () => {
    it("should update allowed fields", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });
      mockDbGet.mockReturnValue({
        ...mockLLMSettingsRow,
        preferred_provider: "anthropic",
      });

      const result = updateLLMSettings(TEST_USER_ID, {
        preferred_provider: "anthropic",
      });

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE llm_settings"),
        expect.arrayContaining(["anthropic", TEST_USER_ID])
      );
      expect(result.preferred_provider).toBe("anthropic");
    });

    it("should convert boolean values to integers", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });
      mockDbGet.mockReturnValue({
        ...mockLLMSettingsRow,
        enable_auto_detect: 0,
      });

      updateLLMSettings(TEST_USER_ID, {
        enable_auto_detect: false,
      });

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("enable_auto_detect"),
        expect.arrayContaining([0, TEST_USER_ID])
      );
    });

    /**
     * BACKLOG-2560 / BACKLOG-2932 — this test used to assert that a zero-field
     * payload RETURNS THE CURRENT SETTINGS as a success value. That is the
     * defect, not the contract: `removeApiKey` passed
     * `{ openai_api_key_encrypted: undefined }`, every field was dropped, and
     * the caller was handed a settings object for a write that never happened.
     * Throwing matches `updateUser`, `updateCommunication` and the rest of db/.
     */
    it("throws on a payload with nothing writable, rather than reporting success", () => {
      mockDbGet.mockReturnValue(mockLLMSettingsRow);

      expect(() => updateLLMSettings(TEST_USER_ID, {})).toThrow(
        "No valid fields to update"
      );
      expect(() =>
        updateLLMSettings(TEST_USER_ID, { openai_api_key_encrypted: undefined })
      ).toThrow("No valid fields to update");

      expect(mockDbRun).not.toHaveBeenCalled();
    });
  });

  describe("incrementTokenUsage", () => {
    it("should increment token count", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });

      incrementTokenUsage(TEST_USER_ID, 100);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("tokens_used_this_month = tokens_used_this_month + ?"),
        [100, TEST_USER_ID]
      );
    });
  });

  describe("incrementPlatformAllowanceUsage", () => {
    it("should increment platform allowance usage", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });

      incrementPlatformAllowanceUsage(TEST_USER_ID, 50);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("platform_allowance_used = platform_allowance_used + ?"),
        [50, TEST_USER_ID]
      );
    });
  });

  describe("resetMonthlyUsage", () => {
    it("should reset monthly token usage", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });

      resetMonthlyUsage(TEST_USER_ID);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("tokens_used_this_month = 0"),
        [TEST_USER_ID]
      );
    });
  });

  describe("setLLMDataConsent", () => {
    it("should set consent to true with timestamp", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });
      mockDbGet.mockReturnValue({
        ...mockLLMSettingsRow,
        llm_data_consent: 1,
        llm_data_consent_at: "2025-12-17T12:00:00.000Z",
      });

      const result = setLLMDataConsent(TEST_USER_ID, true);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("llm_data_consent = ?"),
        [1, TEST_USER_ID]
      );
      expect(result.llm_data_consent).toBe(true);
    });

    it("should set consent to false and clear timestamp", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });
      mockDbGet.mockReturnValue({
        ...mockLLMSettingsRow,
        llm_data_consent: 0,
        llm_data_consent_at: null,
      });

      const result = setLLMDataConsent(TEST_USER_ID, false);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("llm_data_consent = ?"),
        [0, TEST_USER_ID]
      );
      expect(result.llm_data_consent).toBe(false);
    });
  });

  describe("deleteLLMSettings", () => {
    it("should delete settings for user", () => {
      mockDbRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });

      deleteLLMSettings(TEST_USER_ID);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM llm_settings"),
        [TEST_USER_ID]
      );
    });
  });
});
