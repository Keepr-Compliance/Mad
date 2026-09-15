/**
 * STAND-IN for the hide-from-export entitlement check — BACKLOG-3366.
 *
 * The real check is built by BACKLOG-3365 on top of BACKLOG-3349's shared
 * checker, neither of which exists yet. Until it does, hiding is REFUSED:
 * this module returns false, so `transactions:hide-text-from-export` rejects
 * every request and nothing can be hidden. Unhiding never consults it.
 *
 * BACKLOG-3365 deletes this module and repoints its single import (in
 * `hiddenTextHandlers.ts`) at the real fail-closed check. There is deliberately
 * no override, flag or setting that makes this return true: tests that need the
 * allowed path mock this module.
 */
export function isHideFromExportAllowed(): Promise<boolean> {
  return Promise.resolve(false);
}
