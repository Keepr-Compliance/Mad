/**
 * Platform Context Provider
 *
 * Provides platform detection state throughout the application.
 * Use this context to access platform-specific functionality without
 * scattering platform checks throughout the codebase.
 */

import React, { createContext, useContext, useMemo, ReactNode } from "react";
import {
  Platform,
  getPlatform,
  isFeatureAvailable,
  isElectron as checkIsElectron,
  isWindowsArm64 as checkIsWindowsArm64,
  FeatureName,
} from "../utils/platform";

interface PlatformContextType {
  /** Current platform: 'macos' | 'windows' | 'linux' */
  platform: Platform;
  /** Check if a specific feature is available on the current platform */
  isFeatureAvailable: (feature: FeatureName) => boolean;
  /** True if running on macOS */
  isMacOS: boolean;
  /** True if running on Windows */
  isWindows: boolean;
  /** True if running on Linux */
  isLinux: boolean;
  /** True if running inside Electron (desktop app) */
  isElectron: boolean;
  /** BACKLOG-3363: true on a Windows on ARM PC (iPhone USB sync unsupported) */
  isWindowsArm64: boolean;
}

const PlatformContext = createContext<PlatformContextType | null>(null);

interface PlatformProviderProps {
  children: ReactNode;
}

/**
 * PlatformProvider component.
 * Wrap your app with this to provide platform context to all children.
 */
export function PlatformProvider({ children }: PlatformProviderProps) {
  const value = useMemo<PlatformContextType>(() => {
    const platform = getPlatform();
    return {
      platform,
      isFeatureAvailable,
      isMacOS: platform === "macos",
      isWindows: platform === "windows",
      isLinux: platform === "linux",
      isElectron: checkIsElectron(),
      isWindowsArm64: checkIsWindowsArm64(),
    };
  }, []);

  return (
    <PlatformContext.Provider value={value}>
      {children}
    </PlatformContext.Provider>
  );
}

/**
 * Hook to access platform context.
 * Must be used within a PlatformProvider.
 * @throws Error if used outside of PlatformProvider
 */
export function usePlatform(): PlatformContextType {
  const context = useContext(PlatformContext);
  if (!context) {
    throw new Error("usePlatform must be used within PlatformProvider");
  }
  return context;
}
