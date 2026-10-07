/**
 * Custom hook for managing Joyride tour state
 * Handles tour initialization and completion
 *
 * BACKLOG-3674: two records decide whether the tour starts.
 * - `localStorage[storageKey]` -- "the tour was closed on THIS computer". Any
 *   way of ending the tour writes it (unchanged behaviour). It is not a copy of
 *   the account record and is never written from a server read.
 * - The account's server record (`users.tour_dismissed_at`, read through
 *   `window.api.user.getTourState`). Written when the tour is finished, or
 *   closed with "Don't show this again" ticked. Only "not-dismissed" starts the
 *   tour; "dismissed" and "unknown" (offline, timeout, no bridge) do not.
 */
import { useState, useEffect, useRef, useCallback, Dispatch, SetStateAction } from "react";
import { CallBackProps, STATUS, ACTIONS } from "react-joyride";
import confetti from "canvas-confetti";
import logger from "../utils/logger";

/**
 * Return type for useTour hook
 */
export interface UseTourReturn {
  runTour: boolean;
  setRunTour: Dispatch<SetStateAction<boolean>>;
  handleJoyrideCallback: (data: CallBackProps) => void;
  /** BACKLOG-3674: the "Don't show this again" checkbox. */
  dontShowAgain: boolean;
  setDontShowAgain: (value: boolean) => void;
}

type TourServerState = "dismissed" | "not-dismissed" | "unknown";

/** The account's server record. Never throws; any failure is "unknown". */
async function readTourServerState(): Promise<TourServerState> {
  try {
    const getTourState = window.api?.user?.getTourState;
    if (typeof getTourState !== "function") return "unknown";
    const result = await getTourState();
    return result?.tour === "dismissed" || result?.tour === "not-dismissed" ? result.tour : "unknown";
  } catch {
    return "unknown";
  }
}

/** Record the dismissal on the account. Never throws; main logs and reports failures. */
async function writeTourDismissed(): Promise<void> {
  try {
    const dismissTour = window.api?.user?.dismissTour;
    if (typeof dismissTour !== "function") return;
    const result = await dismissTour();
    if (!result?.success) {
      logger.warn("[useTour] Tour-dismissed record not written", result?.error);
    }
  } catch (error) {
    logger.warn("[useTour] Tour-dismissed record write failed", error);
  }
}

/**
 * Custom hook for managing Joyride tour state
 * @param shouldStart - Condition to determine if tour should start
 * @param storageKey - localStorage key to track if user has seen tour
 * @returns Tour state and handlers
 */
export function useTour(
  shouldStart: boolean,
  storageKey: string = "hasSeenTour",
): UseTourReturn {
  const [runTour, setRunTour] = useState<boolean>(false);
  const [dontShowAgain, setDontShowAgainState] = useState<boolean>(false);

  // Read inside the Joyride callback through a ref, so a tick is never lost to
  // a stale closure.
  const dontShowAgainRef = useRef<boolean>(false);
  const setDontShowAgain = useCallback((value: boolean) => {
    dontShowAgainRef.current = value;
    setDontShowAgainState(value);
  }, []);

  // Joyride calls back more than once for one tour end (an uncontrolled finish
  // or skip emits STEP_AFTER then TOUR_END). Only the first one is handled.
  const endedRef = useRef<boolean>(false);
  useEffect(() => {
    if (runTour) endedRef.current = false;
  }, [runTour]);

  // Start tour when condition is met and user hasn't seen it
  useEffect(() => {
    if (!shouldStart) return;
    // Closed on this computer before: no tour, and no server read.
    if (localStorage.getItem(storageKey)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void readTourServerState().then((state) => {
      if (cancelled || state !== "not-dismissed") return;
      timer = setTimeout(() => setRunTour(true), 500);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [shouldStart, storageKey]);

  const handleJoyrideCallback = (data: CallBackProps): void => {
    const { status, action } = data;

    // Handle tour completion, skip, or close (X button)
    const isFinishedOrSkipped =
      status === STATUS.FINISHED || status === STATUS.SKIPPED;
    const isClosed = action === ACTIONS.CLOSE;

    if (isFinishedOrSkipped || isClosed) {
      setRunTour(false);
      localStorage.setItem(storageKey, "true");

      if (endedRef.current) return;
      endedRef.current = true;

      const finished = status === STATUS.FINISHED;
      // Finishing always dismisses on the account; Skip or close only when ticked.
      if (finished || dontShowAgainRef.current) {
        void writeTourDismissed();
      }

      // Trigger confetti when tour is completed (not skipped or closed)
      if (finished) {
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 },
        });
      }
    }
  };

  return {
    runTour,
    setRunTour,
    handleJoyrideCallback,
    dontShowAgain,
    setDontShowAgain,
  };
}
