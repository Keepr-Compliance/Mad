/**
 * @jest-environment node
 */

/**
 * Unit tests for DeviceService
 * SPRINT-062: Auth Flow + Licensing System
 *
 * Tests device registration, identification, and management.
 */


// Mock node-machine-id
const mockMachineIdSync = jest.fn();
jest.mock("node-machine-id", () => ({
  machineIdSync: mockMachineIdSync,
}));

// Mock os module
const mockHostname = jest.fn();
const mockPlatform = jest.fn();
const mockRelease = jest.fn();
jest.mock("os", () => ({
  hostname: mockHostname,
  platform: mockPlatform,
  release: mockRelease,
}));

// Mock logService
jest.mock("../logService", () => {
  const mockFns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return {
    __esModule: true,
    default: mockFns,
  };
});

// Create mock chain helper
interface MockChain {
  from: jest.Mock;
  select: jest.Mock;
  upsert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  eq: jest.Mock;
  order: jest.Mock;
  single: jest.Mock;
  then: (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) => unknown;
  _eqCallCount: number;
  // BACKLOG-2414: `data` is optional because Supabase's update/delete responses
  // carry only `error` — which is exactly what the deactivate/delete/register
  // tests below stub. It was declared required, so every one of those stubs was
  // a type error the moment test files started being checked.
  _lastEqResult: MockEqResult | null;
  setLastEqResult: (result: MockEqResult | null) => void;
}

interface MockEqResult {
  data?: unknown;
  error: unknown;
}

function createMockChain(): MockChain {
  // Track eq call counts for multi-chained .eq() calls
  const chain: MockChain = {
    _eqCallCount: 0,
    _lastEqResult: null,
    // `this` annotated so the assignment resolves against MockChain — the
    // `as unknown as MockChain` below strips contextual typing from the literal.
    setLastEqResult: function (this: MockChain, result: MockEqResult | null) {
      this._lastEqResult = result;
    },
  } as unknown as MockChain;

  chain.from = jest.fn().mockReturnValue(chain);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.upsert = jest.fn().mockReturnValue(chain);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.delete = jest.fn().mockReturnValue(chain);
  chain.order = jest.fn().mockReturnValue(chain);
  chain.single = jest.fn();

  // eq needs to return chain AND be thenable
  chain.eq = jest.fn().mockImplementation(() => {
    // Return chain for further chaining
    return chain;
  });

  // Make chain thenable for await operations
  chain.then = (resolve: (value: unknown) => unknown) => {
    const result = chain._lastEqResult || { data: null, error: null };
    return resolve(result);
  };

  return chain;
}

let mockClient: ReturnType<typeof createMockChain>;

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: jest.fn(() => mockClient),
  },
}));

