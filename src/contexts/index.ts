/**
 * Context exports
 */

export {
  AuthProvider,
  useAuth,
  useIsAuthenticated,
  useCurrentUser,
} from "./AuthContext";
export type { User } from "./AuthContext";

export { NetworkProvider, useNetwork } from "./NetworkContext";

export { PlatformProvider, usePlatform } from "./PlatformContext";

export {
  LicenseProvider,
  useLicense,
  useCanExport,
  useCanSubmit,
  useCanAutoDetect,
} from "./LicenseContext";

export {
  IPhoneSyncProvider,
  useIPhoneSyncContext,
  useIPhoneSyncEnabled,
  type IPhoneSyncEnabledContextValue,
} from "./IPhoneSyncContext";
