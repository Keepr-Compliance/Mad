/**
 * IPC Types - Barrel re-export
 *
 * This barrel preserves backward compatibility so that:
 *   import { SomeType } from '../types/ipc'
 * continues to work after the split into domain files.
 */

export * from "./common";
export * from "./healthIssue";
export * from "./llm";
export * from "./channels";
export * from "./window-api-auth";
export * from "./window-api-system";
export * from "./window-api-contacts";
export * from "./window-api-transactions";
export * from "./window-api-messages";
export * from "./window-api-platform";
export * from "./window-api-services";
export * from "./window-api-license";
export * from "./window-api-events";
export * from "./window-api";
