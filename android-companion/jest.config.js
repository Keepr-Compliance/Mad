/**
 * Jest configuration for the Keepr Android companion (Expo / React Native).
 *
 * BACKLOG-2196: first test harness for android-companion. Uses the `jest-expo`
 * preset (canary matching the pinned Expo 55 SDK). `transformIgnorePatterns`
 * whitelists the RN/Expo packages that ship untranspiled ESM so Babel processes
 * them. Full harness / broader coverage is owned by BACKLOG-2198.
 */
module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))',
  ],
};
