/**
 * Flow Hooks Index
 *
 * Exports all flow hooks for application state management.
 * Each flow hook manages a specific domain of the application state.
 */

// Existing flow hooks
export { useSecureStorage } from "./useSecureStorage";
export { useEmailOnboardingApi } from "./useEmailOnboardingApi";
export { usePhoneTypeApi } from "./usePhoneTypeApi";

// New flow hooks - extracted from useAppStateMachine
export { useModalFlow } from "./useModalFlow";
export type { UseModalFlowReturn } from "./useModalFlow";

export { useAuthFlow } from "./useAuthFlow";
export type { UseAuthFlowOptions, UseAuthFlowReturn } from "./useAuthFlow";

export { usePermissionsFlow } from "./usePermissionsFlow";
export type {
  UsePermissionsFlowOptions,
  UsePermissionsFlowReturn,
} from "./usePermissionsFlow";

export { useNavigationFlow } from "./useNavigationFlow";
export type {
  UseNavigationFlowOptions,
  UseNavigationFlowReturn,
} from "./useNavigationFlow";

export { useEmailHandlers } from "./useEmailHandlers";
export type {
  UseEmailHandlersOptions,
  UseEmailHandlersReturn,
} from "./useEmailHandlers";

export { usePhoneHandlers } from "./usePhoneHandlers";
export type {
  UsePhoneHandlersOptions,
  UsePhoneHandlersReturn,
} from "./usePhoneHandlers";

export { useKeychainHandlers } from "./useKeychainHandlers";
export type {
  UseKeychainHandlersOptions,
  UseKeychainHandlersReturn,
} from "./useKeychainHandlers";
