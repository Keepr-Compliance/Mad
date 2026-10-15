# Dependency manifest for the vendored @noble bundle (BACKLOG-3762)

`chrome-extension/vendor/noble-p256.js` is a local bundle of
`@noble/curves 1.9.7` and `@noble/hashes 1.8.0` (see
`chrome-extension/vendor/README.md` and `SBOM.json`). A bundle is invisible to
GitHub's dependency graph, so Dependabot alerts would never name these
versions.

This folder declares the same two versions so the dependency graph and
Dependabot see them. Nothing here is installed, built or shipped:

- it is outside `chrome-extension/`, so neither the Chrome Web Store zip
  (`scripts/package-extension.mjs`) nor the desktop app (`extraResources`)
  contains it;
- it is not an npm workspace of the root package, so the root
  `package-lock.json` does not include it.

`tests/chrome-extension/vendorManifest-3762.test.ts` fails if the versions
here (manifest or lockfile) differ from `chrome-extension/vendor/SBOM.json`.
Upgrading the bundle means rebuilding `noble-p256.js`, updating the SBOM, and
updating this manifest in the same change.

Regenerate the lockfile without touching any shared `node_modules`:

    cp package.json "$TMP/x/" && npm --prefix "$TMP/x" install --package-lock-only --ignore-scripts
    cp "$TMP/x/package-lock.json" .
