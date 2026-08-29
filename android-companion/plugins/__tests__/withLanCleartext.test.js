/**
 * BACKLOG-2956 — the release APK must permit cleartext HTTP, or the OS refuses
 * every request to the desktop before a socket is opened and local sync is dead.
 *
 * ## What a test can and cannot prove here
 *
 * It CANNOT prove the OS lets the request through — that is an OS network
 * policy, invisible to jest. The authority on that is the built artifact, and
 * `scripts/build-release.sh` step 8 asserts it there
 * (`aapt2 dump xmltree ... | grep -i cleartext`).
 *
 * What it CAN prove is the two ways this silently regresses:
 *   1. the plugin stops setting the attribute;
 *   2. the plugin is correct but **app.json stops registering it** — the shape
 *      this bug class actually lives in, because everything still builds and
 *      the setting simply is not there.
 *
 * ## Fixture provenance
 *
 * `fixtures/AndroidManifest.prebuild.xml` is a byte-for-byte copy of
 * `android/app/src/main/AndroidManifest.xml` as emitted by
 * `npx expo prebuild --platform android --clean` on expo 55.0.30 (sha256
 * b11e84cc06a52ad9f7ec41905412f1396a23dbb3d9243c6a702f909e24d3d408). It is not
 * hand-written: `android/` is gitignored, so the real producer's output is
 * checked in here instead. `describes a pre-fix manifest` below asserts the
 * fixture really lacks the attribute, so a green result from the mutation test
 * cannot come from a fixture that was already fixed.
 */

const path = require('path');
const { AndroidConfig } = require('@expo/config-plugins');

const withLanCleartext = require('../withLanCleartext');
const { CLEARTEXT_ATTRIBUTE } = withLanCleartext;
const appJson = require('../../app.json');

const FIXTURE = path.join(__dirname, 'fixtures', 'AndroidManifest.prebuild.xml');

/** app.json's registration entry for this plugin. */
const PLUGIN_ENTRY = './plugins/withLanCleartext';

/** Read the real prebuild manifest exactly as prebuild's own mod would. */
const readFixture = () => AndroidConfig.Manifest.readAndroidManifestAsync(FIXTURE);

/**
 * Run the plugin's android-manifest mod over a parsed manifest, the way
 * `compileModsAsync` does during prebuild.
 */
async function applyPlugin(plugin, manifest) {
  const config = plugin({ name: 'Keepr Companion', slug: 'keepr-companion' });
  const mod = config.mods.android.manifest;
  const result = await mod({ ...config, modResults: manifest, modRequest: {} });
  return result.modResults;
}

const cleartextAttr = (manifest) =>
  manifest.manifest.application[0].$[CLEARTEXT_ATTRIBUTE];

describe('withLanCleartext (BACKLOG-2956)', () => {
  it('the fixture describes a PRE-FIX manifest — prebuild alone permits no cleartext', async () => {
    // Guards the mutation test below: if the fixture already carried the
    // attribute, "the plugin sets it" would pass without the plugin doing
    // anything.
    const manifest = await readFixture();
    expect(cleartextAttr(manifest)).toBeUndefined();
  });

  it('sets android:usesCleartextTraffic="true" on the main application', async () => {
    const manifest = await applyPlugin(withLanCleartext, await readFixture());
    expect(cleartextAttr(manifest)).toBe('true');
  });

  it('leaves the rest of the generated manifest untouched', async () => {
    const before = await readFixture();
    const after = await applyPlugin(withLanCleartext, await readFixture());

    // The INTERNET permission is what makes networking possible at all; a
    // plugin that dropped it would break sync just as completely.
    const names = (m) =>
      m.manifest['uses-permission'].map((p) => p.$['android:name']).sort();
    expect(names(after)).toEqual(names(before));

    const appAttrs = (m) => {
      const { [CLEARTEXT_ATTRIBUTE]: _cleartext, ...rest } =
        m.manifest.application[0].$;
      return rest;
    };
    expect(appAttrs(after)).toEqual(appAttrs(before));
  });

  it('app.json REGISTERS the plugin — a correct plugin nobody runs is the real failure mode', () => {
    // This is the assertion that would have caught the shipped bug. Removing
    // the entry from app.json leaves the plugin file perfectly correct, the
    // build perfectly green, and the setting absent from the APK.
    expect(appJson.expo.plugins).toContain(PLUGIN_ENTRY);
  });

  it('the registered entry resolves to THIS plugin', () => {
    // Registration by string is only as good as the path. A typo'd entry makes
    // prebuild fail loudly, but a stale/renamed one that resolves elsewhere
    // would not.
    const resolved = require(path.join(__dirname, '..', '..', PLUGIN_ENTRY));
    expect(resolved).toBe(withLanCleartext);
  });
});
