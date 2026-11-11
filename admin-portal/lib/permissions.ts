/**
 * Permission constants and types for the admin portal RBAC system.
 *
 * Mirrors the admin_permissions table in Supabase.
 */

export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',
  USERS_VIEW: 'users.view',
  USERS_SEARCH: 'users.search',
  USERS_DETAIL: 'users.detail',
  USERS_EDIT: 'users.edit',
  USERS_SUSPEND: 'users.suspend',
  USERS_IMPERSONATE: 'users.impersonate',
  LICENSES_VIEW: 'licenses.view',
  LICENSES_EDIT: 'licenses.edit',
  CREDITS_ADJUST: 'credits.adjust',
  ORGANIZATIONS_VIEW: 'organizations.view',
  ORGANIZATIONS_EDIT: 'organizations.edit',
  ANALYTICS_VIEW: 'analytics.view',
  ANALYTICS_EXPORT: 'analytics.export',
  AUDIT_VIEW: 'audit.view',
  ROLES_VIEW: 'roles.view',
  ROLES_MANAGE: 'roles.manage',
  INTERNAL_USERS_VIEW: 'internal_users.view',
  INTERNAL_USERS_MANAGE: 'internal_users.manage',
  PLANS_VIEW: 'plans.view',
  PLANS_MANAGE: 'plans.manage',
  SUPPORT_VIEW: 'support.view',
  SUPPORT_RESPOND: 'support.respond',
  SUPPORT_ASSIGN: 'support.assign',
  SUPPORT_MANAGE: 'support.manage',
  SUPPORT_ADMIN: 'support.admin',
  PM_VIEW: 'pm.view',
  PM_EDIT: 'pm.edit',
  PM_ASSIGN: 'pm.assign',
  PM_MANAGE: 'pm.manage',
  PM_ADMIN: 'pm.admin',
  DEVICES_MANAGE: 'devices.manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Permission categories for the role management UI (must match admin_permissions.category values) */
export const PERMISSION_CATEGORIES = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'users', label: 'Users' },
  { key: 'licenses', label: 'Licenses' },
  { key: 'organizations', label: 'Organizations' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'audit', label: 'Audit' },
  { key: 'plans', label: 'Plans' },
  { key: 'billing', label: 'Billing' },
  { key: 'support', label: 'Support' },
  { key: 'pm', label: 'Projects' },
  { key: 'settings', label: 'Settings' },
] as const;
