# Contributing to Cutout

Thanks for helping. Bug reports and ideas are welcome as issues. Pull requests are welcome too, once we've agreed in an issue that the change fits, so nobody spends time on something that won't be merged.

## Reporting a bug

Open an issue and include:

- The Cutout version (About Cutout, in the Cutout menu; on a Mac, in the menu bar) and whether you use Windows, Mac or the web version (which browser).
- What you did, what you expected, and what happened instead.
- If an image or a Figma copy triggers it, a made-up one that shows the problem. **Please don't attach private or confidential images**: issues are public.

Security problems are the exception: report them privately, as [SECURITY.md](SECURITY.md) explains.

## Suggesting an idea

Open an issue that describes the problem you ran into, not just the feature you'd like. That makes it easier to find the simplest fix.

Cutout is deliberately small: a scratchpad for quick bitmap fixes next to a design tool, not a full image editor. So some things are out of scope on purpose:

- Project files or a document format of its own. You paste, fix, and copy or save the result.
- Photoshop-style complexity: adjustment layers, masks, brushes, filters.

Behavior follows Figma where it makes sense (shortcuts, alignment, snapping), and older bitmap tools such as Fireworks for pixel editing.

## Sending a pull request

Once an issue says the change is welcome:

1. Fork the repository and make your change on a branch.
2. Run Cutout from source with `npm install` and `npm start` (see [Build from source](README.md#build-from-source)).
3. Add a check to the tests in `tests/` that would have caught the bug, or that covers the new behavior, and make sure `npm test` passes.
4. Update the [user guide](docs/user-guide.md) when behavior or shortcuts change, and add a line to [CHANGELOG.md](CHANGELOG.md) under "Unreleased" (create the section if there isn't one).
5. Keep it focused: one fix or feature per pull request, and link the issue.

A few conventions:

- **Code**: the app is plain HTML, CSS and JavaScript in `cutout/`, with no build step and no packages in the app itself (just two small libraries, kept in `cutout/vendor/`). It runs under a strict content security policy: no inline scripts or styles, no `eval`.
- **Wording in the app**: short and plain, no em dashes, no filler ("No image on the clipboard", "Selection is empty"). Tooltips are the name plus the shortcut.
- **Shortcuts**: write them Windows-style (`Ctrl+Shift+S`, `Alt+A`); the app shows ⌘ and ⌥ on a Mac by itself.
- **Privacy**: commits and files must not contain personal details, such as your local paths, user name, employer, or private images. Tests use made-up images only.

## License

Cutout is under the [MIT license](LICENSE). By sending a pull request, you agree that your contribution is released under the same license.
