// Learn more: https://docs.expo.dev/guides/customizing-metro/
//
// BACKLOG-2222: wrap Expo's default Metro config with Sentry's
// `getSentryExpoConfig` so every JS bundle AND its source map are stamped with a
// matching Debug ID. That Debug ID is what lets Sentry pair a minified
// production stack trace with the source map uploaded by scripts/build-apk.sh,
// so crashes symbolicate. `getSentryExpoConfig` calls Expo's own
// `getDefaultConfig` internally, so this is a drop-in replacement — there was no
// prior metro.config.js (default config was used), and this preserves it.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

module.exports = config;
