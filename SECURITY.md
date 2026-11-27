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

## How Cutout limits the damage

- The app's window may only run Cutout's own code: a content security policy blocks inline and generated scripts, and allows images only from the app, from what you paste, and over https.
- The desktop app runs its window sandboxed, with no direct access to files; the few native actions it needs (the clipboard, saving to the file you picked in the Save dialog, dragging out a layer) go through a small, fixed bridge (`preload.js`).
- Saving only writes to a location you picked in the Save dialog.
