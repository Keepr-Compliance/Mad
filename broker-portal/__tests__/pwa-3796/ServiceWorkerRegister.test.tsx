/**
 * BACKLOG-3796 — the service worker registers in production only, and is
 * removed again in development.
 */

import { render } from '@testing-library/react';
import React from 'react';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';

const register = jest.fn();
const unregister = jest.fn();
const getRegistrations = jest.fn();

// Assign, never defineProperty: on Windows jest's process.env is a Proxy whose
// reads only see values set by assignment. replaceProperty assigns and is
// restored automatically after each test (restoreMocks / explicit restore).
function setEnv(value: 'production' | 'development') {
  jest.replaceProperty(process.env, 'NODE_ENV', value);
}

beforeEach(() => {
  register.mockReset().mockResolvedValue({});
  unregister.mockReset().mockResolvedValue(true);
  getRegistrations.mockReset().mockResolvedValue([{ unregister }]);
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register, getRegistrations },
    configurable: true,
  });
});

afterEach(() => jest.restoreAllMocks());

describe('BACKLOG-3796 ServiceWorkerRegister', () => {
  it('production: registers /sw.js at scope / with updateViaCache none', () => {
    setEnv('production');
    render(<ServiceWorkerRegister />);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
    expect(getRegistrations).not.toHaveBeenCalled();
  });

  it('development: never registers, and unregisters any existing worker', async () => {
    setEnv('development');
    render(<ServiceWorkerRegister />);
    expect(register).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
