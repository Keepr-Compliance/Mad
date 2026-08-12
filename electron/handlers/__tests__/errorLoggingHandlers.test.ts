/**
 * Error Logging Handlers Tests
 * TASK-2254: Verify handler registration and IPC channel wiring
 */

const registeredHandlers: Record<string, Function> = {};
const mockIpcHandle = jest.fn((channel: string, handler: Function) => {
  registeredHandlers[channel] = handler;
});

jest.mock("electron", () => ({
  ipcMain: {
    // Tuple (not unknown[]) so the spread matches mockIpcHandle's parameter list.
    handle: (...args: Parameters<typeof mockIpcHandle>) => mockIpcHandle(...args),
  },
}));

const mockErrorLoggingService = {
  submitError: jest.fn().mockResolvedValue({ success: true, id: "err-123" }),
  processOfflineQueue: jest.fn().mockResolvedValue(3),
  getQueueSize: jest.fn().mockReturnValue(5),
};

jest.mock("../../services/errorLoggingService", () => ({
  getErrorLoggingService: () => mockErrorLoggingService,
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: Function) => fn,
}));

import { registerErrorLoggingHandlers } from "../errorLoggingHandlers";

describe("ErrorLoggingHandlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(registeredHandlers).forEach((key) => delete registeredHandlers[key]);
  });

  describe("registerErrorLoggingHandlers", () => {
    it("should register all expected IPC channels", () => {
      registerErrorLoggingHandlers();

      expect(mockIpcHandle).toHaveBeenCalledWith(
        "error-logging:submit",
        expect.any(Function)
      );
      expect(mockIpcHandle).toHaveBeenCalledWith(
        "error-logging:process-queue",
        expect.any(Function)
      );
      expect(mockIpcHandle).toHaveBeenCalledWith(
        "error-logging:get-queue-size",
        expect.any(Function)
      );
    });

    it("should register exactly 3 handlers", () => {
      registerErrorLoggingHandlers();
      expect(mockIpcHandle).toHaveBeenCalledTimes(3);
    });
  });

  describe("error-logging:submit handler", () => {
    it("should call submitError with the payload", async () => {
      registerErrorLoggingHandlers();
      const handler = registeredHandlers["error-logging:submit"];

      const payload = {
        errorType: "crash",
        errorCode: "ERR_001",
        message: "Something failed",
      };

      const result = await handler({} as any, payload);

      expect(mockErrorLoggingService.submitError).toHaveBeenCalledWith(payload);
      expect(result).toEqual({ success: true, id: "err-123" });
    });
  });

  describe("error-logging:process-queue handler", () => {
    it("should return processed count", async () => {
      registerErrorLoggingHandlers();
      const handler = registeredHandlers["error-logging:process-queue"];

      const result = await handler({} as any);

      expect(mockErrorLoggingService.processOfflineQueue).toHaveBeenCalled();
      expect(result).toEqual({ success: true, processedCount: 3 });
    });
  });

  describe("error-logging:get-queue-size handler", () => {
    it("should return queue size", async () => {
      registerErrorLoggingHandlers();
      const handler = registeredHandlers["error-logging:get-queue-size"];

      const result = await handler({} as any);

      expect(result).toEqual({ success: true, queueSize: 5 });
    });
  });
});
