/**
 * Update Service for application updates
 * Manages checking, downloading, and installing application updates
 */

import * as Sentry from "@sentry/electron/main";
import logService from "./logService";

/**
 * Update status enumeration
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

/**
 * Update channel types
 */
export type UpdateChannel = "stable" | "beta" | "alpha";

/**
 * Update information structure
 */
export interface UpdateInfo {
  version: string;
  releaseDate: Date | string;
  releaseNotes?: string;
  downloadUrl?: string;
  size?: number;
  signature?: string;
}

/**
 * Update progress information
 */
export interface UpdateProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
}

/**
 * Update configuration options
 */
export interface UpdateConfig {
  autoDownload?: boolean;
  autoInstall?: boolean;
  channel?: UpdateChannel;
  checkInterval?: number; // in milliseconds
}

/**
 * Update event callback type
 */
export type UpdateEventCallback = (data?: unknown) => void;

/**
 * Classified failure reasons for auto-update errors
 */
export type UpdateFailureReason =
  | "network_error"
  | "download_failed"
  | "install_failed"
  | "insufficient_storage"
  | "permissions_error"
  | "unknown";

/**
 * Classify an update error into a specific failure reason
 */
export function classifyUpdateError(error: unknown): UpdateFailureReason {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  if (
    message.includes("enospc") ||
    message.includes("disk") ||
    message.includes("space")
  ) {
    return "insufficient_storage";
  }
  if (message.includes("eacces") || message.includes("permission")) {
    return "permissions_error";
  }
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused")
  ) {
    return "network_error";
  }
  if (message.includes("download")) {
    return "download_failed";
  }
  if (message.includes("install")) {
    return "install_failed";
  }
  return "unknown";
}

/**
 * Update Service Class
 * Manages application update lifecycle
 */
export class UpdateService {
  private status: UpdateStatus;
  private config: UpdateConfig;
  private currentVersion: string;
  private availableUpdate?: UpdateInfo;
  private downloadProgress?: UpdateProgress;
  private checkIntervalId?: NodeJS.Timeout;
  private eventListeners: Map<string, UpdateEventCallback[]>;

  constructor(currentVersion: string = "1.0.0", config: UpdateConfig = {}) {
    this.currentVersion = currentVersion;
    this.status = "idle";
    this.config = {
      autoDownload: false,
      autoInstall: false,
      channel: "stable",
      checkInterval: 3600000, // 1 hour default
      ...config,
    };
    this.eventListeners = new Map();
  }

  /**
   * Get current update status
   */
  async getStatus(): Promise<UpdateStatus> {
    return this.status;
  }

  /**
   * Get current version
   */
  async getCurrentVersion(): Promise<string> {
    return this.currentVersion;
  }

  /**
   * Get available update information
   */
  async getAvailableUpdate(): Promise<UpdateInfo | undefined> {
    return this.availableUpdate;
  }

  /**
   * Get download progress
   */
  async getDownloadProgress(): Promise<UpdateProgress | undefined> {
    return this.downloadProgress;
  }

  /**
   * Check for updates
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    this.status = "checking";
    this.emit("checking-for-update");

    Sentry.addBreadcrumb({
      category: "update.check",
      message: `Checking for updates (channel: ${this.config.channel}, current: ${this.currentVersion})`,
      level: "info",
      data: {
        channel: this.config.channel,
        currentVersion: this.currentVersion,
      },
    });

    try {
      // Simulate update check (in real implementation, this would call an API)
      await this.simulateUpdateCheck();

      if (this.availableUpdate) {
        this.status = "available";

        Sentry.addBreadcrumb({
          category: "update.available",
          message: `Update available: ${this.availableUpdate.version}`,
          level: "info",
          data: {
            version: this.availableUpdate.version,
            size: this.availableUpdate.size,
          },
        });

        this.emit("update-available", this.availableUpdate);

        if (this.config.autoDownload) {
          await this.downloadUpdate();
        }

        return this.availableUpdate;
      } else {
        this.status = "not-available";

        Sentry.addBreadcrumb({
          category: "update.status",
          message: "No update available",
          level: "info",
        });

        this.emit("update-not-available");
        return null;
      }
    } catch (error) {
      this.status = "error";
      const reason = classifyUpdateError(error);

      Sentry.captureMessage("Auto-update check failed", {
        level: "error",
        tags: {
          component: "auto_update",
          failureReason: reason,
          currentVersion: this.currentVersion,
        },
        extra: {
          channel: this.config.channel,
          errorMessage:
            error instanceof Error ? error.message : String(error),
        },
      });

      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Check for updates from update server.
   * TODO(BACKLOG-1123): Wire up electron-updater (autoUpdater) when update
   * server infrastructure is ready. Until then, this is a no-op that
   * immediately reports "no updates available" without any artificial delay.
   */
  private async simulateUpdateCheck(): Promise<void> {
    // No-op: electron-updater integration pending server infrastructure.
    // Previously this had a fake 1-second sleep which was misleading.
    this.availableUpdate = undefined;
  }

