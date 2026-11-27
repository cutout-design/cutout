'use strict';
// Starts Cutout for the tests: a throwaway settings folder (so a test run never touches your own
// preferences, and runs alongside an open Cutout), and a Save dialog that answers by itself with a
// file in that folder. Then hands over to the real main.js.
const { app, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutout-test-'));
app.setPath('userData', dir);
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(dir, 'out.png') });
app.on('will-quit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* in use */ } });
require('../main.js');
