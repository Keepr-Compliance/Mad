const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize on macOS
  if (electronPlatformName !== 'darwin') {
    return;
  }

  // Skip notarization if CSC_IDENTITY_AUTO_DISCOVERY is false (unsigned builds)
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('Skipping notarization: Building unsigned version (CSC_IDENTITY_AUTO_DISCOVERY=false)');
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  // Check for required environment variables
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  // BACKLOG-3192: this used to warn and return, so a signed build with the
  // credentials missing succeeded and shipped an app Gatekeeper would refuse.
  // A *revoked* credential already threw from notarize() below; only the
  // missing case was silent, which is the case a misconfigured pipeline hits.
  //
  // The throw is unconditional rather than gated on CI: the same hole is open
  // to anyone running `npm run package` locally and shipping the result. The
  // credential-free local paths are `package:dev`, `package:unsigned` and
  // `package:qa:dir`, which all take the early return above.
  if (!appleId || !appleIdPassword || !teamId) {
    throw new Error(
      'Notarization aborted: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID must all be set ' +
        'for a signed build. For a credential-free local build use `npm run package:unsigned` or ' +
        '`npm run package:dev`.'
    );
  }

  console.log(`Notarizing ${appName}...`);

  try {
    await notarize({
      appPath: `${appOutDir}/${appName}.app`,
      appleId: appleId,
      appleIdPassword: appleIdPassword,
      teamId: teamId,
    });

    console.log('Notarization successful!');
  } catch (error) {
    console.error('Notarization failed:', error);
    throw error;
  }
};