  /**
   * Download update
   */
  async downloadUpdate(): Promise<void> {
    if (!this.availableUpdate) {
      throw new Error("No update available to download");
    }

    this.status = "downloading";

    Sentry.addBreadcrumb({
      category: "update.download",
      message: `Downloading update ${this.availableUpdate.version}`,
      level: "info",
      data: {
        version: this.availableUpdate.version,
        size: this.availableUpdate.size,
      },
    });

    this.emit("download-started");

    try {
      // Simulate download progress
      await this.simulateDownload();

      this.status = "downloaded";

      Sentry.addBreadcrumb({
        category: "update.download",
        message: "Download completed",
        level: "info",
      });

      this.emit("download-completed");

      if (this.config.autoInstall) {
        await this.installUpdate();
      }
    } catch (error) {
      this.status = "error";
      const reason = classifyUpdateError(error);

      Sentry.captureMessage("Auto-update download failed", {
        level: "error",
        tags: {
          component: "auto_update",
          failureReason: reason,
          currentVersion: this.currentVersion,
        },
        extra: {
          version: this.availableUpdate.version,
          errorMessage:
            error instanceof Error ? error.message : String(error),
        },
      });

      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Download update from update server.
   * TODO(BACKLOG-1123): Wire up electron-updater downloadUpdate() when ready.
   * Until then, this is a no-op placeholder.
   */
  private async simulateDownload(): Promise<void> {
    const totalBytes = this.availableUpdate?.size || 0;
    this.downloadProgress = {
      bytesDownloaded: totalBytes,
      totalBytes,
      percentage: 100,
    };
    this.emit("download-progress", this.downloadProgress);
  }

  /**
   * Install update
   */
  async installUpdate(): Promise<void> {
    if (this.status !== "downloaded") {
      throw new Error("Update must be downloaded before installing");
    }

    Sentry.addBreadcrumb({
      category: "update.install",
      message: "Installing update",
      level: "info",
      data: {
        version: this.availableUpdate?.version,
        currentVersion: this.currentVersion,
      },
    });

    this.emit("before-quit-for-update");

    // TODO(BACKLOG-1123): Wire up electron-updater quitAndInstall() when ready.
    this.emit("update-installed");
  }

  /**
   * Start automatic update checking
   */
  async startAutoUpdateCheck(): Promise<void> {
    if (this.checkIntervalId) {
      return;
    }

    // Initial check
    await this.checkForUpdates();

    // Set up interval
    this.checkIntervalId = setInterval(() => {
      void this.checkForUpdates();
    }, this.config.checkInterval);
  }

  /**
   * Stop automatic update checking
   */
  async stopAutoUpdateCheck(): Promise<void> {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = undefined;
    }
  }

  /**
   * Update configuration
   */
  async updateConfig(newConfig: Partial<UpdateConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };

    // Restart auto-check if interval changed
    if (newConfig.checkInterval && this.checkIntervalId) {
      await this.stopAutoUpdateCheck();
      await this.startAutoUpdateCheck();
    }
  }

  /**
   * Get current configuration
   */
  async getConfig(): Promise<UpdateConfig> {
    return { ...this.config };
  }

  /**
   * Set update channel
   */
  async setChannel(channel: UpdateChannel): Promise<void> {
    this.config.channel = channel;
  }

  /**
   * Get update channel
   */
  async getChannel(): Promise<UpdateChannel> {
    return this.config.channel || "stable";
  }

  /**
   * Register event listener
   */
  on(event: string, callback: UpdateEventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)?.push(callback);
  }

  /**
   * Unregister event listener
   */
  off(event: string, callback: UpdateEventCallback): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Emit event to all registered listeners
   */
  private emit(event: string, data?: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach((callback) => {
        try {
          callback(data);
        } catch (error) {
          logService.error(`Error in event listener for ${event}:`, "UpdateService", { error });
        }
      });
    }
  }

  /**
   * Reset update service state
   */
  async reset(): Promise<void> {
    await this.stopAutoUpdateCheck();
    this.status = "idle";
    this.availableUpdate = undefined;
    this.downloadProgress = undefined;
    this.eventListeners.clear();
  }
}

/**
 * Singleton instance of UpdateService
 */
export const updateService = new UpdateService();

export default updateService;
