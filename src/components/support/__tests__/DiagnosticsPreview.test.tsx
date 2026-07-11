/**
 * BACKLOG-1918: Tests for the iPhone Sync section of DiagnosticsPreview.
 *
 * Verifies the section renders from an AppDiagnostics payload and that the
 * driver-missing fingerprint + Windows/Android branches surface correctly.
 * Wrapped in StrictMode (repo convention: StrictMode is ON in main.tsx).
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiagnosticsPreview } from "../DiagnosticsPreview";
import type { AppDiagnostics } from "../../../hooks/useSupportTicket";

function makeDiagnostics(
  overrides: Partial<AppDiagnostics["iphone_sync"]> = {}
): AppDiagnostics {
  return {
    app_version: "2.21.0",
    electron_version: "35.7.5",
    os_platform: "win32",
    os_version: "10.0.22631",
    os_arch: "x64",
    node_version: "20.18.0",
    db_initialized: true,
    db_encrypted: true,
    sync_status: { is_running: false, current_operation: null },
    email_connections: { google: false, microsoft: true },
    memory_usage: { rss: 1000, heap_used: 500, heap_total: 800 },
    recent_errors: [],
    device_id: "device-abc",
    uptime_seconds: 120,
    iphone_sync: {
      phone_type: "iphone",
      libimobiledevice_available: true,
      libimobiledevice_in_path: true,
      connected_device_count: 0,
      device_mounted: false,
      device_detected: false,
      driver_missing_suspected: false,
      trust_state: null,
      windows: null,
      apple_driver: {
        is_installed: true,
        service_running: true,
        version: "1.2.3",
      },
      android_companion: {
        paired: false,
        connected: false,
        device_count: 0,
        last_seen: null,
        server_running: false,
        last_sync_at: null,
      },
      user_settings: {
        phone_type: "iphone",
        contact_sources_configured: true,
        iphone_sync_enabled: null,
      },
      ...overrides,
    },
    collected_at: new Date().toISOString(),
  };
}

function renderExpanded(diagnostics: AppDiagnostics) {
  render(
    <StrictMode>
      <DiagnosticsPreview diagnostics={diagnostics} loading={false} />
    </StrictMode>
  );
  // Section is inside the collapsible; expand it.
  fireEvent.click(screen.getByText(/Diagnostics \(attached automatically\)/i));
}

describe("DiagnosticsPreview - iPhone Sync section (BACKLOG-1918)", () => {
  it("renders the iPhone Sync section when expanded", () => {
    renderExpanded(makeDiagnostics());
    expect(screen.getByText("iPhone Sync:")).toBeInTheDocument();
    expect(screen.getByText("Phone Type:")).toBeInTheDocument();
    expect(screen.getByText("Apple Driver:")).toBeInTheDocument();
  });

  it("shows the driver-missing warning for Zoe's fingerprint", () => {
    renderExpanded(
      makeDiagnostics({
        device_mounted: true,
        device_detected: false,
        driver_missing_suspected: true,
        windows: {
          apple_mobile_device_service: "not_found",
          apple_usb_driver_present: false,
          pnp_iphone_present: true,
        },
      })
    );
    expect(
      screen.getByText(/Driver missing suspected/i)
    ).toBeInTheDocument();
    expect(screen.getByText("Windows USB:")).toBeInTheDocument();
  });

  it("renders the Android companion row for android users", () => {
    renderExpanded(
      makeDiagnostics({
        phone_type: "android",
        android_companion: {
          paired: true,
          connected: true,
          device_count: 1,
          last_seen: new Date().toISOString(),
          server_running: true,
          last_sync_at: new Date().toISOString(),
        },
      })
    );
    expect(screen.getByText("Android Companion:")).toBeInTheDocument();
  });

  it("does not render a Windows USB row on non-Windows (windows=null)", () => {
    renderExpanded(makeDiagnostics({ windows: null }));
    expect(screen.queryByText("Windows USB:")).not.toBeInTheDocument();
  });

  it("still renders base diagnostics when iphone_sync is absent (backward compat)", () => {
    const diag = makeDiagnostics();
    // Simulate an older payload without the section.
    delete (diag as unknown as { iphone_sync?: unknown }).iphone_sync;
    render(
      <StrictMode>
        <DiagnosticsPreview diagnostics={diag} loading={false} />
      </StrictMode>
    );
    fireEvent.click(
      screen.getByText(/Diagnostics \(attached automatically\)/i)
    );
    // Base rows still render; no crash, no iPhone Sync section.
    expect(screen.getByText("App Version:")).toBeInTheDocument();
    expect(screen.queryByText("iPhone Sync:")).not.toBeInTheDocument();
  });
});
