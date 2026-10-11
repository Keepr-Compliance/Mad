/**
 * Centralized environment variable validation.
 *
 * Call `validateEnv()` early in app startup (e.g. from main.ts) to
 * surface missing configuration before it causes confusing runtime errors.
 *
 * Also provides `getHomeDir()` for cross-platform home directory access.
 */

import path from "path";

// ---------------------------------------------------------------------------
// Cross-platform home directory
// ---------------------------------------------------------------------------

/**
 * Return the user's home directory in a cross-platform way.
 *
 * On Unix/macOS this reads `HOME`; on Windows it reads `USERPROFILE`.
 * Falls back to `os.homedir()` when neither is set.
 */
export function getHomeDir(): string {
  const home = process.platform === "win32"
    ? process.env.USERPROFILE
    : process.env.HOME;

  if (home) return path.resolve(home);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os") as typeof import("os");
  return os.homedir();
}

// ---------------------------------------------------------------------------
// Environment variable validation
// ---------------------------------------------------------------------------

interface EnvRule {
  /** The environment variable name */
  name: string;
  /** If true the variable MUST be set (non-empty) at startup */
  required: boolean;
  /** Optional human-readable hint shown when the variable is missing */
  hint?: string;
}

/**
 * Variables the Electron desktop app needs at runtime.
 *
 * Some are embedded in `.env.production` for release builds; others must be
 * supplied via `.env.local` during development.
 */
const ELECTRON_ENV_RULES: EnvRule[] = [
  {
    name: "SUPABASE_URL",
    required: true,
    hint: "Set in .env.production or .env.local",
  },
  {
    name: "SUPABASE_ANON_KEY",
    required: true,
    hint: "Set in .env.production or .env.local",
  },
  {
    name: "BROKER_PORTAL_URL",
    required: false,
    hint: "Defaults to https://app.keeprcompliance.com",
  },
  {
    name: "MICROSOFT_CLIENT_ID",
    required: false,
    hint: "Required for Outlook integration",
  },
  {
    name: "MICROSOFT_TENANT_ID",
    required: false,
    hint: "Defaults to 'common' for multi-tenant",
  },
  {
    name: "GOOGLE_CLIENT_ID",
    required: false,
    hint: "Required for Gmail integration",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    required: false,
    hint: "Required for Gmail integration",
  },
  {
    name: "SENTRY_DSN",
    required: false,
    hint: "Required for error tracking",
  },
];

export interface EnvValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

/**
 * Validate that required environment variables are present.
 *
 * Returns a result object rather than throwing so callers can decide how
 * to handle missing configuration (log, show dialog, etc.).
 */
export function validateEnv(): EnvValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const rule of ELECTRON_ENV_RULES) {
    const value = process.env[rule.name];
    const isSet = value !== undefined && value !== "";

    if (!isSet) {
      const message = rule.hint
        ? `${rule.name} — ${rule.hint}`
        : rule.name;

      if (rule.required) {
        missing.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  };
}
