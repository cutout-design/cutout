// Release config for the signed, notarized Mac build. It is package.json's "build" config plus
// Developer ID signing, hardened runtime and notarization. The release workflow uses it only when
// the Apple secrets are set; local builds and pull requests keep using package.json (ad-hoc signed),
// so they build without a certificate.
//   npx electron-builder --mac --arm64 --config electron-builder.signed.js
// Secrets it reads (environment, never files in the repo):
//   CSC_LINK, CSC_KEY_PASSWORD          the Developer ID Application certificate (.p12, base64) and its password
//   APPLE_TEAM_ID                       picks that certificate (the signer's name stays out of the repo)
//   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER   App Store Connect API key for notarization
const base = require('./package.json').build;

if (!process.env.APPLE_TEAM_ID) throw new Error('APPLE_TEAM_ID is not set');

module.exports = {
  ...base,
  mac: {
    ...base.mac,
    identity: process.env.APPLE_TEAM_ID, // matched against "Developer ID Application: <name> (<team ID>)"
    hardenedRuntime: true, // required for notarization
    entitlements: 'installer/entitlements.signed.plist',
    entitlementsInherit: 'installer/entitlements.signed.plist', // Electron's helper processes
    notarize: true, // electron-builder 26: uses APPLE_API_KEY / _ID / _ISSUER, then staples the ticket
  },
  dmg: { ...base.dmg, sign: true }, // the disk image is signed too; the release workflow notarizes and staples it
  forceCodeSigning: true, // fail the build instead of quietly shipping an unsigned app
};
