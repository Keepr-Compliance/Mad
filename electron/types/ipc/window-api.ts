/**
 * WindowApi interface composition
 * Assembles the full WindowApi from domain sub-interfaces
 */

import type { IpcInvoke } from "./channels";
import type { ExportProgress, UpdateInfo, UpdateProgress, ConversationSummary } from "./common";
import type { WindowApiAuth } from "./window-api-auth";
import type { WindowApiSystem } from "./window-api-system";
import type { WindowApiContacts } from "./window-api-contacts";
import type { WindowApiTransactions } from "./window-api-transactions";
import type { WindowApiMessages, WindowApiOutlook } from "./window-api-messages";
import type { WindowApiDevice, WindowApiBackup, WindowApiDrivers, WindowApiSync } from "./window-api-platform";
import type {
  WindowApiPreferences,
  WindowApiLlm,
  WindowApiFeedback,
  WindowApiUser,
  WindowApiAddress,
  WindowApiShell,
  WindowApiNotification,
  WindowApiUpdate,
  WindowApiErrorLogging,
  WindowApiApp,
} from "./window-api-services";
import type { WindowApiEntitlement } from "./window-api-entitlement";
import type { WindowApiPairing } from "./window-api-pairing";
import type { WindowApiLocalSync } from "./window-api-local-sync";
import type {
  WindowApiLicense,
  WindowApiDatabaseBackup,
  WindowApiPrivacy,
  WindowApiFailureLog,
  WindowApiFeatureGate,
  WindowApiSupport,
} from "./window-api-license";
import type { WindowApiEvents } from "./window-api-events";

/**
 * Window API exposed to renderer process via contextBridge
 */
export interface WindowApi extends WindowApiEvents {
  // IPC invoke
  invoke: IpcInvoke;

  // Event listeners
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
  once: (channel: string, callback: (...args: unknown[]) => void) => void;

  // Platform info
  platform: NodeJS.Platform;
  versions: {
    node: string;
    chrome: string;
    electron: string;
  };

  // Domain sub-objects
  auth: WindowApiAuth;
  system: WindowApiSystem;
  preferences: WindowApiPreferences;
  llm: WindowApiLlm;
  feedback: WindowApiFeedback;
  user: WindowApiUser;
  contacts: WindowApiContacts;
  transactions: WindowApiTransactions;
  address: WindowApiAddress;
  shell: WindowApiShell;
  notification: WindowApiNotification;
  messages: WindowApiMessages;
  outlook: WindowApiOutlook;
  update: WindowApiUpdate;
  device?: WindowApiDevice;
  backup?: WindowApiBackup;
  drivers?: WindowApiDrivers;
  sync?: WindowApiSync;
  errorLogging: WindowApiErrorLogging;
  app: WindowApiApp;
  license: WindowApiLicense;
  databaseBackup: WindowApiDatabaseBackup;
  privacy: WindowApiPrivacy;
  failureLog: WindowApiFailureLog;
  featureGate: WindowApiFeatureGate;
  entitlement: WindowApiEntitlement;
  support: WindowApiSupport;
  pairing: WindowApiPairing;
  localSync: WindowApiLocalSync;
}

// Note: The global Window augmentation (declare global) lives in src/window.d.ts
// which imports WindowApi and wires it into Window.api for the renderer process.
