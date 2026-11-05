/**
 * Tests for UpdateNotification error-recovery UI (BACKLOG-1905, Deliverable 3).
 *
 * Verifies the errorType → affordance matrix, that "Download installer" calls
 * openManualInstaller, that "Report issue" dispatches the open-support-widget
 * CustomEvent with a diagnostic subject+description, and that every error state
 * is dismissible (never blocks the app).
 */

import { render, screen, fireEvent, act } from "@testing-library/react";
import UpdateNotification from "../UpdateNotification";
import type { UpdateErrorType } from "../../../electron/types/ipc";

// Captured listeners so tests can drive the main→renderer events.
let errorCb: ((payload: unknown) => void) | undefined;
const mockOpenManualInstaller = jest.fn().mockResolvedValue({ success: true });

function setupApi() {
  const noopListener = () => () => {};
  Object.defineProperty(window, "api", {
    value: {
      update: {
        onAvailable: noopListener,
        onProgress: noopListener,
        onDownloaded: noopListener,
        onTranslocationDetected: noopListener,
        onError: (cb: (payload: unknown) => void) => {
          errorCb = cb;
          return () => {
            errorCb = undefined;
          };
        },
        openManualInstaller: mockOpenManualInstaller,
        checkForUpdates: jest.fn().mockResolvedValue({
          updateAvailable: false,
          currentVersion: "2.99.0",
        }),
        install: jest.fn(),
      },
    },
    writable: true,
    configurable: true,
  });
}

/** Emit a structured update-error payload through the captured onError listener. */
function emitError(errorType: UpdateErrorType, message = "boom") {
  act(() => {
    errorCb?.({ message, errorType, sentryEventId: "evt_123" });
  });
}

beforeEach(() => {
  errorCb = undefined;
  mockOpenManualInstaller.mockClear();
  setupApi();
});

