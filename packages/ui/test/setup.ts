/**
 * jsdom test setup for @keepr/ui.
 *
 * jsdom lacks several browser APIs that Radix primitives touch. We polyfill the
 * minimum needed for Dialog/AlertDialog/Checkbox/Select to render and for
 * @testing-library/jest-dom matchers to work. Kept idempotent so the file is
 * safe under any runner.
 */
import '@testing-library/jest-dom';

// matchMedia — read by react-remove-scroll / Radix presence.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// ResizeObserver — used by react-remove-scroll and Radix positioning.
if (!('ResizeObserver' in window)) {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserver;
}

// Pointer capture — Radix Select/Dialog call these; jsdom does not implement them.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

// scrollIntoView — Radix Select throws without it.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
