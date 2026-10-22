/**
 * @keepr/shared
 *
 * Shared types, constants, and utilities used across:
 * - Electron desktop app
 * - Broker portal (Next.js)
 * - Admin portal (Next.js)
 *
 * Usage:
 *   import { LicenseType, MemberLicenseStatus } from '@keepr/shared';
 *   import type { License, TransactionSubmission } from '@keepr/shared';
 */

export * from './types/license';
export * from './types/submissions';
export * from './types/utility';
export * from './billing/planRule';
export * from './billing/phone';
