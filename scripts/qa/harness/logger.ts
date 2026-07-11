/**
 * Minimal leveled console logger for the QA harness (BACKLOG-1848).
 * No dependencies — keeps the harness runnable via bare ts-node.
 */
import type { Logger, LogLevel } from './types';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const PREFIX: Record<LogLevel, string> = {
  debug: '  ·',
  info: '  ›',
  warn: '  !',
  error: '  ✗',
};

export function createLogger(minLevel: LogLevel = 'info'): Logger {
  const threshold = LEVEL_ORDER[minLevel];
  const emit = (level: LogLevel, msg: string, args: unknown[]): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    // Warnings/errors -> stderr; everything else -> stdout.
    const sink = LEVEL_ORDER[level] >= LEVEL_ORDER.warn ? console.error : console.log;
    if (args.length > 0) {
      sink(`${PREFIX[level]} ${msg}`, ...args);
    } else {
      sink(`${PREFIX[level]} ${msg}`);
    }
  };

  return {
    debug: (msg, ...args) => emit('debug', msg, args),
    info: (msg, ...args) => emit('info', msg, args),
    warn: (msg, ...args) => emit('warn', msg, args),
    error: (msg, ...args) => emit('error', msg, args),
  };
}
