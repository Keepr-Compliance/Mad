/**
 * BACKLOG-3363: the raw inputs behind the Windows-on-ARM decision, for
 * diagnostics (support tickets, Sentry). Recording all four — not only the
 * derived boolean — lets the first run on a real ARM PC replace the derived
 * test fixtures with measured values.
 *
 * Contains no PII: platform / architecture strings and one boolean.
 */

import * as os from "os";
import { app } from "electron";
import { isWindowsArm64 } from "../../utils/windowsArm64";

export interface HostArchitecture {
  platform: string;
  arch: string;
  /** `null` when the runtime does not expose the property. */
  running_under_arm64_translation: boolean | null;
  /** `null` when `os.machine()` is unavailable or throws. */
  os_machine: string | null;
  windows_arm64: boolean;
}

export function getHostArchitecture(): HostArchitecture {
  let translated: boolean | undefined;
  try {
    const value = app?.runningUnderARM64Translation;
    translated = typeof value === "boolean" ? value : undefined;
  } catch {
    translated = undefined;
  }

  let osMachine: string | null = null;
  try {
    osMachine = typeof os.machine === "function" ? os.machine() : null;
  } catch {
    osMachine = null;
  }

  return {
    platform: process.platform,
    arch: process.arch,
    running_under_arm64_translation: translated ?? null,
    os_machine: osMachine,
    windows_arm64: isWindowsArm64(process.platform, process.arch, translated),
  };
}
