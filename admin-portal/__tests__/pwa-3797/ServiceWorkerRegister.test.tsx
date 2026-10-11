// @vitest-environment jsdom
/**
 * BACKLOG-3797 — the service worker registers in production only, and is
 * removed again in development.
 *
 * NODE_ENV is set with vi.stubEnv (an assignment) and restored with
 * vi.unstubAllEnvs — never Object.defineProperty, which Windows' process.env
 * proxy does not see (#2890).
 */

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';

const register = vi.fn();
const unregister = vi.fn();
const getRegistrations = vi.fn();

beforeEach(() => {
  register.mockReset().mockResolvedValue({});
  unregister.mockReset().mockResolvedValue(true);
  getRegistrations.mockReset().mockResolvedValue([{ unregister }]);
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register, getRegistrations },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('BACKLOG-3797 ServiceWorkerRegister', () => {
  it('production: registers /sw.js at scope / with updateViaCache none', () => {
    vi.stubEnv('NODE_ENV', 'production');
    render(<ServiceWorkerRegister />);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
    expect(getRegistrations).not.toHaveBeenCalled();
  });

  it('development: never registers, and unregisters any existing worker', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    render(<ServiceWorkerRegister />);
    expect(register).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