describe("UpdateNotification error-recovery matrix", () => {
  it("renders nothing until an error arrives (never blocks the app)", () => {
    const { container } = render(<UpdateNotification />);
    expect(container).toBeEmptyDOMElement();
  });

  it("checksum_mismatch → Download installer + Report + Dismiss (no Retry)", () => {
    render(<UpdateNotification />);
    emitError("checksum_mismatch");
    expect(screen.getByText("Download installer")).toBeInTheDocument();
    expect(screen.getByText("Report issue")).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("network_timeout → Retry + Download installer + Report + Dismiss", () => {
    render(<UpdateNotification />);
    emitError("network_timeout");
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Download installer")).toBeInTheDocument();
    expect(screen.getByText("Report issue")).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
  });

  it("signature_codesign → Report + Dismiss ONLY (no Download installer)", () => {
    render(<UpdateNotification />);
    emitError("signature_codesign");
    expect(screen.getByText("Report issue")).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
    expect(screen.queryByText("Download installer")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("disk_space → guidance + Retry + Dismiss (no download / report)", () => {
    render(<UpdateNotification />);
    emitError("disk_space");
    expect(screen.getByText(/free up disk space/i)).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
    expect(screen.queryByText("Download installer")).not.toBeInTheDocument();
    expect(screen.queryByText("Report issue")).not.toBeInTheDocument();
  });

  it("permission → guidance + Dismiss only", () => {
    render(<UpdateNotification />);
    emitError("permission");
    expect(screen.getByText(/applications folder/i)).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
    expect(screen.queryByText("Download installer")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it.each<UpdateErrorType>(["feed_not_found", "manifest_parse", "unknown"])(
    "%s → Download installer + Report + Dismiss",
    (errorType) => {
      render(<UpdateNotification />);
      emitError(errorType);
      expect(screen.getByText("Download installer")).toBeInTheDocument();
      expect(screen.getByText("Report issue")).toBeInTheDocument();
      expect(screen.getByText("Dismiss")).toBeInTheDocument();
    },
  );
});

describe("UpdateNotification actions", () => {
  it("Download installer calls openManualInstaller", () => {
    render(<UpdateNotification />);
    emitError("checksum_mismatch");
    fireEvent.click(screen.getByText("Download installer"));
    expect(mockOpenManualInstaller).toHaveBeenCalledTimes(1);
  });

  it("Report issue dispatches open-support-widget with a diagnostic subject + description", () => {
    const handler = jest.fn();
    window.addEventListener("open-support-widget", handler);
    render(<UpdateNotification />);
    emitError("checksum_mismatch");
    fireEvent.click(screen.getByText("Report issue"));

    expect(handler).toHaveBeenCalledTimes(1);
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.subject).toMatch(/auto-update failed/i);
    expect(detail.subject).toContain("checksum_mismatch");
    expect(detail.description).toContain("checksum_mismatch");
    expect(detail.description).toContain("evt_123"); // sentry event id linkage
    window.removeEventListener("open-support-widget", handler);
  });

  it("is always dismissible — Dismiss clears the card", () => {
    const { container } = render(<UpdateNotification />);
    emitError("checksum_mismatch");
    expect(screen.getByText("Update Failed")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back gracefully when a bare-string error arrives (legacy emitter)", () => {
    render(<UpdateNotification />);
    act(() => {
      errorCb?.("legacy string error");
    });
    // Defaults to the 'unknown' affordance set.
    expect(screen.getByText("Update Failed")).toBeInTheDocument();
    expect(screen.getByText("Download installer")).toBeInTheDocument();
    expect(screen.getByText("Report issue")).toBeInTheDocument();
  });
});

/**
 * BACKLOG-3469: with the Settings auto-download switch OFF, main sends
 * update-available with autoDownload false and nothing downloads until the
 * user clicks Download.
 */
describe("UpdateNotification with auto-download off (BACKLOG-3469)", () => {
  let availableCb: ((info: unknown) => void) | undefined;
  let progressCb: ((p: unknown) => void) | undefined;
  const mockDownload = jest.fn();

  function setupAvailableApi(storeBuild = false) {
    const noopListener = () => () => {};
    Object.defineProperty(window, "api", {
      value: {
        system: { isStoreBuild: storeBuild },
        update: {
          onAvailable: (cb: (info: unknown) => void) => {
            availableCb = cb;
            return () => {
              availableCb = undefined;
            };
          },
          onProgress: (cb: (p: unknown) => void) => {
            progressCb = cb;
            return () => {
              progressCb = undefined;
            };
          },
          onDownloaded: noopListener,
          onTranslocationDetected: noopListener,
          onError: noopListener,
          download: mockDownload,
          install: jest.fn(),
        },
      },
      writable: true,
      configurable: true,
    });
  }

  const emitAvailable = (info: unknown) =>
    act(() => {
      availableCb?.(info);
    });

  beforeEach(() => {
    availableCb = undefined;
    progressCb = undefined;
    mockDownload.mockReset();
    mockDownload.mockResolvedValue({ success: true });
    setupAvailableApi();
  });

  it("switch off: offers the update with a Download button, no download in progress", () => {
    render(<UpdateNotification />);
    emitAvailable({ version: "2.99.0", autoDownload: false });
    expect(screen.getByText("Update Available")).toBeInTheDocument();
    expect(screen.getByText(/2\.99\.0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.queryByText("Downloading Update...")).not.toBeInTheDocument();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("Download click: calls download once and shows the progress card", async () => {
    render(<UpdateNotification />);
    emitAvailable({ version: "2.99.0", autoDownload: false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
    });
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Downloading Update...")).toBeInTheDocument();
    act(() => {
      progressCb?.({ percent: 42 });
    });
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("refused download: the Download button comes back", async () => {
    mockDownload.mockResolvedValue({ success: false, error: "no" });
    render(<UpdateNotification />);
    emitAvailable({ version: "2.99.0", autoDownload: false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
    });
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it.each([[{ version: "2.99.0", autoDownload: true }], [{ version: "2.99.0" }]])(
    "switch on or flag missing (%j): today's downloading card, no Download button",
    (info) => {
      render(<UpdateNotification />);
      emitAvailable(info);
      expect(screen.getByText("Downloading Update...")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
    },
  );

  it("Store build: no Download button", () => {
    setupAvailableApi(true);
    render(<UpdateNotification />);
    emitAvailable({ version: "2.99.0", autoDownload: false });
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  });

  it("Later dismisses the offer without downloading", () => {
    const { container } = render(<UpdateNotification />);
    emitAvailable({ version: "2.99.0", autoDownload: false });
    fireEvent.click(screen.getByText("Later"));
    expect(container).toBeEmptyDOMElement();
    expect(mockDownload).not.toHaveBeenCalled();
  });
});
