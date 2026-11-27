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
  /** Starts an OS drag of a PNG file. Call from dragstart (after preventDefault). */
  startDrag: (name, bytes) => ipcRenderer.send('drag:start', name, bytes),
});
