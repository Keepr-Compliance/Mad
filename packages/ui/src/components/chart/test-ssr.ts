/**
 * Test helper: react-dom/server under jsdom. jsdom lacks TextEncoder, which
 * react-dom/server needs at load time, so it is set before the require (an
 * import would be hoisted above the assignment). Same fix as
 * report/use-report-url-state.test.tsx.
 */
import { TextEncoder } from 'util';
import type { ReactElement } from 'react';

(globalThis as unknown as { TextEncoder: unknown }).TextEncoder ??= TextEncoder;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('react-dom/server') as typeof import('react-dom/server');

export function renderToStaticMarkup(element: ReactElement): string {
  return server.renderToStaticMarkup(element);
}
