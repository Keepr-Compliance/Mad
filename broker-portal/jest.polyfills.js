/**
 * BACKLOG-4061: jsdom does not provide TextEncoder/TextDecoder. @sentry/nextjs
 * 10.75+ pulls in @sentry/server-utils, which constructs a TextDecoder at module
 * scope, so any suite importing '@sentry/nextjs' failed to load under jsdom.
 * Node and the Next.js runtimes provide both globals; this only fills the test env.
 */
const { TextEncoder, TextDecoder } = require('util');

if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;
