/**
 * Device Registration Service
 * SPRINT-062: Auth Flow + Licensing System
 *
 * Manages device registration and tracking for license enforcement.
 */

import { app } from "electron";
import supabaseService from "./supabaseService";
import * as Sentry from "@sentry/electron/main";
import { machineIdSync } from "node-machine-id";
import { hostname, platform, release } from "os";
import logService from "./logService";
import { onDeviceRegistered, type RegistrationReason } from "./deviceProfile/deviceProfileService";
import type {
  Device,
  DevicePlatform,
  DeviceRegistrationResult,
} from "../types/license";

/**
 * Get unique device identifier
 * Uses node-machine-id for a stable, unique identifier per machine
 */
export function getDeviceId(): string {
  try {
    return machineIdSync(true); // true = return original format
  } catch (error) {
    logService.warn(
      "[Device] Failed to get machine ID, using fallback",
      "DeviceService",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    // Fallback to hostname-based ID (less reliable but works)
    return `${hostname()}-${platform()}-fallback`;
  }
}

/**
 * Get device name (for display in device management UI)
 */
export function getDeviceName(): string {
  return hostname();
}

/**
 * Get device platform (normalized)
 */
export function getDevicePlatform(): DevicePlatform {
  const p = platform();
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  if (p === "linux") return "linux";
  // Fallback for unknown platforms
  return "macos";
}

/**
 * Get full OS string (e.g., "darwin 24.6.0")
 */
export function getOsString(): string {
  return `${platform()} ${release()}`;
}

/**
 * Register current device for a user
 * Uses upsert to handle both new and existing devices
 */
export async function registerDevice(
  userId: string,
  reason: RegistrationReason = "restore"
): Promise<DeviceRegistrationResult> {
  const deviceId = getDeviceId();
  const deviceName = getDeviceName();
  const devicePlatform = getDevicePlatform();
  const osString = getOsString();

  try {
    logService.debug("[Device] Registering device", "DeviceService", {
      userId,
      deviceId: deviceId.substring(0, 8) + "...", // Log partial ID for privacy
      platform: devicePlatform,
    });

    // Try to upsert device registration
    const { data, error } = await supabaseService
      .getClient()
      .from("devices")
      .upsert(
        {
          user_id: userId,
          device_id: deviceId,
          device_name: deviceName,
          os: osString,
          platform: devicePlatform,
          is_active: true,
          last_seen_at: new Date().toISOString(),
          app_version: app.getVersion(),
        },
        {
          onConflict: "user_id,device_id",
        }
      )
      .select()
      .single();

    if (error) {
      // Check if it's a device limit error (from RLS policy or trigger)
      if (error.message?.includes("Device limit")) {
        logService.warn(
          "[Device] Device limit reached for user",
          "DeviceService",
          { userId }
        );
        return {
          success: false,
          error: "device_limit_reached",
        };
      }
      throw error;
    }

    logService.info("[Device] Device registered successfully", "DeviceService", {
      userId,
      deviceId: deviceId.substring(0, 8) + "...",
    });

    // BACKLOG-4185: hand the id this call already holds to the device-profile
    // service (it never reads the machine id itself). Fire-and-forget.
    onDeviceRegistered(userId, deviceId, reason, (data as Device | null)?.id);

    return {
      success: true,
      device: data as Device,
    };
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logService.error("[Device] Failed to register device", "DeviceService", {
      error: errorMessage,
    });
    Sentry.captureException(error, {
      tags: { service: "device-service", operation: "registerDevice" },
    });

    if (errorMessage.includes("Device limit")) {
      return {
        success: false,
        error: "device_limit_reached",
      };
    }

    return {
      success: false,
      error: "unknown",
    };
  }
}

/**
 * Update device last seen timestamp (heartbeat)
 * Called periodically to track active devices
 */
export async function updateDeviceHeartbeat(userId: string): Promise<void> {
  const deviceId = getDeviceId();

  try {
    await supabaseService
      .getClient()
      .from("devices")
      .update({ last_seen_at: new Date().toISOString(), app_version: app.getVersion() })
      .eq("user_id", userId)
      .eq("device_id", deviceId);

    logService.debug("[Device] Heartbeat updated", "DeviceService");
  } catch (error) {
    logService.warn("[Device] Failed to update heartbeat", "DeviceService", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "device-service", operation: "updateDeviceHeartbeat" },
    });
  }
}

/**
 * Get all devices for a user
 * Returns devices sorted by last seen (most recent first)
 */
export async function getUserDevices(userId: string): Promise<Device[]> {
  try {
    const { data, error } = await supabaseService
      .getClient()
      .from("devices")
      .select("*")
      .eq("user_id", userId)
      .order("last_seen_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to get devices: ${error.message}`);
    }

    return data as Device[];
  } catch (error) {
    logService.error("[Device] Failed to get user devices", "DeviceService", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "device-service", operation: "getUserDevices" },
    });
    throw error;
  }
}

/**
 * Deactivate a device (for device management UI)
 * Soft delete - keeps the record but marks as inactive
 */
export async function deactivateDevice(
  userId: string,
  deviceId: string
): Promise<void> {
  try {
    const { error } = await supabaseService
      .getClient()
      .from("devices")
      .update({ is_active: false })
      .eq("user_id", userId)
      .eq("device_id", deviceId);

    if (error) {
      throw new Error(`Failed to deactivate device: ${error.message}`);
    }

    logService.info("[Device] Device deactivated", "DeviceService", {
      userId,
      deviceId: deviceId.substring(0, 8) + "...",
    });
  } catch (error) {
    logService.error("[Device] Failed to deactivate device", "DeviceService", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "device-service", operation: "deactivateDevice" },
    });
    throw error;
  }
}

/**
 * Delete a device registration completely
 * Hard delete - removes the record entirely
 */
export async function deleteDevice(
  userId: string,
  deviceId: string
): Promise<void> {
  try {
    const { error } = await supabaseService
      .getClient()
      .from("devices")
      .delete()
      .eq("user_id", userId)
      .eq("device_id", deviceId);

    if (error) {
      throw new Error(`Failed to delete device: ${error.message}`);
    }

    logService.info("[Device] Device deleted", "DeviceService", {
      userId,
      deviceId: deviceId.substring(0, 8) + "...",
    });
  } catch (error) {
    logService.error("[Device] Failed to delete device", "DeviceService", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "device-service", operation: "deleteDevice" },
    });
    throw error;
  }
}

/**
 * Check if current device is registered and active for a user
 */
export async function isDeviceRegistered(userId: string): Promise<boolean> {
  const deviceId = getDeviceId();

  try {
    const { data, error } = await supabaseService
      .getClient()
      .from("devices")
      .select("id")
      .eq("user_id", userId)
      .eq("device_id", deviceId)
      .eq("is_active", true)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 = "No rows returned" which is expected if not registered
      logService.warn(
        "[Device] Failed to check device registration",
        "DeviceService",
        { error: error.message }
      );
    }

    return !!data;
  } catch (error) {
    logService.error(
      "[Device] Error checking device registration",
      "DeviceService",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    Sentry.captureException(error, {
      tags: { service: "device-service", operation: "isDeviceRegistered" },
    });
    return false;
  }
}
