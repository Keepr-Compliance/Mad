/**
 * Unit tests for useTour hook
 * Tests tour state management including close button handling
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { STATUS, ACTIONS } from "react-joyride";
import { useTour } from "../useTour";

// Mock canvas-confetti
jest.mock("canvas-confetti", () => jest.fn());

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] || null),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: jest.fn((key: string) => {
      delete store[key];
    }),
    clear: jest.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

describe("useTour", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("initial state", () => {
    it("should start with runTour as false", () => {
      const { result } = renderHook(() => useTour(false));

      expect(result.current.runTour).toBe(false);
    });

    it("should return all required functions and state", () => {
      const { result } = renderHook(() => useTour(false));

      expect(typeof result.current.runTour).toBe("boolean");
      expect(typeof result.current.setRunTour).toBe("function");
      expect(typeof result.current.handleJoyrideCallback).toBe("function");
    });
  });

  describe("tour initialization", () => {
    it("should start tour after delay when shouldStart is true and tour not seen", async () => {
      localStorageMock.getItem.mockReturnValue(null);

      const { result } = renderHook(() => useTour(true, "testTourKey"));

      expect(result.current.runTour).toBe(false);

      act(() => {
        jest.advanceTimersByTime(500);
      });

      await waitFor(() => {
        expect(result.current.runTour).toBe(true);
      });
    });

    it("should not start tour if already seen", () => {
      localStorageMock.getItem.mockReturnValue("true");

      const { result } = renderHook(() => useTour(true, "testTourKey"));

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(result.current.runTour).toBe(false);
    });

    it("should not start tour if shouldStart is false", () => {
      localStorageMock.getItem.mockReturnValue(null);

      const { result } = renderHook(() => useTour(false, "testTourKey"));

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(result.current.runTour).toBe(false);
    });

    it("should use default storage key if not provided", async () => {
      localStorageMock.getItem.mockReturnValue(null);

      renderHook(() => useTour(true));

      expect(localStorageMock.getItem).toHaveBeenCalledWith("hasSeenTour");
    });
  });

  describe("handleJoyrideCallback", () => {
    describe("tour completion (STATUS.FINISHED)", () => {
      it("should stop tour and save to localStorage when finished", () => {
        const { result } = renderHook(() => useTour(true, "testTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        expect(result.current.runTour).toBe(true);

        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.FINISHED,
            action: ACTIONS.NEXT,
            index: 0,
            size: 1,
            type: "step:after",
            step: { target: "body", content: "test" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        expect(result.current.runTour).toBe(false);
        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          "testTourKey",
          "true",
        );
      });

      it("should trigger confetti when tour is finished", () => {
        const confetti = require("canvas-confetti");
        const { result } = renderHook(() => useTour(true, "testTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.FINISHED,
            action: ACTIONS.NEXT,
            index: 0,
            size: 1,
            type: "step:after",
            step: { target: "body", content: "test" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        expect(confetti).toHaveBeenCalledWith({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 },
        });
      });
    });

    describe("tour skip (STATUS.SKIPPED)", () => {
      it("should stop tour and save to localStorage when skipped", () => {
        const { result } = renderHook(() => useTour(true, "testTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.SKIPPED,
            action: ACTIONS.SKIP,
            index: 0,
            size: 1,
            type: "step:after",
            step: { target: "body", content: "test" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        expect(result.current.runTour).toBe(false);
        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          "testTourKey",
          "true",
        );
      });

      it("should NOT trigger confetti when tour is skipped", () => {
        const confetti = require("canvas-confetti");
        const { result } = renderHook(() => useTour(true, "testTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.SKIPPED,
            action: ACTIONS.SKIP,
            index: 0,
            size: 1,
            type: "step:after",
            step: { target: "body", content: "test" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        expect(confetti).not.toHaveBeenCalled();
      });
    });

    describe("tour close via X button (ACTIONS.CLOSE)", () => {
      it("should stop tour and save to localStorage when closed via X button", () => {
        const { result } = renderHook(() => useTour(true, "testTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        expect(result.current.runTour).toBe(true);

        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.PAUSED,
            action: ACTIONS.CLOSE,
            index: 0,
            size: 1,
            type: "step:after",
            step: { target: "body", content: "test" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        expect(result.current.runTour).toBe(false);
        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          "testTourKey",
          "true",
        );
      });

      it("should NOT trigger confetti when closed via X button", () => {
        const confetti = require("canvas-confetti");
        const { result } = renderHook(() => useTour(true, "testTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.PAUSED,
            action: ACTIONS.CLOSE,
            index: 0,
            size: 1,
            type: "step:after",
            step: { target: "body", content: "test" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        expect(confetti).not.toHaveBeenCalled();
      });

      it("should treat close action same as dismiss - preventing beacon from appearing", () => {
        const { result } = renderHook(() => useTour(true, "closeTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        // Simulate clicking the X button
        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.RUNNING,
            action: ACTIONS.CLOSE,
            index: 1,
            size: 5,
            type: "step:after",
            step: { target: '[data-tour="test"]', content: "test step" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        // Tour should be stopped
        expect(result.current.runTour).toBe(false);
        // Tour should be marked as seen (preventing beacon)
        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          "closeTourKey",
          "true",
        );
      });
    });

    describe("other actions should not affect tour state", () => {
      it("should not stop tour for NEXT action during running status", () => {
        const { result } = renderHook(() => useTour(true, "testTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.RUNNING,
            action: ACTIONS.NEXT,
            index: 0,
            size: 5,
            type: "step:after",
            step: { target: "body", content: "test" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        expect(result.current.runTour).toBe(true);
        expect(localStorageMock.setItem).not.toHaveBeenCalled();
      });

      it("should not stop tour for PREV action during running status", () => {
        const { result } = renderHook(() => useTour(true, "testTourKey"));

        act(() => {
          result.current.setRunTour(true);
        });

        act(() => {
          result.current.handleJoyrideCallback({
            status: STATUS.RUNNING,
            action: ACTIONS.PREV,
            index: 1,
            size: 5,
            type: "step:after",
            step: { target: "body", content: "test" },
            controlled: false,
            lifecycle: "complete",
            // Required by CallBackProps; useTour reads only status/action, so this
            // is structural filler (null = "no triggering element").
            origin: null,
          });
        });

        expect(result.current.runTour).toBe(true);
        expect(localStorageMock.setItem).not.toHaveBeenCalled();
      });
    });
  });

  describe("setRunTour", () => {
    it("should allow manually starting the tour", () => {
      const { result } = renderHook(() => useTour(false, "testTourKey"));

      expect(result.current.runTour).toBe(false);

      act(() => {
        result.current.setRunTour(true);
      });

      expect(result.current.runTour).toBe(true);
    });

    it("should allow manually stopping the tour", () => {
      const { result } = renderHook(() => useTour(false, "testTourKey"));

      act(() => {
        result.current.setRunTour(true);
      });

      expect(result.current.runTour).toBe(true);

      act(() => {
        result.current.setRunTour(false);
      });

      expect(result.current.runTour).toBe(false);
    });
  });
});
