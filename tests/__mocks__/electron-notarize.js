/**
 * Jest mock for @electron/notarize (BACKLOG-3192).
 *
 * The only consumer of the real package is scripts/notarize.js, the
 * electron-builder afterSign hook. Its unit test must never contact Apple, and
 * the repo's `^@electron/(.*)` path alias makes the real package unresolvable
 * under jest anyway — see the mapper entry in jest.config.js.
 *
 * Resolves by default so a "credentials present" case succeeds without setup.
 * Tests that need a rejection call `notarize.mockRejectedValue(...)`.
 */

module.exports = {
  notarize: jest.fn(() => Promise.resolve()),
};
