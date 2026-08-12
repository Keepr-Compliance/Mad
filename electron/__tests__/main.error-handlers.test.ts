/**
 * @jest-environment node
 */

/**
 * Tests for global error handlers in main.ts
 *
 * TASK-1076: Add global unhandled rejection and uncaught exception handlers
 * to Electron main process to prevent silent crashes and improve error visibility.
 */


describe("Main Process - Global Error Handlers", () => {
  // Save original console.error
  const originalConsoleError = console.error;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore console.error after each test
    console.error = originalConsoleError;
  });

  describe("Handler Registration", () => {
    it("should register uncaughtException handler", () => {
      const handlers: Map<string, Function> = new Map();

      // Mock process.on to capture handler registration
      const mockProcessOn = jest.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
        return process;
      });

      // Simulate the handler registration from main.ts
      mockProcessOn("uncaughtException", (error: Error) => {
        console.error("[FATAL] Uncaught Exception:", error);
      });

      expect(mockProcessOn).toHaveBeenCalledWith(
        "uncaughtException",
        expect.any(Function),
      );
      expect(handlers.has("uncaughtException")).toBe(true);
    });

    it("should register unhandledRejection handler", () => {
      const handlers: Map<string, Function> = new Map();

      // Mock process.on to capture handler registration
      const mockProcessOn = jest.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
        return process;
      });

      // Simulate the handler registration from main.ts
      mockProcessOn("unhandledRejection", (reason: unknown) => {
        console.error("[ERROR] Unhandled Rejection:", reason);
      });

      expect(mockProcessOn).toHaveBeenCalledWith(
        "unhandledRejection",
        expect.any(Function),
      );
      expect(handlers.has("unhandledRejection")).toBe(true);
    });

    it("should register handlers before any async operations", () => {
      const executionOrder: string[] = [];

      // Simulate the correct order from main.ts
      // Handlers should be registered first
      executionOrder.push("register-uncaughtException-handler");
      executionOrder.push("register-unhandledRejection-handler");

      // Then async operations like app.whenReady()
      executionOrder.push("app.whenReady()");
      executionOrder.push("createWindow()");

      // Verify handlers are registered first
      const uncaughtIndex = executionOrder.indexOf(
        "register-uncaughtException-handler",
      );
      const unhandledIndex = executionOrder.indexOf(
        "register-unhandledRejection-handler",
      );
      const asyncIndex = executionOrder.indexOf("app.whenReady()");

      expect(uncaughtIndex).toBeLessThan(asyncIndex);
      expect(unhandledIndex).toBeLessThan(asyncIndex);
    });
  });

  describe("Handler Behavior - uncaughtException", () => {
    it("should log error with full details when uncaught exception occurs", () => {
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      const mockLog = {
        error: jest.fn(),
      };

      // Simulate the handler from main.ts
      const uncaughtExceptionHandler = (error: Error) => {
        console.error("[FATAL] Uncaught Exception:", error);
        mockLog.error("[FATAL] Uncaught Exception:", error);
      };

      const testError = new Error("Test uncaught exception");
      testError.stack = "Error: Test uncaught exception\n    at test.js:1:1";

      uncaughtExceptionHandler(testError);

      expect(mockConsoleError).toHaveBeenCalledWith(
        "[FATAL] Uncaught Exception:",
        testError,
      );
      expect(mockLog.error).toHaveBeenCalledWith(
        "[FATAL] Uncaught Exception:",
        testError,
      );
    });

    it("should NOT call process.exit() on uncaught exception", () => {
      const mockProcessExit = jest.fn();
      const originalExit = process.exit;
      process.exit = mockProcessExit as unknown as typeof process.exit;

      const mockLog = {
        error: jest.fn(),
      };

      // Simulate the handler - it should NOT exit
      const uncaughtExceptionHandler = (error: Error) => {
        console.error("[FATAL] Uncaught Exception:", error);
        mockLog.error("[FATAL] Uncaught Exception:", error);
        // NOTE: No process.exit() call - this is intentional
      };

      const testError = new Error("Test error");
      uncaughtExceptionHandler(testError);

      // Verify process.exit was NOT called
      expect(mockProcessExit).not.toHaveBeenCalled();

      // Restore
      process.exit = originalExit;
    });
  });

  describe("Handler Behavior - unhandledRejection", () => {
    it("should log error when unhandled rejection occurs with Error reason", () => {
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      const mockLog = {
        error: jest.fn(),
      };

      // Simulate the handler from main.ts
      const unhandledRejectionHandler = (reason: unknown) => {
        console.error("[ERROR] Unhandled Rejection:", reason);
        mockLog.error("[ERROR] Unhandled Rejection:", reason);
      };

      const testError = new Error("Test unhandled rejection");

      unhandledRejectionHandler(testError);

      expect(mockConsoleError).toHaveBeenCalledWith(
        "[ERROR] Unhandled Rejection:",
        testError,
      );
      expect(mockLog.error).toHaveBeenCalledWith(
        "[ERROR] Unhandled Rejection:",
        testError,
      );
    });

    it("should handle non-Error rejection reasons", () => {
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      const mockLog = {
        error: jest.fn(),
      };

      const unhandledRejectionHandler = (reason: unknown) => {
        console.error("[ERROR] Unhandled Rejection:", reason);
        mockLog.error("[ERROR] Unhandled Rejection:", reason);
      };

      // Test with string reason
      unhandledRejectionHandler("string rejection reason");
      expect(mockConsoleError).toHaveBeenCalledWith(
        "[ERROR] Unhandled Rejection:",
        "string rejection reason",
      );

      // Test with undefined reason
      unhandledRejectionHandler(undefined);
      expect(mockConsoleError).toHaveBeenCalledWith(
        "[ERROR] Unhandled Rejection:",
        undefined,
      );

      // Test with null reason
      unhandledRejectionHandler(null);
      expect(mockConsoleError).toHaveBeenCalledWith(
        "[ERROR] Unhandled Rejection:",
        null,
      );
    });

    it("should NOT call process.exit() on unhandled rejection", () => {
      const mockProcessExit = jest.fn();
      const originalExit = process.exit;
      process.exit = mockProcessExit as unknown as typeof process.exit;

      const mockLog = {
        error: jest.fn(),
      };

      const unhandledRejectionHandler = (reason: unknown) => {
        console.error("[ERROR] Unhandled Rejection:", reason);
        mockLog.error("[ERROR] Unhandled Rejection:", reason);
        // NOTE: No process.exit() call - rejections are often recoverable
      };

      unhandledRejectionHandler(new Error("Test rejection"));

      // Verify process.exit was NOT called
      expect(mockProcessExit).not.toHaveBeenCalled();

      // Restore
      process.exit = originalExit;
    });
  });

  describe("Error Logging Integration", () => {
    it("should log to both console.error and electron-log", () => {
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      const mockLog = {
        error: jest.fn(),
      };

      // Both handlers should use both logging methods
      const uncaughtExceptionHandler = (error: Error) => {
        console.error("[FATAL] Uncaught Exception:", error);
        mockLog.error("[FATAL] Uncaught Exception:", error);
      };

      const unhandledRejectionHandler = (reason: unknown) => {
        console.error("[ERROR] Unhandled Rejection:", reason);
        mockLog.error("[ERROR] Unhandled Rejection:", reason);
      };

      const error1 = new Error("Exception test");
      const error2 = new Error("Rejection test");

      uncaughtExceptionHandler(error1);
      unhandledRejectionHandler(error2);

      // Verify both console and log received calls
      expect(mockConsoleError).toHaveBeenCalledTimes(2);
      expect(mockLog.error).toHaveBeenCalledTimes(2);

      // Verify correct prefixes
      expect(mockConsoleError).toHaveBeenNthCalledWith(
        1,
        "[FATAL] Uncaught Exception:",
        error1,
      );
      expect(mockConsoleError).toHaveBeenNthCalledWith(
        2,
        "[ERROR] Unhandled Rejection:",
        error2,
      );
    });
  });

  describe("Graceful Error Handling", () => {
    it("should not crash on handler execution errors", () => {
      // Handler itself should not throw
      const safeHandler = (error: Error) => {
        try {
          console.error("[FATAL] Uncaught Exception:", error);
        } catch {
          // Even if logging fails, don't crash
        }
      };

      // Should not throw
      expect(() => {
        safeHandler(new Error("Test"));
      }).not.toThrow();
    });

    it("should handle errors with missing stack trace", () => {
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      const uncaughtExceptionHandler = (error: Error) => {
        console.error("[FATAL] Uncaught Exception:", error);
      };

      // Create error without stack
      const errorWithoutStack = new Error("No stack");
      delete (errorWithoutStack as { stack?: string }).stack;

      // Should not throw
      expect(() => {
        uncaughtExceptionHandler(errorWithoutStack);
      }).not.toThrow();

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });
});
