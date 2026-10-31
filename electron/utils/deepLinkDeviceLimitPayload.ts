/**
 * BACKLOG-4046: the payload main sends on the deep-link device-limit event.
 *
 * The return type is annotated, so adding any other field to the literal
 * below is an excess-property type error. The renderer reads only these three
 * (Login.tsx handleDeviceLimit).
 */
import type { DeepLinkDeviceLimitPayload } from "../types/ipc";

export function deviceLimitPayload(
  userId: string,
  licenseStatus: { deviceCount: number; deviceLimit: number },
): DeepLinkDeviceLimitPayload {
  return {
    userId,
    deviceCount: licenseStatus.deviceCount,
    deviceLimit: licenseStatus.deviceLimit,
  };
}
