/**
 * Logging Service for application-wide logging
 * Provides structured logging with different severity levels
 */

import * as fs from "fs";
import * as path from "path";
import log from "electron-log";

/**
 * Log level enumeration
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log configuration options
 */
export interface LogConfig {
  logToFile?: boolean;
  logToConsole?: boolean;
  logDirectory?: string;
  maxLogFiles?: number;
  minLevel?: LogLevel;
}

/**
 * Logging Service Class
 * Manages application logging with support for different levels and outputs
 */
export class LogService {
  private config: LogConfig;
  private logFilePath?: string;
  private readonly LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(config: LogConfig = {}) {
    this.config = {
      logToFile: false,
      logToConsole: true,
      minLevel: "info",
      maxLogFiles: 10,
      ...config,
    };

    if (this.config.logToFile && this.config.logDirectory) {
      this.initializeLogFile();
    }
  }

  /**
   * Initialize log file path
   */
  private initializeLogFile(): void {
    if (!this.config.logDirectory) {
      return;
    }

    try {
      // Ensure log directory exists
      if (!fs.existsSync(this.config.logDirectory)) {
        fs.mkdirSync(this.config.logDirectory, { recursive: true });
      }

      // Create log file with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.logFilePath = path.join(
        this.config.logDirectory,
        `app-${timestamp}.log`,
      );

      // Rotate old log files if needed
      this.rotateLogFiles();
    } catch (error) {
      console.error("Failed to initialize log file:", error);
    }
  }

  /**
   * Rotate old log files to maintain max count
   */
  private rotateLogFiles(): void {
    if (!this.config.logDirectory || !this.config.maxLogFiles) {
      return;
    }

    try {
      const files = fs
        .readdirSync(this.config.logDirectory)
        .filter((file) => file.startsWith("app-") && file.endsWith(".log"))
        .map((file) => ({
          name: file,
          path: path.join(this.config.logDirectory!, file),
          time: fs
            .statSync(path.join(this.config.logDirectory!, file))
            .mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time);

      // Remove old files beyond max count
      if (files.length >= this.config.maxLogFiles) {
        files.slice(this.config.maxLogFiles - 1).forEach((file) => {
          try {
            fs.unlinkSync(file.path);
          } catch (error) {
            console.error(`Failed to delete old log file ${file.name}:`, error);
          }
        });
      }
    } catch (error) {
      console.error("Failed to rotate log files:", error);
    }
  }

  /**
   * Check if a log level should be logged based on configuration
   */
  private shouldLog(level: LogLevel): boolean {
    const minLevel = this.config.minLevel || "info";
    return this.LOG_LEVELS[level] >= this.LOG_LEVELS[minLevel];
  }

  /**
   * Sanitize a string for safe log output.
   * Removes control characters (newlines, tabs, etc.) that could enable log injection,
   * while preserving Unicode (accented characters, emoji, etc.).
   */
  private sanitizeForLog(input: string): string {
    return input.replace(/[\r\n]/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  }

  /**
   * Format log entry for output
   */
  private formatLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const context = entry.context
      ? `[${this.sanitizeForLog(entry.context)}]`
      : "";
    const sanitizedMessage = this.sanitizeForLog(entry.message);
    const metadata = entry.metadata
      ? `\n${JSON.stringify(entry.metadata, null, 2)}`
      : "";

    return `${timestamp} ${level} ${context} ${sanitizedMessage}${metadata}`;
  }

  /**
   * Write log entry to file
   */
  private async writeToFile(formattedEntry: string): Promise<void> {
    if (!this.logFilePath) {
      return;
    }

    return new Promise((resolve, reject) => {
      // CodeQL: js/http-to-file-access — This is a logging service; writing log entries
      // to file is its expected behavior. Input is sanitized by sanitizeForLog().
      fs.appendFile(this.logFilePath!, formattedEntry + "\n", (error) => {
        if (error) {
          console.error("Failed to write to log file:", error);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Write log entry via electron-log so messages reach the file transport in packaged builds.
   *
   * electron-log v5 does NOT monkey-patch console.* — bare console.info() calls from the
   * main process are silently dropped in packaged builds (no TTY, no file intercept). By
   * routing through electron-log we ensure the file transport (configured in main.ts at
   * log.transports.file.level = "info") captures every info/warn/error call, preserving
   * sync telemetry ([CACHE-HITMISS], [SHADOW-DELTA], ceremony lines) in installed builds.
   *
   * All input is already sanitized by sanitizeForLog() in formatLogEntry() before this point.
   */
  private writeToConsole(level: LogLevel, formattedEntry: string): void {
    switch (level) {
      case "debug":
        log.debug(formattedEntry);
        break;
      case "info":
        log.info(formattedEntry);
        break;
      case "warn":
        log.warn(formattedEntry);
        break;
      case "error":
        log.error(formattedEntry);
        break;
    }
  }

  /**
   * Core logging method
   */
  private async log(
    level: LogLevel,
    message: string,
    context?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      context,
      metadata,
    };

    const formattedEntry = this.formatLogEntry(entry);

    if (this.config.logToConsole) {
      this.writeToConsole(level, formattedEntry);
    }

    if (this.config.logToFile) {
      await this.writeToFile(formattedEntry);
    }
  }

  /**
   * Log debug message
   */
  async debug(
    message: string,
    context?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.log("debug", message, context, metadata);
  }

  /**
   * Log info message
   */
  async info(
    message: string,
    context?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.log("info", message, context, metadata);
  }

  /**
   * Log warning message
   */
  async warn(
    message: string,
    context?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.log("warn", message, context, metadata);
  }

  /**
   * Log error message
   */
  async error(
    message: string,
    context?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.log("error", message, context, metadata);
  }

  /**
   * Update logging configuration
   */
  async updateConfig(newConfig: Partial<LogConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };

    // Reinitialize log file if directory changed
    if (newConfig.logDirectory && this.config.logToFile) {
      this.initializeLogFile();
    }
  }

  /**
   * Get current configuration
   */
  async getConfig(): Promise<LogConfig> {
    return { ...this.config };
  }

  /**
   * Clear log file
   */
  async clearLogs(): Promise<void> {
    if (!this.logFilePath) {
      return;
    }

    return new Promise((resolve, reject) => {
      fs.writeFile(this.logFilePath!, "", (error) => {
        if (error) {
          console.error("Failed to clear log file:", error);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

/**
 * Singleton instance of LogService
 */
export const logService = new LogService();

export default logService;
