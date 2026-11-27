// Build config for the Mac App Store sandbox check (.github/workflows/mas-sandbox.yml): package.json's "build"
// config with Electron's Mac App Store build (the mas-dev target), left unsigned here. tests/mas/sign-adhoc.sh
// then signs it ad-hoc with the store's sandbox entitlements (installer/entitlements.mas*.plist), so it runs
// sandboxed on a Mac with no Apple certificate, like GitHub's runner.
//   npx electron-builder --mac mas-dev --arm64 --config tests/mas/build-config.js --publish never
const base = require('../../package.json').build;

module.exports = {
  ...base,
  masDev: {
    identity: null, // no signing here: sign-adhoc.sh signs it
    hardenedRuntime: false,
    entitlements: 'installer/entitlements.mas.plist',
    entitlementsInherit: 'installer/entitlements.mas.inherit.plist',
  },
};
