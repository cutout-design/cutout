# Security

## Reporting a problem

If you find a security problem in Cutout, please report it privately: open the repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue for it.

Include what you found, how to reproduce it (a file, a clipboard content or steps), and which version and platform you used. You'll get an answer as soon as possible; a fix ships in the next release, and the release notes say what was fixed.

## What counts

Cutout is a small image editor that works on your own computer. These would be security problems:

- Something you open, paste or drop in (an image, an SVG, a Figma copy) makes Cutout run code, read or write files you didn't choose, or send data anywhere.
- Cutout writes a file anywhere other than where you chose to save it (apart from its own settings and the temporary file for dragging a layer out, which it deletes).
- Cutout connects to anything other than the image links in a pasted Figma copy.

## Supported versions

Only the latest release gets fixes. Updating to it is the way to get them.

## Checking a download

Starting with the next release after 1.3.5, the Windows installers and the app inside them are code-signed (Azure Artifact Signing), and the Mac app is signed with an Apple Developer ID and notarized by Apple, so macOS checks it when it opens.

- Windows (PowerShell): `(Get-AuthenticodeSignature Cutout-1.3.6.exe).Status` should say `Valid`. Or right-click the file, then Properties → Digital Signatures.
- Mac (Terminal): `spctl -a -vv /Applications/Cutout.app` should say `accepted` and `source=Notarized Developer ID`.

From that release on, there are also two ways to check that any download is the file the release workflow built.

**Checksum.** Each release lists the SHA-256 checksum of every file in `SHA256SUMS.txt`. Compute your download's checksum and compare it with the line for that file:

- Windows (PowerShell): `Get-FileHash Cutout-1.3.6.exe`
- Mac (Terminal): `shasum -a 256 Cutout-1.3.6.zip`

**Build provenance.** Each file also comes with a signed record from GitHub that it was built by this repository's release workflow from the release's tag. With the [GitHub CLI](https://cli.github.com/) installed, check a file with:

```bash
gh attestation verify Cutout-1.3.6.exe --repo cutout-design/cutout
```

## How Cutout limits the damage

- The app's window may only run Cutout's own code: a content security policy blocks inline and generated scripts, and allows images only from the app, from what you paste, and over https.
- The desktop app runs its window sandboxed, with no direct access to files; the few native actions it needs (the clipboard, saving to the file you picked in the Save dialog, dragging out a layer) go through a small, fixed bridge (`preload.js`).
- Saving only writes to a location you picked in the Save dialog.
