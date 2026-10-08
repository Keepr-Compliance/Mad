/**
 * Configuration Service for application settings
 * Provides centralized configuration management with type safety
 */

import type { Theme } from "../types/models";

/**
 * Configuration object structure
 */
interface Config {
  [key: string]: unknown;
}

/**
 * Application-specific configuration interface
 */
export interface AppConfig {
  theme?: Theme;
  autoUpdate?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  dataDirectory?: string;
  maxLogFiles?: number;
  windowBounds?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
  lastSyncTimestamp?: number;
}

/**
 * Configuration Service Class
 * Manages application configuration with type-safe getters and setters
 */
export class ConfigService {
  private config: Config;

  constructor() {
    this.config = this.loadDefaultConfig();
  }

  /**
   * Load default configuration values
   */
  private loadDefaultConfig(): Config {
    return {
      theme: "auto" as Theme,
      autoUpdate: true,
      logLevel: "info",
      maxLogFiles: 10,
    };
  }

  /**
   * Get configuration value by key
   * @param key - Configuration key
   * @returns The configuration value or undefined if not found
   */
  async getConfig<T = unknown>(key: string): Promise<T | undefined> {
    return this.config[key] as T | undefined;
  }

  /**
   * Set configuration value
   * @param key - Configuration key
   * @param value - Configuration value
   */
  async setConfig<T>(key: string, value: T): Promise<void> {
    this.config[key] = value;
  }

  /**
   * Get multiple configuration values
   * @param keys - Array of configuration keys
   * @returns Object containing requested configuration values
   */
  async getMultiple(keys: string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = this.config[key];
    }
    return result;
  }

  /**
   * Set multiple configuration values
   * @param values - Object containing key-value pairs to set
   */
  async setMultiple(values: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      this.config[key] = value;
    }
  }

  /**
   * Check if a configuration key exists
   * @param key - Configuration key
   * @returns True if the key exists
   */
  async hasConfig(key: string): Promise<boolean> {
    return key in this.config;
  }

  /**
   * Delete a configuration key
   * @param key - Configuration key
   */
  async deleteConfig(key: string): Promise<void> {
    delete this.config[key];
  }

  /**
   * Get all configuration values
   * @returns All configuration values
   */
  async getAllConfig(): Promise<Config> {
    return { ...this.config };
  }

  /**
   * Reset configuration to defaults
   */
  async resetToDefaults(): Promise<void> {
    this.config = this.loadDefaultConfig();
  }

  /**
   * Clear all configuration
   */
  async clearAll(): Promise<void> {
    this.config = {};
  }
}

/**
 * Singleton instance of ConfigService
 */
export const configService = new ConfigService();

export default configService;
