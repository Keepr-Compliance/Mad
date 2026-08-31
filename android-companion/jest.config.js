/**
 * Jest configuration for the Keepr Android companion (Expo / React Native).
 *
 * BACKLOG-2196: first test harness for android-companion. Uses the `jest-expo`
 * preset (canary matching the pinned Expo 55 SDK). `transformIgnorePatterns`
 * whitelists the RN/Expo packages that ship untranspiled ESM so Babel processes
 * them. Full harness / broader coverage is owned by BACKLOG-2198.
 *
 * BACKLOG-2800: `@sentry/react-native` added to the whitelist. It ships ESM
 * (`dist/js/index.js` starts with a bare `export {...}`), and the list did not
 * cover it — `sentry-expo` is a DIFFERENT package. Until now that was invisible,
 * because every suite whose import graph reached Sentry happened to
 * `jest.mock('@sentry/react-native', ...)`, which short-circuits the transform.
 * The moment a widely-imported module (`smsQueueService` -> `syncWindow`) pulled
 * Sentry in, five suites that had no reason to mock it failed to PARSE.
 *
 * Mocking is not a substitute for the transform: it makes the harness depend on
 * every future suite remembering to mock a module it may not know it imports.
 */
module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|@sentry/.*|native-base|react-native-svg))',
  ],
};
