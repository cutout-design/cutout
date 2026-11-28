// Config for the Mac App Store build: package.json's "build" config plus Electron's Mac App Store build
// (sandboxed, installer package for upload). Used only by .github/workflows/mas.yml; local builds and the
// zip release don't touch it.
//   npx electron-builder --mac mas --arm64 --config electron-builder.mas.js
// Reads (environment, never files in the repo):
//   CSC_LINK, CSC_KEY_PASSWORD   one .p12 (base64) holding both "Apple Distribution" and "Mac Installer
//                                Distribution" certificates, and its password
//   APPLE_TEAM_ID                picks those certificates (the holder's name stays out of the repo)
//   MAS_PROVISIONING_PROFILE     path to the Mac App Store provisioning profile for app.cutout
// The sandbox entitlements (installer/entitlements.mas*.plist) are the ones the sandbox check tests
// (tests/mas/). electron-builder adds the app group (TEAMID.app.cutout) and ElectronTeamID itself.
const base = require('./package.json').build;

for (const v of ['APPLE_TEAM_ID', 'MAS_PROVISIONING_PROFILE']) {
  if (!process.env[v]) throw new Error(`${v} is not set`);
}

module.exports = {
  ...base,
  mas: {
    type: 'distribution',
    identity: process.env.APPLE_TEAM_ID, // matched against "Apple Distribution: <name> (<team ID>)"
    hardenedRuntime: false, // the sandbox replaces it in the store
    entitlements: 'installer/entitlements.mas.plist',
    entitlementsInherit: 'installer/entitlements.mas.inherit.plist',
    provisioningProfile: process.env.MAS_PROVISIONING_PROFILE,
    minimumSystemVersion: '12.0',
    artifactName: 'Cutout-${version}-mas.${ext}',
    extendInfo: {
      ITSAppUsesNonExemptEncryption: false, // HTTPS only: App Store Connect then skips the export question
    },
  },
  forceCodeSigning: true, // fail instead of uploading an unsigned build
};
