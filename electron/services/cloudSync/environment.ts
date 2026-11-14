/**
 * Which Keepr Cloud this build saves to, and whether it may (BACKLOG-4243,
 * plan §6 R10b and the dev guard C2.27).
 *
 * The project is the host of SUPABASE_URL. An unpackaged (dev) build refuses to
 * run against the production project unless KEEPR_CLOUD_SYNC_DEV=1. The
 * production project is read from the committed `.env.production`, never
 * written here; when that file cannot be read a dev build refuses too.
 */
import { parse as parseDotenv } from "dotenv";

export const DEV_OVERRIDE_ENV = "KEEPR_CLOUD_SYNC_DEV";

export function projectRefFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export interface DevGuardInput {
  isPackaged: boolean;
  configuredUrl: string | undefined;
  /** Contents of `.env.production`, or null when it cannot be read. */
  productionEnvText: string | null;
  devOverride: string | undefined;
}

/** Null when the engine may run; otherwise a code. */
export function devGuardReason(input: DevGuardInput): string | null {
  const ref = projectRefFromUrl(input.configuredUrl);
  if (!ref) return "no_project";
  if (input.isPackaged) return null;
  if (input.devOverride === "1") return null;
  if (input.productionEnvText === null) return "dev_unknown_project";
  const prodRef = projectRefFromUrl(parseDotenv(input.productionEnvText).SUPABASE_URL);
  if (!prodRef) return "dev_unknown_project";
  return prodRef === ref ? "dev_production" : null;
}
