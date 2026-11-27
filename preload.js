'use strict';
// Bridge between the page (cutout/app.js → Platform) and main.js. Only these calls are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cutoutNative', {
  /** → { png: Uint8Array } or { text, html } */
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  /** Native Save dialog. → chosen path, or null */
  saveDialog: suggestedName => ipcRenderer.invoke('file:save-dialog', suggestedName),
  /** Writes bytes to a path chosen in saveDialog. */
  writeFile: (path, bytes) => ipcRenderer.invoke('file:write', path, bytes),
  /** 'system' | 'light' | 'dark': the native title bar follows it. */
  setTheme: pref => ipcRenderer.send('theme:set', pref),
  /** Files the app was launched with. → [{ name, type, data: Uint8Array }] */
  getStartupFiles: () => ipcRenderer.invoke('files:startup'),
  /** Files from Open with / a second launch while running. */
  onOpenFiles: cb => { ipcRenderer.on('files:open', (_e, list) => cb(list)); },
  /** Mac menu bar: 'undo' | 'redo' | 'selectAll' picked from the Edit menu. */
  onMenuCommand: cb => { ipcRenderer.on('menu:command', (_e, cmd) => cb(cmd)); },
  /** The app's version (About dialog). → '1.1.0' */
  getVersion: () => ipcRenderer.invoke('app:version'),
  /** Updates from GitHub Releases. → true in the installed app */
  updateSupported: () => ipcRenderer.invoke('update:supported'),
  /** Check for Updates  → { status: 'available', version, current } | { status: 'ready', version }
   *  | { status: 'current' } | { status: 'error' } */
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  /** The daily check found a version to offer: cb({ status: 'available', version, current }). */
  onUpdate: cb => { ipcRenderer.on('update:available', (_e, info) => cb(info)); },
  /** Download Update. → { status: 'ready', version } | { status: 'move' } (Mac, not in Applications) | { status: 'error' } */
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  /** While downloading: cb(percent). */
  onUpdateProgress: cb => { ipcRenderer.on('update:progress', (_e, pct) => cb(pct)); },
  /** Skip This Version (the one last offered). */
  skipUpdate: () => ipcRenderer.send('update:skip'),
  /** Restart to Update: closes the window (asking about unsaved changes), installs, starts again. */
  restartToUpdate: () => ipcRenderer.send('update:restart'),
  /** Starts an OS drag of a PNG file. Call from dragstart (after preventDefault). */
  startDrag: (name, bytes) => ipcRenderer.send('drag:start', name, bytes),
});
