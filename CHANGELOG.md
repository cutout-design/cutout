# Changelog

What's new in each version of Cutout. The section for a version becomes its release notes on GitHub.

## 2.0.0 (2026-11-27)

Cutout 2.0 is signed on Windows and Mac and keeps itself up to date.

- Automatic updates in the desktop app: once a day Cutout checks GitHub for a new version and offers Download Update, Later or Skip This Version; the update downloads in the background and installs with Restart to Update, or when you quit. Check for Updates is in the Cutout menu (on a Mac, the Cutout menu in the menu bar). The check sends nothing about you: no version, no ID, no language, no cookies. Updating from this version on is automatic; to get here, install it once by hand. On a Mac, Cutout offers to move itself to the Applications folder when opened from elsewhere, since it can only update itself there.
- About Cutout links to the User Guide and Cutout's privacy policy. On the Mac app, the menu bar has a new Help menu with User Guide and Privacy Policy.
- Dragging a marquee, moving layers or dragging a selection box to the edge of the canvas scrolls the view, as in Fireworks and Figma. It speeds up as you go past the edge (full speed 40 px past it, on every side), and the selection keeps growing while you hold the pointer still.
- Windows: the installers and the app are code-signed, so Windows shows who published them.
- Mac: the app is signed and notarized by Apple, so it opens after the usual "downloaded from the Internet" question, without a trip to Privacy & Security.
- Pasting SVG markup (Figma's Copy as SVG) is safer: Cutout reads the size straight from the SVG and lets the browser draw it as an image, without loading the markup as a document. SVG that declares entities is refused, and text made to look like many comments before an SVG can no longer freeze the window.
- Each release now lists SHA-256 checksums of its files, and each file comes with build provenance, a signed record that it was built from this repository. SECURITY.md explains how to check a download.
- New blue: buttons, menus and the app icon use a deeper blue (#0073E7) so white text on it is easy to read; in dark mode, outlines, focus rings and checkmarks use a lighter blue that stands out on the dark panels.
- Screen readers: the canvas is the window's main region and the options bar is its own region, so both can be jumped to; every field has a spoken name (marquee width and height, fill choices, eraser size, the Canvas size background color). Nothing changes on screen.

## 1.3.5 (2026-11-26)

- The trash button at the top of the Layers panel is gone: it deleted only the selected layers but looked like Delete all. Delete layers with the Delete key or the right-click menu, as in Figma.
- Web version: on a phone or tablet, Cutout says it needs a computer with a mouse and keyboard.

## 1.3.4 (2026-11-26)

- Cutout is now free and open source under the MIT license.
- Mac: a new app icon in the macOS 26 style, so it shows at full size instead of shrunk onto a gray tile.
- Keyboard and screen reader support: Tab reaches every button, field and layer row with a visible focus ring; menus work with the arrow keys, Enter and Esc; Control+Return (or the Menu key or Shift+F10 on Windows) opens the canvas's right-click menu; screen readers hear control names, states and Cutout's messages. Mouse use is unchanged.
- With reduced motion turned on in the system, the marching ants stand still and the panels don't animate.
- Pasting from Figma: a layer filled with extremely small image tiles no longer freezes the window; Cutout asks for Copy as PNG instead.
- The web version has been lightly tested in Firefox and in WebKit, the engine behind Safari. Save downloads the file there, and the eyedropper opens the color picker.
- Pasting from Figma in a browser that can't draw blur: layers with a layer or background blur are refused (with the usual Copy as PNG hint) instead of pasting sharp.
- Updated to Electron 45.5.0 (Chromium 156 with its latest security fixes).

## 1.3.3 (2026-11-12)

- New (Ctrl+N, desktop app): starts an empty document. Undo brings the previous one back.
- Undo and Redo put the view back when the step changed the artboard's size (New, Trim, Canvas size, the first paste), so the artboard is where it was instead of off-center.
- Esc while dragging cancels the drag: the layer, scale, spacing, artboard edge or eraser stroke goes back to how it was.
- A second Smart fill while one is running says "Still filling…".
- Clicking another layer on the canvas clears the pixel selection, so a selection is no longer left behind on a layer you're not working on. Picking a layer in the Layers panel still keeps it (as in Fireworks).
- A piece cut or copied to its own layer and left in place no longer shows a thin line along its edge at some zoom levels.
- After starting over with a new image (everything deleted, then a paste or an opened file), Save asks where to save instead of silently overwriting the file the previous image was saved to.
- Shortcuts wait while you're dragging (moving, scaling, erasing): an undo in the middle of a drag could leave a change that couldn't be undone. A drag also ends properly if the mouse button is released while another app has taken over.
- Pasting from Figma releases the downloaded images as soon as the paste is drawn (less memory on boards with many photos).
- Delete, Fill, Smart fill, Copy or Cut to new layer, Straighten and Clear corners no longer change a hidden layer; they say "The layer is hidden".
- Safer by design: the app now has a content security policy, so only Cutout's own code can run in its window, and pasted content can never run code. Figma copies are decoded without generating code.
- Undo memory: the original pixels kept for scaled layers now count toward the undo limit.
- Cut puts the layers or pixels back if the clipboard didn't take the image, and says so.
- Image files that arrive without a file type (some drags and network folders) open by their file name.
- Fit to layers says so when the artboard already fits, and changing only the background in Canvas size keeps the view where it is.

## 1.3.2 (2026-11-11)

- Shrink to content with no selection on a scan with the card in the scanner's corner no longer stretches to the far edge (the scanner's line along the edge is ignored up to the corner).
- Shrink to content no longer cuts into a card whose corner touches the scanner's dark edge.
- Clear corners leaves corners alone where a card ran off the edge of the scan (no outline, or the outline runs straight into the edge), and measures the radius from the rounded corners only. A bit of scanner edge in a corner no longer throws off the radius.

## 1.3.1 (2026-11-11)

- Shift+Backspace with no pixel selection no longer deletes the selected layer; it says to make a selection first.
- A Smart fill right after launch could fail; it now always works.
- Cut says "Copied" when nothing was cut (for example when the selection is over a different layer than the selected one).
- Less memory: pixels kept for repeat wand clicks are let go once their layer changes, and files from dragging layers out are cleaned up as you go instead of when Cutout closes.

## 1.3.0 (2026-11-11)

- Straighten (right-click a selection or a layer): levels a slightly crooked scan, up to 10°, by the tilt of the object on it. A selection made by Shrink to content is re-fitted to the leveled object.
- Clear corners (right-click a selection or a layer): makes the paper in a card's rounded corners transparent, also after Straighten and cropping to the card. Only the paper outside the corner's curve is cleared, never the card.
- Shrink to content works without a selection too (right-click the layer): it finds the object on the whole artboard and selects it.
- Trim to selection (right-click a selection, or More) replaces Crop artboard to selection: the artboard becomes the selection and everything outside is cut off, so nothing hidden comes back on copy or drag-out.
- Trim and Trim to selection re-fit the view to the new artboard.
- With a pixel selection, right-click anywhere on the canvas shows the selection menu, not only inside the selection (as in Fireworks).

## 1.2.0 (2026-11-11)

- Smart fill: select something and press Shift+Backspace to remove it. Cutout fills the selection with pixels from around it, so flat backgrounds, gradients, textures and UI blocks like cards and the gaps between them continue through. No AI, nothing leaves your computer. Fill now has a menu: Color or Smart. The Paint bucket has the same menu with its own setting, starting on Color.
- Shrink to content (right-click a selection, or More): draw a loose marquee around something on a plain background and the selection snaps to it. Made for scans: uneven paper, the scanner's dark edges and dust specks are ignored.
- Selections stay inside the artboard, as in Fireworks: a marquee dragged past an edge stops at it, and the magic wand, grow and invert stay inside too. Fill with color no longer adds pixels outside the artboard.

## 1.1.4 (2026-11-10)

- An image opened from Finder or Explorer stays centered while the window settles. A view you haven't zoomed or moved re-centers when the window changes size.

## 1.1.3 (2026-11-10)

- Figma paste draws drop shadows on groups (they were left out).
- Figma paste no longer refuses some Light/Dark copies whose values were already right.
- Duplicating a resized layer keeps Original size.
- Cut (Ctrl+X) on layers no longer deletes hidden layers that weren't part of the copy.
- Clicking layers no longer builds up memory over time.
- Repeat magic wand clicks on a large image are faster.
- Browser version: dragging a large layer out starts sooner.

## 1.1.2 (2026-11-10)

- Figma paste: text with several colors set by variables now follows Light/Dark modes too.
- Figma paste uses much less memory on large boards, so big FigJam boards no longer risk freezing.
- Pasted Figma images respond faster to hovering, the magic wand and color picking.
- A stalled image download gives up after 20 seconds instead of waiting forever.
- Mac: opening an image from Finder while Cutout has no window open now opens a window with it.

## 1.1.1 (2026-11-10)

- About Cutout in the Cutout menu shows the version (Windows and the browser; on the Mac it's in the menu bar).

## 1.1.0 (2026-11-10)

- Paste a normal Figma copy: select layers in Figma, press Ctrl+C, and press Ctrl+V in Cutout. They paste as one image at 1×, drawn by Cutout itself. Copies with images need an internet connection. Shapes, rounded and smooth corners, booleans, gradients, pattern fills, images and GIFs, text and text on a path, line-end arrows, shadows, blurs, blend modes, masks, components (with properties and slots), variables (including modes such as Light/Dark) and FigJam boards (stickies, shapes, connectors, sections, tables, code blocks, marker and highlighter, stamps, stickers and widgets) are drawn exactly. Anything it can't draw exactly (emoji, brushes, noise, texture and glass effects, progressive blur, most image adjustments, and newer Figma features) is refused, and Cutout asks you to use Copy as PNG instead.
- Copy as SVG now pastes at 1×.
- Removed the "Paste images at: Half size" setting and Paste at half size (Ctrl+Shift+V): Figma copies now paste at 1× directly.

## 1.0.0 (2026-11-08)

Initial release.

- Desktop app for Windows (x64 and ARM64) and Mac (Apple Silicon), plus the web version.
- Paste from Figma (Copy as PNG and Copy as SVG), with lossless half-size pasting for Figma's 2× copies; open files, drag them in, or use Open with.
- Magic wand with live tolerance and edge cleanup for cutting out backgrounds; marquee with free, aspect ratio and exact size shapes; add, subtract, invert, and grow or shrink one side by 1 px.
- Copy or cut a selection to a new layer, delete, fill, save it, or crop the artboard to it.
- Paint bucket, eraser, and a fill color picked from anywhere on screen.
- Layers: move, duplicate, rename, reorder, hide, flip, rotate, and drag out as a PNG file.
- Lossless scaling with handles and W/H fields, and Original size.
- Figma-style align, distribute, smart guides, equal-spacing snapping and spacing handles.
- Artboard: canvas size, image size, trim, fit, background color or transparent.
- Copy as PNG to the clipboard; save as PNG or JPEG.
- Math in number fields, light and dark themes, Mac shortcuts and menu bar.
