/**
 * License Types - SPRINT-062
 * TypeScript interfaces for Supabase license and device tables
 *
 * These types match the database schema in:
 * - public.licenses table
 * - public.devices table
 */

// =============================================================================
// Enums / Literal Types
// =============================================================================

/** License type determines features and limits */
export type LicenseType = 'trial' | 'individual' | 'team';

/** Trial status tracks the trial lifecycle */
export type TrialStatus = 'active' | 'expired' | 'converted';

/**
 * License account status from the licenses.status column.
 * Tracks the status of a license record in public.licenses table.
 */
export type LicenseAccountStatus = 'active' | 'cancelled' | 'expired' | 'suspended';

/** Normalized platform values */
export type DevicePlatform = 'macos' | 'windows' | 'linux';

// =============================================================================
// Database Record Types
// =============================================================================

/**
 * License record from Supabase public.licenses table
 */
export interface License {
  id: string;
  user_id: string;

  // Original columns
  license_key: string;
  max_devices: number;
  status: LicenseAccountStatus;
  expires_at: string | null;
  activated_at: string | null;

  // Trial tracking (added in SPRINT-062)
  license_type: LicenseType;
  trial_status: TrialStatus;
  trial_started_at: string;
  trial_expires_at: string;

  // Usage tracking (added in SPRINT-062)
  transaction_count: number;
  transaction_limit: number;

  // Feature flags (added in SPRINT-062)
  ai_detection_enabled: boolean;

  // Timestamps
  created_at: string;
  updated_at: string;
}

/**
 * Device record from Supabase public.devices table
 */
export interface Device {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string | null;

  // OS info
  os: string | null; // Full OS string (e.g., "darwin 24.6.0")
  platform: DevicePlatform | null; // Normalized (e.g., "macos")
  app_version: string | null;

  // Status (added in SPRINT-062)
  is_active: boolean;

  // Timestamps
  last_seen_at: string;
  activated_at: string;
}

// =============================================================================
// Application Types (for service layer)
// =============================================================================

/**
 * License validation result returned by license service
 */
export interface LicenseValidationResult {
  isValid: boolean;
  licenseType: LicenseType;

  // Trial info (only for trial users)
  trialStatus?: TrialStatus;
  trialDaysRemaining?: number;

  // Usage info
  transactionCount: number;
  transactionLimit: number;
  canCreateTransaction: boolean;

  // Device info
  deviceCount: number;
  deviceLimit: number;

  // Features
  aiEnabled: boolean;

  // Block reason (if not valid).
  // BACKLOG-2148: 'load_error' is a SOFT, NON-BLOCKING reason. It always travels
  // with isValid:true and signals a transient license-load failure (DB-init race /
  // aged offline cache) for an authenticated account — the app fails OPEN and retries
  // online rather than falsely gating a valid user. It must NEVER be treated as terminal.
  blockReason?: 'expired' | 'limit_reached' | 'no_license' | 'suspended' | 'load_error';
}

/**
 * Device registration request
 */
export interface DeviceRegistrationRequest {
  device_id: string;
  device_name?: string;
  platform: DevicePlatform;
  app_version?: string;
}

/**
 * Device registration result
 */
export interface DeviceRegistrationResult {
  success: boolean;
  device?: Device;
  error?: 'device_limit_reached' | 'already_registered' | 'unknown';
}

// =============================================================================
// Constants
// =============================================================================

/**
 * License limits by type
 */
export const LICENSE_LIMITS: Record<
  LicenseType,
  { transactions: number; devices: number }
> = {
  trial: { transactions: 5, devices: 1 },
  individual: { transactions: Infinity, devices: 2 },
  team: { transactions: Infinity, devices: 10 },
};

/**
 * Trial duration in days
 */
export const TRIAL_DURATION_DAYS = 14;

/**
 * Offline grace period in hours
 * (how long the app can run without validating license online)
 */
export const OFFLINE_GRACE_PERIOD_HOURS = 24;
