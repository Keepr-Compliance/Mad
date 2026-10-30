/**
 * jsdom test environment that pins the process time zone per jest project
 * (BACKLOG-4032 slice 3, SR R2). `process.env.TZ` set inside a test does not
 * move the offset; set here, before the test file loads, it does.
 *
 * The zone comes from the project's `testEnvironmentOptions.tz`. Tests must
 * check the offset itself (`new Date(2026, 9, 1).getTimezoneOffset()`), never
 * read `process.env.TZ` back.
 */
const mod = require('jest-environment-jsdom');
const JsdomEnvironment = mod.TestEnvironment || mod.default || mod;

class TzJsdomEnvironment extends JsdomEnvironment {
  constructor(config, context) {
    const tz = config.projectConfig.testEnvironmentOptions && config.projectConfig.testEnvironmentOptions.tz;
    if (tz) process.env.TZ = tz;
    super(config, context);
    // Read back by the vacuity guard in date-range-picker.test.tsx.
    this.global.__KIT_TZ__ = tz;
  }
}

module.exports = TzJsdomEnvironment;
