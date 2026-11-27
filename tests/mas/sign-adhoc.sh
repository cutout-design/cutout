#!/bin/bash
# Signs the unsigned Mac App Store build (tests/mas/build-config.js) ad-hoc with the store's sandbox
# entitlements, for the sandbox check. The real store build is signed by electron-builder with the Apple
# Distribution certificate instead; this one only has to run sandboxed on a Mac without certificates.
#   bash tests/mas/sign-adhoc.sh dist/mas-dev-arm64/Cutout.app
# On top of installer/entitlements.mas.plist, the app gets:
#   - an app group: Electron's Mac App Store build names its shared memory after it. A real build gets
#     TEAMID.app.cutout from the certificate; TEST stands in for the team ID here.
#   - network.server (this check only, never the store build): the DevTools port the check drives the app with.
set -euo pipefail
app="$1"
root="$(cd "$(dirname "$0")/../.." && pwd)"
team=TEST
tmp="$(mktemp -d)"

cp "$root/installer/entitlements.mas.plist" "$tmp/app.plist"
/usr/libexec/PlistBuddy \
  -c "Add :com.apple.security.application-groups array" \
  -c "Add :com.apple.security.application-groups:0 string $team.app.cutout" \
  -c "Add :com.apple.security.network.server bool true" "$tmp/app.plist"
plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :ElectronTeamID $team" "$plist" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Add :ElectronTeamID string $team" "$plist"

inherit="$root/installer/entitlements.mas.inherit.plist"
# Inside out: frameworks and libraries, the helper apps (they inherit the sandbox), the login helper, then the app.
for f in "$app"/Contents/Frameworks/*; do
  case "$f" in
    *.app) codesign --force --deep --sign - --entitlements "$inherit" "$f" ;;
    *) codesign --force --deep --sign - "$f" ;;
  esac
done
# Electron's Mac App Store build also carries a login helper (Cutout never starts it): its own sandbox, no inherit.
/usr/libexec/PlistBuddy -c "Add :com.apple.security.app-sandbox bool true" "$tmp/helper.plist" >/dev/null
for h in "$app"/Contents/Library/LoginItems/*.app; do
  [ -e "$h" ] && codesign --force --deep --sign - --entitlements "$tmp/helper.plist" "$h"
done
codesign --force --sign - --entitlements "$tmp/app.plist" "$app"
codesign --verify --deep --strict "$app"
echo "Signed ad-hoc. Entitlements of the app:"
codesign -d --entitlements - --xml "$app" | plutil -p -