describe("DeviceService", () => {
  let deviceService: typeof import("../deviceService");

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Set default mock implementations
    mockMachineIdSync.mockReturnValue("test-machine-id-123");
    mockHostname.mockReturnValue("test-hostname");
    mockPlatform.mockReturnValue("darwin");
    mockRelease.mockReturnValue("24.6.0");

    // Create fresh mock client
    mockClient = createMockChain();

    // Re-import to get fresh instance
    deviceService = await import("../deviceService");
  });

  describe("getDeviceId", () => {
    it("returns machine ID when available", () => {
      mockMachineIdSync.mockReturnValue("unique-machine-id-abc");

      const result = deviceService.getDeviceId();

      expect(result).toBe("unique-machine-id-abc");
      expect(mockMachineIdSync).toHaveBeenCalledWith(true);
    });

    it("falls back to hostname when machine ID fails", () => {
      mockMachineIdSync.mockImplementation(() => {
        throw new Error("Failed to get machine ID");
      });
      mockHostname.mockReturnValue("my-computer");
      mockPlatform.mockReturnValue("darwin");

      const result = deviceService.getDeviceId();

      expect(result).toBe("my-computer-darwin-fallback");
    });
  });

  describe("getDeviceName", () => {
    it("returns the hostname", () => {
      mockHostname.mockReturnValue("my-macbook-pro");

      const result = deviceService.getDeviceName();

      expect(result).toBe("my-macbook-pro");
    });
  });

  describe("getDevicePlatform", () => {
    it("maps darwin to macos", () => {
      mockPlatform.mockReturnValue("darwin");

      const result = deviceService.getDevicePlatform();

      expect(result).toBe("macos");
    });

    it("maps win32 to windows", () => {
      mockPlatform.mockReturnValue("win32");

      const result = deviceService.getDevicePlatform();

      expect(result).toBe("windows");
    });

    it("maps linux to linux", () => {
      mockPlatform.mockReturnValue("linux");

      const result = deviceService.getDevicePlatform();

      expect(result).toBe("linux");
    });

    it("defaults to macos for unknown platforms", () => {
      mockPlatform.mockReturnValue("freebsd");

      const result = deviceService.getDevicePlatform();

      expect(result).toBe("macos");
    });
  });

  describe("getOsString", () => {
    it("returns platform and release", () => {
      mockPlatform.mockReturnValue("darwin");
      mockRelease.mockReturnValue("24.6.0");

      const result = deviceService.getOsString();

      expect(result).toBe("darwin 24.6.0");
    });
  });

  describe("registerDevice", () => {
    const mockDevice = {
      id: "device-uuid",
      user_id: "user-123",
      device_id: "test-machine-id-123",
      device_name: "test-hostname",
      os: "darwin 24.6.0",
      platform: "macos",
      is_active: true,
      last_seen_at: "2024-01-01T00:00:00Z",
      activated_at: "2024-01-01T00:00:00Z",
    };

    it("registers a new device successfully", async () => {
      mockClient.single.mockResolvedValueOnce({
        data: mockDevice,
        error: null,
      });

      const result = await deviceService.registerDevice("user-123");

      expect(result.success).toBe(true);
      expect(result.device).toEqual(mockDevice);
      expect(mockClient.upsert).toHaveBeenCalled();
    });

    it("returns device_limit_reached error when limit exceeded", async () => {
      mockClient.single.mockResolvedValueOnce({
        data: null,
        error: { message: "Device limit reached for this user" },
      });

      const result = await deviceService.registerDevice("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("device_limit_reached");
    });

    it("returns unknown error on other failures", async () => {
      mockClient.single.mockRejectedValueOnce(
        new Error("Database connection failed")
      );

      const result = await deviceService.registerDevice("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("unknown");
    });
  });

  describe("getUserDevices", () => {
    it("returns list of devices sorted by last seen", async () => {
      const mockDevices = [
        {
          id: "device-1",
          user_id: "user-123",
          device_id: "machine-1",
          device_name: "Device 1",
          platform: "macos",
          is_active: true,
          last_seen_at: "2024-01-02T00:00:00Z",
        },
        {
          id: "device-2",
          user_id: "user-123",
          device_id: "machine-2",
          device_name: "Device 2",
          platform: "windows",
          is_active: true,
          last_seen_at: "2024-01-01T00:00:00Z",
        },
      ];

      // Make order return a promise-like object
      mockClient.order.mockResolvedValueOnce({
        data: mockDevices,
        error: null,
      });

      const result = await deviceService.getUserDevices("user-123");

      expect(result).toEqual(mockDevices);
      expect(mockClient.order).toHaveBeenCalledWith("last_seen_at", {
        ascending: false,
      });
    });

    it("throws error on database failure", async () => {
      mockClient.order.mockResolvedValueOnce({
        data: null,
        error: { message: "Database error" },
      });

      await expect(deviceService.getUserDevices("user-123")).rejects.toThrow(
        "Failed to get devices"
      );
    });
  });

  describe("deactivateDevice", () => {
    it("deactivates a device successfully", async () => {
      // Set the result that will be returned when the chain is awaited
      mockClient.setLastEqResult({ error: null });

      await expect(
        deviceService.deactivateDevice("user-123", "device-id-123")
      ).resolves.not.toThrow();

      expect(mockClient.update).toHaveBeenCalledWith({
        is_active: false,
      });
    });

    it("throws error on database failure", async () => {
      mockClient.setLastEqResult({ error: { message: "Database error" } });

      await expect(
        deviceService.deactivateDevice("user-123", "device-id-123")
      ).rejects.toThrow("Failed to deactivate device");
    });
  });

  describe("deleteDevice", () => {
    it("deletes a device successfully", async () => {
      mockClient.setLastEqResult({ error: null });

      await expect(
        deviceService.deleteDevice("user-123", "device-id-123")
      ).resolves.not.toThrow();

      expect(mockClient.delete).toHaveBeenCalled();
    });

    it("throws error on database failure", async () => {
      mockClient.setLastEqResult({ error: { message: "Database error" } });

      await expect(
        deviceService.deleteDevice("user-123", "device-id-123")
      ).rejects.toThrow("Failed to delete device");
    });
  });

  describe("isDeviceRegistered", () => {
    it("returns true when device is registered and active", async () => {
      mockClient.single.mockResolvedValueOnce({
        data: { id: "device-uuid" },
        error: null,
      });

      const result = await deviceService.isDeviceRegistered("user-123");

      expect(result).toBe(true);
    });

    it("returns false when device is not found", async () => {
      mockClient.single.mockResolvedValueOnce({
        data: null,
        error: { code: "PGRST116", message: "No rows returned" },
      });

      const result = await deviceService.isDeviceRegistered("user-123");

      expect(result).toBe(false);
    });

    it("returns false on database error", async () => {
      mockClient.single.mockRejectedValueOnce(
        new Error("Database error")
      );

      const result = await deviceService.isDeviceRegistered("user-123");

      expect(result).toBe(false);
    });
  });

  describe("updateDeviceHeartbeat", () => {
    it("updates last_seen_at timestamp", async () => {
      mockClient.setLastEqResult({ error: null });

      await deviceService.updateDeviceHeartbeat("user-123");

      expect(mockClient.update).toHaveBeenCalledWith({
        app_version: expect.any(String),
        last_seen_at: expect.any(String),
      });
    });

    it("handles errors gracefully without throwing", async () => {
      // Return an error in the result (like Supabase does) rather than rejecting
      // Note: The function catches errors so this shouldn't throw
      mockClient.setLastEqResult({ error: { message: "Database error" } });

      // Should not throw
      await expect(
        deviceService.updateDeviceHeartbeat("user-123")
      ).resolves.not.toThrow();
    });
  });
});

// BACKLOG-2414: marks this file as a MODULE for TypeScript. Without it the suite
// is a global script, so its top-level `const mockPlatform` / `originalPlatform`
// collide with the identically-named consts in the sibling service suites
// (TS2451 "Cannot redeclare block-scoped variable"). Jest already evaluates each
// test file in its own scope, so this is a compile-time scoping fix only.
export {};
